/**
 * The client of a connection with BOTH credentials: the API key (UniFi OS Integration API) serves
 * everything it already did — device ids, listings, restart, port power-cycle — and the local
 * account (classic Network API) adds what the Integration API cannot do: switch a port's PoE on
 * and off, report the PoE mode / power and the wired client on each port.
 *
 * The two APIs name a device differently (Integration `id` vs classic `_id`); they meet on the
 * device MAC. The local account is secondary: when it fails, the API-key half keeps working, the
 * failure is reported by {@link UnifiDualClient.degradedError}, and a refused sign-in (bad
 * password, two-factor account) is NOT retried on every poll — only when the operator switches a
 * port — so a wrong password never hammers the console's sign-in.
 */
import type {
  UnifiClientSnapshot,
  UnifiControllerClient,
  UnifiInfraPort,
  UnifiInfraSnapshot,
} from './unifi-client-contract.js'
import type { UnifiClassicClient } from './unifi-client-classic.js'
import type { UnifiLiveClient } from './unifi-client-live.js'
import { UnifiApiError, UnifiAuthError, UnifiMfaRequiredError } from './unifi-errors.js'

export interface UnifiDualClientOptions {
  readonly integration: UnifiLiveClient
  readonly classic: UnifiClassicClient
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/** A refusal of the credential itself: retrying it on a timer only locks the account. */
function isRefusal(err: Error): boolean {
  return err instanceof UnifiAuthError || err instanceof UnifiMfaRequiredError
}

/** The classic port reading laid over the Integration API's port of the same index. */
function overlayPorts(
  base: readonly UnifiInfraPort[],
  classic: readonly UnifiInfraPort[],
): UnifiInfraPort[] {
  const byIdx = new Map(classic.map((p) => [p.idx, p]))
  const merged = base.map((p) => {
    const c = byIdx.get(p.idx)
    return c === undefined ? p : { ...c, poeCapable: p.poeCapable || c.poeCapable }
  })
  const known = new Set(base.map((p) => p.idx))
  return [...merged, ...classic.filter((c) => !known.has(c.idx))]
}

export class UnifiDualClient implements UnifiControllerClient {
  readonly #integration: UnifiLiveClient
  readonly #classic: UnifiClassicClient
  #degraded: Error | null = null
  #infra = new Map<string, UnifiInfraSnapshot>()

  constructor(options: UnifiDualClientOptions) {
    this.#integration = options.integration
    this.#classic = options.classic
  }

  async connect(): Promise<void> {
    await this.#integration.connect()
    await this.#connectClassic()
  }

  async disconnect(): Promise<void> {
    this.#infra = new Map()
    await this.#integration.disconnect()
    await this.#classic.disconnect().catch((): null => null)
  }

  async listInfraDevices(): Promise<readonly UnifiInfraSnapshot[]> {
    const base = await this.#integration.listInfraDevices()
    const classic = await this.#classicListing()
    const snapshots = base.map((device): UnifiInfraSnapshot => {
      const match = device.mac === null ? undefined : classic.find((c) => c.mac === device.mac)
      return {
        ...device,
        poeSwitchable: true,
        ...(match !== undefined
          ? {
              ports: overlayPorts(device.ports, match.ports),
              cpuTempC: device.cpuTempC ?? match.cpuTempC,
              ledOn: match.ledOn,
            }
          : {}),
      }
    })
    this.#infra = new Map(snapshots.map((s) => [s.id, s]))
    return snapshots
  }

  async listClients(): Promise<readonly UnifiClientSnapshot[]> {
    return this.#integration.listClients()
  }

  getInfraDevice(id: string): UnifiInfraSnapshot | null {
    return this.#infra.get(id) ?? null
  }

  getClient(mac: string): UnifiClientSnapshot | null {
    return this.#integration.getClient(mac)
  }

  /** Through the local account: the Integration API cannot switch PoE. */
  async setPortPoe(deviceId: string, portIdx: number, on: boolean): Promise<void> {
    await this.#classic.setPortPoe(await this.#classicId(deviceId), portIdx, on)
  }

  async restartDevice(deviceId: string): Promise<void> {
    await this.#integration.restartDevice(deviceId)
  }

  async powerCyclePort(deviceId: string, portIdx: number): Promise<void> {
    await this.#integration.powerCyclePort(deviceId, portIdx)
  }

  /** Through the local account: the Integration API cannot set the LED. */
  async setLed(deviceId: string, on: boolean): Promise<void> {
    await this.#classic.setLed(await this.#classicId(deviceId), on)
  }

  degradedError(): Error | null {
    return this.#degraded
  }

  /**
   * The classic `_id` of an Integration API device, matched by MAC. An operator command is the one
   * place a refused local account signs in again (never a timer).
   */
  async #classicId(deviceId: string): Promise<string> {
    if (!this.#classic.connected) {
      await this.#classic.connect()
      this.#degraded = null
      await this.#classic.listInfraDevices()
    }
    const mac = this.#infra.get(deviceId)?.mac ?? null
    const classicId = mac === null ? null : this.#classic.idForMac(mac)
    if (classicId === null) {
      throw new UnifiApiError(
        404,
        `unifi: device ${deviceId} was not found through the local account (no device with its MAC)`,
      )
    }
    return classicId
  }

  async #connectClassic(): Promise<void> {
    try {
      await this.#classic.connect()
      this.#degraded = null
    } catch (err) {
      this.#degraded = toError(err)
    }
  }

  /** The local account's listing, or none when it does not answer (recorded, never thrown). */
  async #classicListing(): Promise<readonly UnifiInfraSnapshot[]> {
    if (!this.#classic.connected) {
      if (this.#degraded !== null && isRefusal(this.#degraded)) return []
      await this.#connectClassic()
      if (!this.#classic.connected) return []
    }
    try {
      const list = await this.#classic.listInfraDevices()
      this.#degraded = null
      return list
    } catch (err) {
      this.#degraded = toError(err)
      return []
    }
  }
}

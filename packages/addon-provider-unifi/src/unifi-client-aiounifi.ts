/**
 * The UniFi controller client for a LOCAL account (username + password): aiounifi in
 * `python/unifi_worker.py` speaks the classic Network API on a UniFi OS console or a legacy
 * controller. Unlike the API-key Integration API it switches PoE on and off (keeping every
 * other port's override), names the wired client on each port, reports PoE power and
 * temperatures — and it holds the controller's websocket, whose changes arrive here as live
 * tables between polls.
 *
 * The password is held in memory (a worker that restarted is signed in again with it) and
 * reaches the worker only as an owner-only file; it is never logged.
 */
import type {
  UnifiClientSnapshot,
  UnifiControllerClient,
  UnifiInfraPort,
  UnifiInfraSnapshot,
  UnifiInfraState,
  UnifiLiveChange,
} from './unifi-client-contract.js'
import { classifyUnifiInfra } from './unifi-device-kind.js'
import type { UnifiWorkerChannel } from './unifi-worker-channel.js'
import type { UnifiSecretFiles } from './unifi-worker-files.js'
import {
  type UnifiWorkerDevice,
  type UnifiWorkerPush,
  type UnifiWorkerRequest,
  type UnifiWorkerTables,
  UnifiWorkerNotConnectedError,
  workerConnectResultSchema,
  workerTablesSchema,
} from './unifi-worker-protocol.js'

/** The classic API's numeric device state. */
function mapState(state: number | null): UnifiInfraState {
  switch (state) {
    case 1:
      return 'online'
    case 0:
    case 6:
      return 'offline'
    case 2:
      return 'pending'
    case 4:
      return 'upgrading'
    case 5:
    case 7:
      return 'adopting'
    default:
      return 'unknown'
  }
}

/** The Integration API `features` a classic device `type` corresponds to, for the classifier. */
function featuresOfType(type: string | null): readonly string[] {
  if (type === 'uap') return ['accessPoint']
  if (type === 'usw') return ['switching']
  return []
}

function toPort(p: UnifiWorkerDevice['ports'][number]): UnifiInfraPort {
  return {
    idx: p.idx,
    poeOn: p.poeOn,
    poeCapable: p.poeCapable,
    linkUp: p.linkUp,
    speedMbps: p.speedMbps,
    poePowerW: p.poePowerW,
    poeVoltageV: p.poeVoltageV,
    poeCurrentA: p.poeCurrentA,
    clientMac: p.clientMac,
    clientName: p.clientName,
  }
}

/** One worker device as the contract's snapshot. Pure. */
export function workerDeviceToSnapshot(device: UnifiWorkerDevice): UnifiInfraSnapshot {
  const state = mapState(device.state)
  return {
    id: device.id,
    name: device.name,
    mac: device.mac,
    model: device.model,
    kind: classifyUnifiInfra({
      model: device.model,
      features: featuresOfType(device.type),
    }),
    cpuPercent: device.cpuPercent,
    memoryPercent: device.memoryPercent,
    cpuTempC: device.cpuTempC,
    clients: device.clients,
    state,
    uptimeSec: device.uptimeSec,
    ports: device.ports.map(toPort),
    // `default` follows the site setting, which is on unless the operator turned it off.
    ledOn: device.ledOverride !== 'off',
    online: state === 'online',
    poeSwitchable: true,
  }
}

export interface UnifiAiounifiClientOptions {
  readonly host: string
  readonly port: number
  readonly username: string
  readonly password: string
  readonly site: string
  readonly allowSelfSigned: boolean
  /** Starts this connection's worker (one process per controller). */
  readonly openChannel: () => Promise<UnifiWorkerChannel>
  readonly secretFiles: UnifiSecretFiles
}

export class UnifiAiounifiClient implements UnifiControllerClient {
  readonly #options: UnifiAiounifiClientOptions
  #channel: UnifiWorkerChannel | null = null
  #unsubscribe: (() => void) | null = null
  #signedIn = false
  #infra = new Map<string, UnifiInfraSnapshot>()
  #clients = new Map<string, UnifiClientSnapshot>()
  readonly #listeners = new Set<(change: UnifiLiveChange) => void>()

  constructor(options: UnifiAiounifiClientOptions) {
    this.#options = options
  }

  /** Whether the worker holds a signed-in controller. */
  get connected(): boolean {
    return this.#signedIn
  }

  async connect(): Promise<void> {
    const channel = this.#channel ?? (await this.#open())
    await this.#signIn(channel)
  }

  async disconnect(): Promise<void> {
    const channel = this.#channel
    this.#channel = null
    this.#signedIn = false
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#infra = new Map()
    this.#clients = new Map()
    if (channel === null) return
    await channel.request({ op: 'disconnect' }, 5_000).catch((): null => null)
    channel.stop()
  }

  async listInfraDevices(): Promise<readonly UnifiInfraSnapshot[]> {
    // The reconcile poll: a FRESH read of devices and connected clients.
    this.#absorb(await this.#tables(true))
    return [...this.#infra.values()]
  }

  async listClients(): Promise<readonly UnifiClientSnapshot[]> {
    // The tables `listInfraDevices` (or the websocket) just refreshed; no second read.
    this.#absorb(await this.#tables(false))
    return [...this.#clients.values()]
  }

  getInfraDevice(id: string): UnifiInfraSnapshot | null {
    return this.#infra.get(id) ?? null
  }

  /** The id of the device with this MAC in the last tables, or null. */
  idForMac(mac: string): string | null {
    const wanted = mac.toLowerCase()
    for (const d of this.#infra.values()) if (d.mac === wanted) return d.id
    return null
  }

  getClient(mac: string): UnifiClientSnapshot | null {
    return this.#clients.get(mac) ?? null
  }

  /** The worker reads the device fresh and aiounifi sends every other port's override back whole. */
  async setPortPoe(deviceId: string, portIdx: number, on: boolean): Promise<void> {
    await this.#call({ op: 'set_poe', deviceId, portIdx, on })
  }

  async restartDevice(deviceId: string): Promise<void> {
    await this.#call({ op: 'restart', deviceId })
  }

  async powerCyclePort(deviceId: string, portIdx: number): Promise<void> {
    await this.#call({ op: 'power_cycle', deviceId, portIdx })
  }

  async setLed(deviceId: string, on: boolean): Promise<void> {
    await this.#call({ op: 'set_led', deviceId, on })
  }

  degradedError(): Error | null {
    return null
  }

  onLiveChange(listener: (change: UnifiLiveChange) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async #open(): Promise<UnifiWorkerChannel> {
    const channel = await this.#options.openChannel()
    channel.noteSecrets([this.#options.password])
    this.#unsubscribe = channel.onPush((push) => this.#onPush(push))
    this.#channel = channel
    return channel
  }

  async #signIn(channel: UnifiWorkerChannel): Promise<void> {
    const o = this.#options
    const result = await o.secretFiles(o.password, (passwordFile) =>
      channel.request({
        op: 'connect',
        host: o.host,
        port: o.port,
        site: o.site,
        username: o.username,
        passwordFile,
        allowSelfSigned: o.allowSelfSigned,
      }),
    )
    workerConnectResultSchema.parse(result)
    this.#signedIn = true
  }

  /** A call on a worker that lost its sign-in (it restarted) signs in again once, then retries. */
  async #call(request: UnifiWorkerRequest): Promise<unknown> {
    const channel = this.#channel
    if (channel === null) throw new Error('unifi: client is not connected')
    if (!this.#signedIn) await this.#signIn(channel)
    try {
      return await channel.request(request)
    } catch (err) {
      if (!(err instanceof UnifiWorkerNotConnectedError)) throw err
      this.#signedIn = false
      await this.#signIn(channel)
      return channel.request(request)
    }
  }

  async #tables(refresh: boolean): Promise<UnifiWorkerTables> {
    return workerTablesSchema.parse(await this.#call({ op: 'list', refresh }))
  }

  #absorb(tables: UnifiWorkerTables): void {
    this.#infra = new Map(tables.devices.map((d) => [d.id, workerDeviceToSnapshot(d)]))
    this.#clients = new Map(
      tables.clients.map((c) => [
        c.mac,
        {
          mac: c.mac,
          hostname: c.hostname,
          ip: c.ip,
          connected: true,
          online: true,
        },
      ]),
    )
  }

  #onPush(push: UnifiWorkerPush): void {
    if (push.push === 'snapshot') {
      this.#absorb(push)
      this.#emit({
        kind: 'tables',
        infra: [...this.#infra.values()],
        clients: [...this.#clients.values()],
      })
      return
    }
    // A worker that exited lost its sign-in; the next call signs in again.
    if (push.reason === 'worker exited') this.#signedIn = false
    this.#emit({
      kind: 'stream',
      up: push.state === 'up',
      reason: push.reason ?? null,
    })
  }

  #emit(change: UnifiLiveChange): void {
    for (const listener of this.#listeners) listener(change)
  }
}

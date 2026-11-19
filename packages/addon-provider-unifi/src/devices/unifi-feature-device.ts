import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import {
  BaseDevice,
  buttonCapability,
  type DeviceContext,
  type DeviceFeature,
  enumSensorCapability,
  errMsg,
  type InferNativeProvider,
  NETWORK_LINK_UNKNOWN,
  type NetworkLinkStatus,
  networkLinkCapability,
  numericSensorCapability,
  type PowerMeterStatus,
  powerMeterCapability,
  type PresenceStatus,
  presenceCapability,
  type SwitchStatus,
  switchCapability,
  temperatureSensorCapability,
} from '@camstack/types'
import {
  type UnifiButtonAction,
  type UnifiFeatureKind,
  type UnifiSensorMetric,
  type UnifiSwitchFeature,
  unifiFeatureSchema,
} from '../config.js'
import type { UnifiControllerClient } from '../unifi-client-contract.js'
import type { UnifiInfraPort } from '../unifi-client-contract.js'
import { capForMetric, portLabel, portNameWrite, quantityForMetric } from '../unifi-mapping.js'
import { portNetworkLinkStatus, portPowerStatus, portSwitchStatus } from '../unifi-port-state.js'
import { UnifiUnsupportedError } from '../unifi-errors.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { registerUnifiStateRefresh } from './unifi-state-refresh.js'
import { unifiPortAttachedIdentifiers } from '../unifi-identifiers.js'

const COLD_SWITCH: SwitchStatus = { on: false, lastChangedAt: 0 }
const COLD_POWER: PowerMeterStatus = { lastFetchedAt: 0 }
const COLD_PRESENCE: PresenceStatus = {
  state: 'not_home',
  location: null,
  gps: null,
  lastChangedAt: 0,
}

/**
 * A single generic child device servicing all four UniFi child `kind`s
 * (`switch` | `button` | `sensor` | `presence`) via a discriminated config. The
 * `kind` selects the ONE cap it registers:
 *   - `switch`   → `switch` cap — per-port PoE toggle (`setPortPoe`) or device
 *                  LED (`setLed`); a CHILD of an infra Container.
 *   - `button`   → `button` cap — device restart (`restartDevice`) or per-port
 *                  power-cycle (`powerCyclePort`); a CHILD of an infra Container.
 *   - `sensor`   → a typed sensor cap chosen from `metric` (numeric / temperature
 *                  / enum); a CHILD of an infra Container.
 *   - `presence` → `presence` cap — a network client tracker; a top-level device,
 *                  a sibling of the controller's infra devices.
 *   - `port`     → one PoE port of a switch (a CHILD of it): `power-meter`, `network-link`
 *                  and `switch` — PoE on/off through the local account when `switchable`,
 *                  else only a native power cycle (the API key's POWER_CYCLE). Its name follows the client on the port
 *                  unless the operator renamed it; the client's MAC is kept in its config.
 *
 * The slice is fed from the live controller snapshot on each poll tick (and
 * seeded cold on activate). Commands are driven through the live client resolved
 * from {@link unifiControllers}.
 */
export class UnifiFeatureDevice extends BaseDevice<typeof unifiFeatureSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly kind: UnifiFeatureKind
  private readonly integrationId: string
  private stopStateRefresh: (() => void) | null = null
  private readonly infraNativeId: string | undefined
  private readonly switchFeature: UnifiSwitchFeature | undefined
  private readonly buttonAction: UnifiButtonAction | undefined
  private readonly portIdx: number | undefined
  private readonly metric: UnifiSensorMetric | undefined
  private readonly mac: string | undefined
  private readonly switchable: boolean
  /** The last client MAC persisted / the last auto name decided, so a tick writes only on change. */
  private lastClientMac: string | undefined
  private lastDesiredName: string | null = null
  /** The attached identifiers last declared (D1063), so a poll tick writes only on change. */
  private lastAttachedKey: string | null = null

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = unifiFeatureSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unifiFeatureSchema, { type: ctx.deviceMeta.type })
    this.kind = cfg.kind
    this.integrationId = cfg.integrationId
    this.infraNativeId = cfg.infraNativeId
    registerUnifiAdminLink(ctx, this.id, { integrationId: this.integrationId })
    this.switchFeature = cfg.switchFeature
    this.buttonAction = cfg.buttonAction
    this.portIdx = cfg.portIdx
    this.metric = cfg.metric
    this.mac = cfg.mac
    this.switchable = cfg.switchable === true
    this.lastClientMac = cfg.clientMac
    this.online = false
    // Every construction, so a device adopted before the quantity existed picks it up on restore.
    const quantity = this.metric === undefined ? undefined : quantityForMetric(this.metric)
    void this.updateSourceInfo({
      id: this.identityKey(),
      system: 'unifi',
      ...(quantity !== undefined ? { quantity } : {}),
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The core decides when the controller is re-read (D1062); this device only reads.
    this.stopStateRefresh ??= registerUnifiStateRefresh({
      ctx: this.ctx,
      deviceId: this.id,
      integrationId: this.integrationId,
    })
    // Register the cap + seed cold-start, THEN attach the live listener and
    // replay the current value (mirrors the Ecowitt / Velux ordering:
    // registerNativeCap first so the slice schema is installed before setCapState).
    this.registerCap()
    this.attachSnapshotListener()
    this.recomputeSlice()
  }

  override async removeDevice(): Promise<void> {
    this.stopStateRefresh?.()
    this.stopStateRefresh = null
    if (this.snapshotUnsub) {
      try {
        this.snapshotUnsub()
      } catch {
        // best-effort
      }
      this.snapshotUnsub = null
    }
    await super.removeDevice()
  }

  // ── Identity / live-client resolution ──────────────────────────────────────

  /** A stable per-device identity fragment for `sourceInfo`. */
  private identityKey(): string {
    if (this.kind === 'presence') return `${this.integrationId}:${this.mac ?? 'unknown'}`
    return `${this.integrationId}:${this.infraNativeId ?? 'unknown'}:${this.kind}:${this.portIdx ?? this.metric ?? this.switchFeature ?? this.buttonAction ?? ''}`
  }

  private resolveClient(): UnifiControllerClient {
    const client = unifiControllers.getManager(this.integrationId)?.client ?? null
    if (client === null) {
      throw new Error(
        `UniFi ${this.kind} ${this.id}: controller ${this.integrationId} client is not available`,
      )
    }
    return client
  }

  private requireInfraId(): string {
    if (this.infraNativeId === undefined) {
      throw new Error(`UniFi ${this.kind} ${this.id}: missing owning infra device id`)
    }
    return this.infraNativeId
  }

  private requirePortIdx(): number {
    if (this.portIdx === undefined) {
      throw new Error(`UniFi ${this.kind} ${this.id}: missing port index`)
    }
    return this.portIdx
  }

  // ── Live-snapshot fan-in ────────────────────────────────────────────────────

  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('unifi feature: snapshot handler error', {
          tags: { deviceId: this.id },
          meta: { kind: this.kind, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = unifiControllers.onSnapshot(this.integrationId, onSnapshot)
  }

  /** Recompute + write this device's cap slice (and online) from the live snapshot. */
  private recomputeSlice(): void {
    switch (this.kind) {
      case 'switch':
        return this.recomputeSwitch()
      case 'button':
        return this.recomputeButtonOnline()
      case 'sensor':
        return this.recomputeSensor()
      case 'presence':
        return this.recomputePresence()
      case 'port':
        return this.recomputePort()
    }
  }

  private livePort(): {
    readonly online: boolean
    readonly port: UnifiInfraPort
  } | null {
    const infra = this.infraNativeId
      ? unifiControllers.getInfra(this.integrationId, this.infraNativeId)
      : null
    const port = infra?.ports.find((p) => p.idx === this.portIdx)
    return infra === null || port === undefined ? null : { online: infra.online, port }
  }

  private recomputePort(): void {
    const live = this.livePort()
    if (live === null) return
    if (this.online !== live.online) this.markOnline(live.online)
    const now = Date.now()
    this.runtimeState.setCapState('switch', portSwitchStatus(live.port, now))
    this.runtimeState.setCapState('power-meter', portPowerStatus(live.port, now))
    this.runtimeState.setCapState('network-link', portNetworkLinkStatus(live.port, now))
    void this.followClient(live.port)
  }

  /**
   * Declare the wired client as ATTACHED to this port (D1063) — never as the port's own
   * identity. The client on the port NOW is a fresh read; a port whose client left declares the
   * last MAC as unread, so it is kept but retained (absence is not a different client, and a
   * port that freshly reads it wins the auto link); an IP the controller does not know right
   * now is unread (D49).
   */
  private async declareAttached(currentClientMac: string | null): Promise<void> {
    const mac = currentClientMac ?? this.lastClientMac ?? null
    const ip =
      currentClientMac === null
        ? null
        : (unifiControllers.getClient(this.integrationId, currentClientMac)?.ip ?? null)
    const declaration = unifiPortAttachedIdentifiers(mac, currentClientMac, ip)
    if (declaration === null) return
    const key = JSON.stringify(declaration)
    if (key === this.lastAttachedKey) return
    this.lastAttachedKey = key
    const result = await this.declareAttachedIdentifiers(declaration.identifiers, {
      unread: declaration.unread,
    })
    if (result.outcome !== 'declared') this.lastAttachedKey = null
  }

  /**
   * Keep the last client's MAC in config (cross-integration linking, planning#583) and the name
   * on "<client> (port N)" unless the operator renamed the port. A port whose client left keeps
   * the last MAC: absence on one poll is not a different client.
   */
  private async followClient(port: UnifiInfraPort): Promise<void> {
    try {
      if (port.clientMac !== null && port.clientMac !== this.lastClientMac) {
        this.lastClientMac = port.clientMac
        await this.config.set('clientMac', port.clientMac)
        this.ctx.logger.info('UniFi PoE port: client on the port changed', {
          tags: { deviceId: this.id },
          meta: { portIdx: port.idx, clientMac: port.clientMac },
        })
      }
      await this.declareAttached(port.clientMac)
      if (port.clientName === null) return
      const desired = portLabel(port.idx, port.clientName)
      if (desired === this.lastDesiredName) return
      this.lastDesiredName = desired
      const manager = this.ctx.api?.deviceManager
      if (manager === undefined) return
      const meta = await manager.loadMeta.query({ deviceId: this.id })
      if (meta === null) return
      const decision = portNameWrite({
        currentName: meta.name,
        userNamed: meta.userNamed,
        desiredName: desired,
        portIdx: port.idx,
        stableId: this.stableId,
      })
      if (decision.kind === 'keep') return
      await manager.setName.mutate({
        deviceId: this.id,
        name: decision.name,
        ...(decision.stampUserNamed ? {} : { stampUserNamed: false }),
      })
      this.ctx.logger.info('UniFi PoE port took its client name', {
        tags: { deviceId: this.id },
        meta: { portIdx: port.idx, name: decision.name },
      })
    } catch (err) {
      this.lastDesiredName = null
      this.ctx.logger.warn('UniFi PoE port: client name / MAC update failed', {
        tags: { deviceId: this.id },
        meta: { portIdx: port.idx, error: errMsg(err) },
      })
    }
  }

  private recomputeSwitch(): void {
    const infra = this.infraNativeId
      ? unifiControllers.getInfra(this.integrationId, this.infraNativeId)
      : null
    if (infra === null) return
    if (this.online !== infra.online) this.markOnline(infra.online)
    const on =
      this.switchFeature === 'led'
        ? infra.ledOn
        : (infra.ports.find((p) => p.idx === this.portIdx)?.poeOn ?? false)
    this.runtimeState.setCapState('switch', { on, lastChangedAt: Date.now() })
  }

  private recomputeButtonOnline(): void {
    const infra = this.infraNativeId
      ? unifiControllers.getInfra(this.integrationId, this.infraNativeId)
      : null
    if (infra === null) return
    if (this.online !== infra.online) this.markOnline(infra.online)
  }

  private recomputeSensor(): void {
    const infra = this.infraNativeId
      ? unifiControllers.getInfra(this.integrationId, this.infraNativeId)
      : null
    if (infra === null || this.metric === undefined) return
    if (this.online !== infra.online) this.markOnline(infra.online)
    const now = Date.now()
    switch (capForMetric(this.metric)) {
      case 'temperature-sensor':
        this.runtimeState.setCapState('temperature-sensor', {
          temperature: infra.cpuTempC ?? 0,
          lastFetchedAt: now,
        })
        return
      case 'enum-sensor':
        this.runtimeState.setCapState('enum-sensor', {
          value: infra.state,
          lastFetchedAt: now,
        })
        return
      case 'numeric-sensor': {
        const value = this.metric === 'clients' ? infra.clients : this.numericMetricValue(infra)
        this.runtimeState.setCapState('numeric-sensor', { value, lastFetchedAt: now })
        return
      }
    }
  }

  private numericMetricValue(infra: {
    cpuPercent: number | null
    uptimeSec: number | null
  }): number {
    switch (this.metric) {
      case 'cpu_utilization':
        return infra.cpuPercent ?? 0
      case 'uptime':
        return infra.uptimeSec ?? 0
      default:
        return 0
    }
  }

  private recomputePresence(): void {
    const client = this.mac ? unifiControllers.getClient(this.integrationId, this.mac) : null
    if (client === null) return
    if (this.online !== client.online) this.markOnline(client.online)
    const status: PresenceStatus = {
      state: client.connected ? 'home' : 'not_home',
      location: client.ip,
      gps: null,
      lastChangedAt: Date.now(),
    }
    this.runtimeState.setCapState('presence', status)
  }

  // ── Cap registration ────────────────────────────────────────────────────────

  private registerCap(): void {
    switch (this.kind) {
      case 'switch':
        return this.registerSwitchCap()
      case 'button':
        return this.registerButtonCap()
      case 'sensor':
        return this.registerSensorCap()
      case 'presence':
        return this.registerPresenceCap()
      case 'port':
        return this.registerPortCaps()
    }
  }

  private registerPortCaps(): void {
    this.ctx.registerNativeCap(
      switchCapability,
      this.switchable ? this.poeToggleProvider() : this.poeCycleProvider(),
    )
    this.runtimeState.setCapState('switch', COLD_SWITCH)
    const power: InferNativeProvider<typeof powerMeterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_POWER,
    }
    this.ctx.registerNativeCap(powerMeterCapability, power)
    this.runtimeState.setCapState('power-meter', COLD_POWER)
    const link: InferNativeProvider<typeof networkLinkCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<NetworkLinkStatus>('network-link') ?? NETWORK_LINK_UNKNOWN,
    }
    this.ctx.registerNativeCap(networkLinkCapability, link)
    this.runtimeState.setCapState('network-link', NETWORK_LINK_UNKNOWN)
  }

  /**
   * A port the local account can switch: PoE on/off. A forced restart through a linked
   * power-source is off / wait / on, so no native cycle is declared.
   */
  private poeToggleProvider(): InferNativeProvider<typeof switchCapability> {
    return {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD_SWITCH,
      getOptions: async () => ({ supportsSetState: true, supportsPowerCycle: false }),
      setState: async ({ on }) => {
        await this.resolveClient().setPortPoe(this.requireInfraId(), this.requirePortIdx(), on)
        this.runtimeState.setCapState('switch', { on, lastChangedAt: Date.now() })
      },
    }
  }

  /**
   * A port seen only through the API key: it reports PoE on/off but cannot set it. The one
   * thing it can do is the Integration API's POWER_CYCLE, which a linked power-source's
   * forced restart uses. No button of its own.
   */
  private poeCycleProvider(): InferNativeProvider<typeof switchCapability> {
    return {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD_SWITCH,
      getOptions: async () => ({ supportsSetState: false, supportsPowerCycle: true }),
      setState: async () => {
        throw new UnifiUnsupportedError(
          'poe-toggle',
          'PoE on/off needs a local account on the UniFi integration; this port can only power-cycle',
        )
      },
      powerCycle: async () => {
        await this.resolveClient().powerCyclePort(this.requireInfraId(), this.requirePortIdx())
        this.ctx.logger.info('UniFi PoE port power-cycled', {
          tags: { deviceId: this.id },
          meta: { infraId: this.infraNativeId, portIdx: this.portIdx },
        })
      },
    }
  }

  private registerSwitchCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD_SWITCH,
      setState: async ({ on }) => {
        const client = this.resolveClient()
        if (this.switchFeature === 'led') {
          await client.setLed(this.requireInfraId(), on)
        } else {
          await client.setPortPoe(this.requireInfraId(), this.requirePortIdx(), on)
        }
        this.runtimeState.setCapState('switch', {
          on,
          lastChangedAt: Date.now(),
        })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState('switch', COLD_SWITCH)
  }

  private registerButtonCap(): void {
    const provider: InferNativeProvider<typeof buttonCapability> = {
      press: async () => {
        const client = this.resolveClient()
        if (this.buttonAction === 'restart') {
          await client.restartDevice(this.requireInfraId())
        } else {
          await client.powerCyclePort(this.requireInfraId(), this.requirePortIdx())
        }
      },
    }
    this.ctx.registerNativeCap(buttonCapability, provider)
  }

  private registerSensorCap(): void {
    if (this.metric === undefined) return
    switch (capForMetric(this.metric)) {
      case 'temperature-sensor': {
        const COLD = { temperature: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<typeof COLD>('temperature-sensor') ?? COLD,
        }
        this.ctx.registerNativeCap(temperatureSensorCapability, provider)
        this.runtimeState.setCapState('temperature-sensor', COLD)
        return
      }
      case 'enum-sensor': {
        const COLD = { value: 'unknown', lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof enumSensorCapability> = {
          getStatus: async () => this.runtimeState.getCapState<typeof COLD>('enum-sensor') ?? COLD,
        }
        this.ctx.registerNativeCap(enumSensorCapability, provider)
        this.runtimeState.setCapState('enum-sensor', COLD)
        return
      }
      case 'numeric-sensor': {
        const COLD = { value: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof numericSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<typeof COLD>('numeric-sensor') ?? COLD,
        }
        this.ctx.registerNativeCap(numericSensorCapability, provider)
        this.runtimeState.setCapState('numeric-sensor', COLD)
        return
      }
    }
  }

  private registerPresenceCap(): void {
    const provider: InferNativeProvider<typeof presenceCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<PresenceStatus>('presence') ?? COLD_PRESENCE,
    }
    this.ctx.registerNativeCap(presenceCapability, provider)
    this.runtimeState.setCapState('presence', COLD_PRESENCE)
  }
}

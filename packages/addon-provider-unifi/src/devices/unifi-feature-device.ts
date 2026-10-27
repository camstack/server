import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import {
  BaseDevice,
  buttonCapability,
  type DeviceContext,
  type DeviceFeature,
  enumSensorCapability,
  errMsg,
  type InferNativeProvider,
  numericSensorCapability,
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
import { capForMetric, unitForMetric } from '../unifi-mapping.js'
import { unifiControllers } from '../unifi-node-resolver.js'

const COLD_SWITCH: SwitchStatus = { on: false, lastChangedAt: 0 }
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
 *   - `presence` → `presence` cap — a network client tracker; a direct CHILD of
 *                  the controller Hub.
 *
 * The slice is fed from the live controller snapshot on each poll tick (and
 * seeded cold on activate). Commands are driven through the live client resolved
 * from {@link unifiControllers}.
 */
export class UnifiFeatureDevice extends BaseDevice<typeof unifiFeatureSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly kind: UnifiFeatureKind
  private readonly controllerId: string
  private readonly infraNativeId: string | undefined
  private readonly switchFeature: UnifiSwitchFeature | undefined
  private readonly buttonAction: UnifiButtonAction | undefined
  private readonly portIdx: number | undefined
  private readonly metric: UnifiSensorMetric | undefined
  private readonly mac: string | undefined

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = unifiFeatureSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unifiFeatureSchema, { type: ctx.deviceMeta.type })
    this.kind = cfg.kind
    this.controllerId = cfg.controllerId
    this.infraNativeId = cfg.infraNativeId
    registerUnifiAdminLink(ctx, this.id, {
      kind: 'controller',
      controllerId: this.controllerId,
    })
    this.switchFeature = cfg.switchFeature
    this.buttonAction = cfg.buttonAction
    this.portIdx = cfg.portIdx
    this.metric = cfg.metric
    this.mac = cfg.mac
    this.online = false
    void this.updateSourceInfo({ id: this.identityKey(), system: 'unifi' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // Register the cap + seed cold-start, THEN attach the live listener and
    // replay the current value (mirrors the Ecowitt / Velux ordering:
    // registerNativeCap first so the slice schema is installed before setCapState).
    this.registerCap()
    this.attachSnapshotListener()
    this.recomputeSlice()
  }

  override async removeDevice(): Promise<void> {
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
    if (this.kind === 'presence') return `${this.controllerId}:${this.mac ?? 'unknown'}`
    return `${this.controllerId}:${this.infraNativeId ?? 'unknown'}:${this.kind}:${this.portIdx ?? this.metric ?? this.switchFeature ?? this.buttonAction ?? ''}`
  }

  private resolveClient(): UnifiControllerClient {
    const client = unifiControllers.getManager(this.controllerId)?.client ?? null
    if (client === null) {
      throw new Error(
        `UniFi ${this.kind} ${this.id}: controller ${this.controllerId} client is not available`,
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
          meta: { deviceId: this.id, kind: this.kind, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = unifiControllers.onSnapshot(this.controllerId, onSnapshot)
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
    }
  }

  private recomputeSwitch(): void {
    const infra = this.infraNativeId
      ? unifiControllers.getInfra(this.controllerId, this.infraNativeId)
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
      ? unifiControllers.getInfra(this.controllerId, this.infraNativeId)
      : null
    if (infra === null) return
    if (this.online !== infra.online) this.markOnline(infra.online)
  }

  private recomputeSensor(): void {
    const infra = this.infraNativeId
      ? unifiControllers.getInfra(this.controllerId, this.infraNativeId)
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
        this.runtimeState.setCapState('enum-sensor', { value: infra.state, lastFetchedAt: now })
        return
      case 'numeric-sensor': {
        const value = this.metric === 'clients' ? infra.clients : this.numericMetricValue(infra)
        const unit = unitForMetric(this.metric)
        this.runtimeState.setCapState('numeric-sensor', {
          value,
          lastFetchedAt: now,
          ...(unit !== undefined ? { unit } : {}),
        })
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
    const client = this.mac ? unifiControllers.getClient(this.controllerId, this.mac) : null
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
        this.runtimeState.setCapState('switch', { on, lastChangedAt: Date.now() })
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
        const unit = unitForMetric(this.metric)
        const COLD = { value: 0, lastFetchedAt: 0, ...(unit !== undefined ? { unit } : {}) }
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

/**
 * One Zigbee2MQTT device as one CamStack device. Its primary function picks the device type (see
 * `z2m-exposes.ts`); every other reading is a cap of the same device. State is pushed by the server
 * through the hub, never polled, and every slice is recomputed from the last state message and
 * rewritten only when it changed. Commands go out as `<friendly_name>/set`, the name resolved from
 * the server's table at the moment of the call, so a rename is followed.
 */
import {
  airQualitySensorCapability,
  ambientLightSensorCapability,
  BaseDevice,
  batteryCapability,
  brightnessCapability,
  climateControlCapability,
  deviceStateRefreshCapability,
  colorCapability,
  contactCapability,
  conventionalEventVocabulary,
  coverCapability,
  createEvent,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
  EventCategory,
  type EventEmitterStatus,
  type EventFire,
  eventEmitterCapability,
  deviceMeshCapability,
  floodCapability,
  HvacModeSchema,
  humiditySensorCapability,
  ingestReading,
  type InferNativeProvider,
  type InferRuntimeState,
  lockControlCapability,
  motionCapability,
  type AirQualitySensorStatus,
  type PowerMeterStatus,
  powerMeterCapability,
  pressureSensorCapability,
  type RawStateResult,
  type ReadingQuantity,
  smokeCapability,
  switchCapability,
  tamperCapability,
  temperatureSensorCapability,
  vibrationCapability,
  type CoverState,
  type HvacMode,
  type LockState,
} from '@camstack/types'
import { zigbeeDeviceSchema, type ZigbeeDeviceConfig } from './z2m-device-config.js'
import { type Z2mCap, type Z2mPlan, planZ2mDevice, roleForPrimaryCap } from './z2m-exposes.js'
import { type Z2mConnection } from './z2m-client.js'
import { z2mHub } from './z2m-hub.js'
import { meshProviderFor } from './z2m-mesh.js'
import type { Z2mDevice, Z2mScalar, Z2mState } from './z2m-protocol.js'

const METER_QUANTITY = {
  power: 'power',
  energy: 'energy',
  voltage: 'voltage',
  current: 'current',
} as const satisfies Record<string, ReadingQuantity>

const AIR_QUANTITY = {
  co2: 'concentration-volume',
  voc: 'concentration-ppb',
  pm25: 'concentration-mass',
  pm10: 'concentration-mass',
  aqi: 'index',
} as const satisfies Record<string, ReadingQuantity>

const METER_FIELDS = ['power', 'energy', 'voltage', 'current'] as const
const AIR_FIELDS = ['co2', 'voc', 'pm25', 'pm10', 'aqi'] as const

const COLD_BATTERY = {
  level: null,
  charging: 'unknown' as const,
  sleeping: false,
  lastUpdated: 0,
}

function unsupported(what: string): Error {
  return new Error(`zigbee2mqtt: ${what} is not supported by this device`)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isHvacMode(value: string): value is HvacMode {
  return HvacModeSchema.safeParse(value).success
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function sameScalar(a: unknown, b: Z2mScalar): boolean {
  return (
    a === b ||
    (typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase())
  )
}

/** The state of a cover from what Zigbee2MQTT reports: `state` first, the position when it says nothing. */
export function coverStateOf(state: string | null, position: number | null): CoverState | null {
  if (state !== null) {
    const s = state.toUpperCase()
    if (s === 'OPEN') return 'open'
    if (s === 'CLOSE' || s === 'CLOSED') return 'closed'
    if (s === 'STOP') return 'stopped'
  }
  if (position === null) return null
  if (position <= 0) return 'closed'
  return position >= 100 ? 'open' : 'stopped'
}

/** The state of a lock; a lock that is not fully locked reads unlocked, the safe reading. */
export function lockStateOf(lockState: string | null, commanded: boolean | null): LockState | null {
  if (lockState === 'locked') return 'locked'
  if (lockState === 'unlocked' || lockState === 'not_fully_locked') return 'unlocked'
  if (commanded === null) return null
  return commanded ? 'locked' : 'unlocked'
}

export class ZigbeeDevice extends BaseDevice<typeof zigbeeDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly persisted: ZigbeeDeviceConfig
  private plan: Z2mPlan | null
  private lastState: Z2mState = {}
  private entry: Z2mDevice | null = null
  private linkOnline = false
  private bridgeOnline: boolean | null = null
  private available: boolean | null = null
  private readonly registered = new Set<Z2mCap>()
  private eventSeq = 0
  private eventCount = 0

  constructor(ctx: DeviceContext) {
    super(ctx, zigbeeDeviceSchema, { type: ctx.deviceMeta.type })
    const persisted = this.config.values
    this.persisted = persisted
    this.plan = persisted.plan ?? null
    void this.updateSourceInfo({
      id: persisted.equipment,
      system: 'zigbee2mqtt',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerPlanCaps()
    this.registerStateRefresh()
    this.markOnline(false)
    await this.backfillRole()
    const { integrationId, equipment } = this.persisted
    z2mHub.bindDevice(integrationId, equipment, this.id)
    this.ctx.registerNativeCap(deviceMeshCapability, meshProviderFor(z2mHub, integrationId))
    // No teardown hook exists on a device: the subscriptions live as long as the process.
    z2mHub.subscribeLink(integrationId, {
      connection: (state) => this.onConnection(state),
      bridge: (_info, online) => {
        this.bridgeOnline = online
        this.syncOnline()
      },
      devices: () => {},
    })
    z2mHub.subscribeDevice(integrationId, equipment, {
      device: (entry) => this.onEntry(entry),
      state: (state, delta) => this.onState(state, delta),
      availability: (online) => {
        this.available = online
        this.syncOnline()
      },
    })
  }

  // ── Server → device ────────────────────────────────────────────────────

  private onConnection(state: Z2mConnection): void {
    this.linkOnline = state === 'online'
    this.syncOnline()
  }

  private syncOnline(): void {
    this.markOnline(this.linkOnline && this.bridgeOnline !== false && this.available !== false)
  }

  private onEntry(entry: Z2mDevice | null): void {
    this.entry = entry
    if (entry === null) {
      this.ctx.logger.warn('zigbee2mqtt: the server no longer lists this device', {
        tags: { deviceId: this.id },
        meta: { ieee: this.persisted.equipment },
      })
      this.available = false
      this.syncOnline()
      return
    }
    const exposes = entry.definition?.exposes
    if (exposes === undefined) return
    const next = planZ2mDevice(exposes)
    if (next === null || JSON.stringify(next) === JSON.stringify(this.plan)) return
    const added = next.capabilities.filter((c) => !this.registered.has(c))
    this.plan = next
    this.registerPlanCaps()
    this.refresh()
    this.ctx.logger.info('zigbee2mqtt: device re-planned from its exposes', {
      tags: { deviceId: this.id },
      meta: { added: added.join(',') },
    })
    void this.config.set('plan', next).catch((err: unknown) => {
      this.ctx.logger.warn('zigbee2mqtt: re-planned layout was not persisted', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    })
  }

  private onState(state: Z2mState, delta: Z2mState): void {
    this.lastState = state
    this.fireAction(delta)
    this.refresh()
  }

  /**
   * A device adopted without a role gets the one its primary function names, once; an operator's
   * choice (any non-null role) is left alone. A device with several distinct readings has no
   * dedicated ambient-monitor role on this branch, so it keeps its primary function's role.
   */
  private async backfillRole(): Promise<void> {
    const stored: unknown = 'role' in this.ctx.deviceMeta ? this.ctx.deviceMeta.role : null
    if (typeof stored === 'string' && stored.length > 0) return
    const role = roleForPrimaryCap(this.plan?.capabilities[0])
    if (role === null) return
    try {
      await this.ctx.api.deviceManager.setRole.mutate({
        deviceId: this.id,
        role,
      })
    } catch (err: unknown) {
      this.ctx.logger.warn('zigbee2mqtt: device role was not set', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err), role },
      })
    }
  }

  // ── Raw state ──────────────────────────────────────────────────────────

  async getRawState(): Promise<RawStateResult | null> {
    return {
      source: 'zigbee2mqtt',
      data: {
        state: this.lastState,
        model: this.entry?.definition?.model ?? null,
        vendor: this.entry?.definition?.vendor ?? null,
        capabilities: this.plan?.capabilities ?? [],
        skipped: this.plan?.skipped ?? [],
      },
    }
  }

  // ── Readings ───────────────────────────────────────────────────────────

  private prop(key: string): string | null {
    return this.plan?.props[key] ?? null
  }

  private number(property: string | null, quantity: ReadingQuantity): number | null {
    if (property === null) return null
    const raw = asNumber(this.lastState[property])
    if (raw === null) return null
    const result = ingestReading({
      value: raw,
      rawUnit: this.plan?.units[property],
      quantity,
    })
    if (result.ok) return result.value
    this.ctx.logger.warn('numeric reading refused', {
      tags: { deviceId: this.id },
      meta: { property, quantity, reason: result.reason },
    })
    return null
  }

  /** The active/inactive reading of a binary cap, null when the device has not said. */
  private active(cap: string): boolean | null {
    const property = this.prop(cap)
    const values = this.plan?.binary[cap]
    if (property === null || values === undefined) return null
    const value = this.lastState[property]
    if (sameScalar(value, values.on)) return true
    if (sameScalar(value, values.off)) return false
    return null
  }

  private refresh(): void {
    if (this.plan === null) return
    for (const cap of this.plan.capabilities) this.refreshCap(cap, this.plan)
  }

  private refreshCap(cap: Z2mCap, plan: Z2mPlan): void {
    const now = Date.now()
    switch (cap) {
      case 'switch': {
        const on = this.active('switch')
        if (on === null || this.getCapSlice(switchCapability)?.on === on) return
        this.setCapSlice(switchCapability, { on, lastChangedAt: now })
        return
      }
      case 'brightness': {
        const raw = asNumber(this.lastState[this.prop('brightness') ?? ''])
        const max = plan.range.brightnessMax ?? 254
        if (raw === null) return
        const level = clamp(Math.round((raw / max) * 100), 0, 100)
        if (this.getCapSlice(brightnessCapability)?.level === level) return
        this.setCapSlice(brightnessCapability, { level, lastChangedAt: now })
        return
      }
      case 'color': {
        const mireds = asNumber(this.lastState[this.prop('color') ?? ''])
        if (mireds === null || this.getCapSlice(colorCapability)?.colorTemperature === mireds)
          return
        this.setCapSlice(colorCapability, {
          mode: 'mired',
          colorTemperature: Math.round(mireds),
          lastChangedAt: now,
        })
        return
      }
      case 'battery': {
        const value = this.number(this.prop('battery'), 'percentage')
        if (value === null) return
        const level = clamp(value, 0, 100)
        if (this.getCapSlice(batteryCapability)?.level === level) return
        this.setCapSlice(batteryCapability, {
          level,
          charging: 'unknown',
          sleeping: false,
          lastUpdated: now,
        })
        return
      }
      case 'contact': {
        // Zigbee2MQTT's `contact` is true when CLOSED: its `value_on` is false, so active means open.
        const open = this.active('contact')
        if (open === null || this.getCapSlice(contactCapability)?.entryOpen === open) return
        this.setCapSlice(contactCapability, { entryOpen: open, lastChangedAt: now })
        return
      }
      case 'motion': {
        const detected = this.active('motion')
        if (detected === null) return
        const prior = this.getCapSlice(motionCapability)
        if (prior?.detected === detected) return
        this.setCapSlice(motionCapability, {
          detected,
          lastDetectedAt: detected ? now : (prior?.lastDetectedAt ?? null),
          autoClearAfterMs: null,
        })
        return
      }
      case 'flood': {
        const flooded = this.active('flood')
        if (flooded === null || this.getCapSlice(floodCapability)?.flooded === flooded) return
        this.setCapSlice(floodCapability, { flooded, lastChangedAt: now })
        return
      }
      case 'smoke': {
        const detected = this.active('smoke')
        if (detected === null || this.getCapSlice(smokeCapability)?.detected === detected) return
        this.setCapSlice(smokeCapability, { detected, lastChangedAt: now })
        return
      }
      case 'vibration': {
        const detected = this.active('vibration')
        if (detected === null || this.getCapSlice(vibrationCapability)?.detected === detected)
          return
        this.setCapSlice(vibrationCapability, { detected, lastChangedAt: now })
        return
      }
      case 'tamper': {
        const tampered = this.active('tamper')
        if (tampered === null || this.getCapSlice(tamperCapability)?.tampered === tampered) return
        this.setCapSlice(tamperCapability, { tampered, lastChangedAt: now })
        return
      }
      case 'temperature-sensor': {
        const temperature = this.number(this.prop('temperature-sensor'), 'temperature')
        if (temperature === null) return
        this.setCapSlice(temperatureSensorCapability, {
          temperature,
          lastFetchedAt: now,
        })
        return
      }
      case 'humidity-sensor': {
        const humidity = this.number(this.prop('humidity-sensor'), 'humidity')
        if (humidity === null) return
        this.setCapSlice(humiditySensorCapability, {
          humidity: clamp(humidity, 0, 100),
          lastFetchedAt: now,
        })
        return
      }
      case 'pressure-sensor': {
        const pressure = this.number(this.prop('pressure-sensor'), 'pressure')
        if (pressure === null) return
        this.setCapSlice(pressureSensorCapability, {
          pressure,
          lastFetchedAt: now,
        })
        return
      }
      case 'ambient-light-sensor': {
        const lux = this.number(this.prop('ambient-light-sensor'), 'illuminance')
        if (lux === null) return
        this.setCapSlice(ambientLightSensorCapability, {
          illuminance: Math.max(0, lux),
          lastFetchedAt: now,
        })
        return
      }
      case 'air-quality-sensor':
        this.refreshAir(plan, now)
        return
      case 'power-meter':
        this.refreshMeter(plan, now)
        return
      case 'cover':
        this.refreshCover(now)
        return
      case 'lock-control': {
        const commanded = this.active('lock-control')
        const state = lockStateOf(
          asString(this.lastState[this.prop('lock-state') ?? '']),
          commanded,
        )
        if (state === null || this.getCapSlice(lockControlCapability)?.state === state) return
        this.setCapSlice(lockControlCapability, {
          state,
          codeRequired: null,
          lastChangedAt: now,
        })
        return
      }
      case 'climate-control':
        this.refreshClimate(plan, now)
        return
      case 'event-emitter':
        return
    }
  }

  private refreshAir(plan: Z2mPlan, now: number): void {
    const prev: AirQualitySensorStatus = this.getCapSlice(airQualitySensorCapability) ?? {
      lastFetchedAt: 0,
    }
    const next: {
      -readonly [K in keyof AirQualitySensorStatus]: AirQualitySensorStatus[K]
    } = { ...prev }
    let changed = false
    for (const field of AIR_FIELDS) {
      const value = this.number(plan.air[field] ?? null, AIR_QUANTITY[field])
      if (value === null || prev[field] === value) continue
      next[field] = Math.max(0, value)
      changed = true
    }
    if (changed)
      this.setCapSlice(airQualitySensorCapability, {
        ...next,
        lastFetchedAt: now,
      })
  }

  private refreshMeter(plan: Z2mPlan, now: number): void {
    const prev: PowerMeterStatus = this.getCapSlice(powerMeterCapability) ?? {
      lastFetchedAt: 0,
    }
    const next: {
      -readonly [K in keyof PowerMeterStatus]: PowerMeterStatus[K]
    } = { ...prev }
    let changed = false
    for (const field of METER_FIELDS) {
      const value = this.number(plan.meter[field] ?? null, METER_QUANTITY[field])
      if (value === null || prev[field] === value) continue
      next[field] = value
      changed = true
    }
    if (changed) this.setCapSlice(powerMeterCapability, { ...next, lastFetchedAt: now })
  }

  private refreshCover(now: number): void {
    const position = asNumber(this.lastState[this.prop('cover-position') ?? ''])
    const tilt = asNumber(this.lastState[this.prop('cover-tilt') ?? ''])
    const state = coverStateOf(asString(this.lastState[this.prop('cover-state') ?? '']), position)
    if (state === null) return
    const next = {
      state,
      position: position === null ? null : clamp(position, 0, 100),
      tiltPosition: tilt === null ? null : clamp(tilt, 0, 100),
      lastChangedAt: now,
    }
    const prior = this.getCapSlice(coverCapability)
    if (
      prior?.state === next.state &&
      prior.position === next.position &&
      prior.tiltPosition === next.tiltPosition
    ) {
      return
    }
    this.setCapSlice(coverCapability, next)
  }

  private refreshClimate(plan: Z2mPlan, now: number): void {
    const prior = this.getCapSlice(climateControlCapability)
    const reported = asString(this.lastState[this.prop('system-mode') ?? ''])
    const mode: HvacMode =
      reported !== null && isHvacMode(reported) ? reported : (prior?.mode ?? 'off')
    this.setCapSlice(climateControlCapability, {
      mode,
      availableModes: plan.climate.modes.filter(isHvacMode),
      fanMode: '',
      availableFanModes: [],
      preset: '',
      availablePresets: [],
      target: this.number(this.prop('setpoint'), 'temperature') ?? prior?.target ?? null,
      targetHigh: null,
      targetLow: null,
      targetHumidity: null,
      currentTemp:
        this.number(this.prop('current-temperature'), 'temperature') ?? prior?.currentTemp ?? null,
      currentHumidity: null,
      swingVertical: null,
      swingHorizontal: null,
      minTemp: plan.climate.min,
      maxTemp: plan.climate.max,
      tempStep: plan.climate.step,
      lastFetchedAt: now,
    })
  }

  /** A button press: only a message that CARRIED an `action` is an event, never a merged picture. */
  private fireAction(delta: Z2mState): void {
    const property = this.prop('event-emitter')
    if (property === null || this.plan === null) return
    const action = asString(delta[property])
    if (action === null || action === '') return
    const fire: EventFire = {
      deviceId: this.id,
      eventType: action,
      data: null,
      timestamp: Date.now(),
      seq: ++this.eventSeq,
    }
    this.ctx.eventBus.emit(
      createEvent(
        EventCategory.EventEmitted,
        {
          type: 'device',
          id: this.stableId,
          deviceId: this.id,
          addonId: this.ctx.deviceMeta.addonId,
        },
        fire,
      ),
    )
    const eventTypes = [...new Set([...this.plan.actions, action])]
    this.setCapSlice(eventEmitterCapability, {
      eventTypes,
      vocabulary: conventionalEventVocabulary(eventTypes),
      lastEvent: fire,
      eventCountSinceStart: ++this.eventCount,
    })
  }

  // ── Device → server ────────────────────────────────────────────────────

  /** Send `payload` to the device; the server answers with a state message, which updates the slice. */
  private command(payload: Readonly<Record<string, unknown>>): void {
    const session = z2mHub.session(this.persisted.integrationId)
    if (session === null) throw new Error('zigbee2mqtt: this integration has no connection')
    session.command(this.persisted.equipment, payload)
  }

  private commandProp(key: string, value: unknown): void {
    const property = this.prop(key)
    if (property === null) throw unsupported(key)
    this.command({ [property]: value })
  }

  /**
   * Every fact arrives pushed from the server (D224), so the core never schedules a read. The refresh
   * it can still ask for recomputes the slices from the last state the session holds, which recovers
   * a notification dropped on the way to the device.
   */
  private registerStateRefresh(): void {
    const { integrationId, equipment } = this.persisted
    this.ctx.registerNativeCap(
      deviceStateRefreshCapability,
      {
        refresh: async () => {
          const held = z2mHub.session(integrationId)?.stateOf(equipment)
          if (held !== null && held !== undefined) this.lastState = held
          this.refresh()
          return { ok: true }
        },
        resubscribe: async () => ({ ok: true }),
      },
      { stateRefresh: { integrationId, minIntervalMs: 1_000, batch: false, push: 'full' } },
    )
  }

  // ── Registration ───────────────────────────────────────────────────────

  private registerPlanCaps(): void {
    if (this.plan === null) return
    for (const cap of this.plan.capabilities) {
      if (this.registered.has(cap)) continue
      this.registered.add(cap)
      this.registerCap(cap, this.plan)
    }
  }

  private registerStatusOnly<C extends Parameters<DeviceContext['registerNativeCap']>[0]>(
    cap: C,
    provider: InferNativeProvider<C>,
    cold: InferRuntimeState<C> & Record<string, unknown>,
  ): void {
    this.ctx.registerNativeCap(cap, provider)
    if (this.getCapSlice(cap) === null) this.setCapSlice(cap, cold)
  }

  private registerCap(cap: Z2mCap, plan: Z2mPlan): void {
    switch (cap) {
      case 'switch': {
        const COLD = { on: null, lastChangedAt: 0 }
        return this.registerStatusOnly(
          switchCapability,
          {
            getStatus: async () => this.getCapSlice(switchCapability) ?? COLD,
            setState: async ({ on }) => {
              const values = plan.binary['switch']
              if (values === undefined) throw unsupported('switching')
              this.commandProp('switch', on ? values.on : values.off)
            },
          },
          COLD,
        )
      }
      case 'brightness': {
        const COLD = { level: 0, lastChangedAt: 0 }
        return this.registerStatusOnly(
          brightnessCapability,
          {
            getStatus: async () => this.getCapSlice(brightnessCapability) ?? COLD,
            setBrightness: async ({ level }) => {
              this.commandProp(
                'brightness',
                Math.round((level / 100) * (plan.range.brightnessMax ?? 254)),
              )
            },
          },
          COLD,
        )
      }
      case 'color': {
        const COLD = { mode: 'mired' as const, lastChangedAt: 0 }
        return this.registerStatusOnly(
          colorCapability,
          {
            getStatus: async () => this.getCapSlice(colorCapability) ?? COLD,
            setColor: async ({ color }) => {
              if (color.mode !== 'mired') throw unsupported(`${color.mode} colour`)
              const { colorTempMin: min, colorTempMax: max } = plan.range
              this.commandProp(
                'color',
                clamp(color.colorTemperature, min ?? 0, max ?? Number.MAX_SAFE_INTEGER),
              )
            },
          },
          COLD,
        )
      }
      case 'cover':
        return this.registerCover(plan)
      case 'lock-control': {
        const COLD = {
          state: 'unlocked' as const,
          codeRequired: null,
          lastChangedAt: 0,
        }
        const send = async (locked: boolean): Promise<void> => {
          const values = plan.binary['lock-control']
          if (values === undefined) throw unsupported('locking')
          this.commandProp('lock-control', locked ? values.on : values.off)
        }
        return this.registerStatusOnly(
          lockControlCapability,
          {
            getStatus: async () => this.getCapSlice(lockControlCapability) ?? COLD,
            lock: async () => send(true),
            unlock: async () => send(false),
          },
          COLD,
        )
      }
      case 'climate-control':
        return this.registerClimate(plan)
      case 'event-emitter': {
        const COLD: EventEmitterStatus = {
          eventTypes: [...plan.actions],
          vocabulary: conventionalEventVocabulary(plan.actions),
          lastEvent: null,
          eventCountSinceStart: 0,
        }
        return this.registerStatusOnly(
          eventEmitterCapability,
          {
            getStatus: async () => this.getCapSlice(eventEmitterCapability) ?? COLD,
          },
          COLD,
        )
      }
      case 'power-meter':
        return this.registerStatusOnly(
          powerMeterCapability,
          {
            getStatus: async () => this.getCapSlice(powerMeterCapability) ?? { lastFetchedAt: 0 },
          },
          { lastFetchedAt: 0 },
        )
      case 'air-quality-sensor':
        return this.registerStatusOnly(
          airQualitySensorCapability,
          {
            getStatus: async () =>
              this.getCapSlice(airQualitySensorCapability) ?? {
                lastFetchedAt: 0,
              },
          },
          { lastFetchedAt: 0 },
        )
      case 'battery':
        return this.registerStatusOnly(
          batteryCapability,
          {
            getStatus: async () => this.getCapSlice(batteryCapability) ?? COLD_BATTERY,
          },
          COLD_BATTERY,
        )
      case 'contact': {
        const COLD = { entryOpen: false, lastChangedAt: 0 }
        return this.registerStatusOnly(
          contactCapability,
          {
            getStatus: async () => this.getCapSlice(contactCapability) ?? COLD,
          },
          COLD,
        )
      }
      case 'motion': {
        const COLD = {
          detected: false,
          lastDetectedAt: null,
          autoClearAfterMs: null,
        }
        return this.registerStatusOnly(
          motionCapability,
          {
            getStatus: async () => this.getCapSlice(motionCapability) ?? COLD,
            isDetected: async () => this.getCapSlice(motionCapability)?.detected === true,
          },
          COLD,
        )
      }
      case 'flood': {
        const COLD = { flooded: false, lastChangedAt: 0 }
        return this.registerStatusOnly(
          floodCapability,
          { getStatus: async () => this.getCapSlice(floodCapability) ?? COLD },
          COLD,
        )
      }
      case 'smoke': {
        const COLD = { detected: false, lastChangedAt: 0 }
        return this.registerStatusOnly(
          smokeCapability,
          { getStatus: async () => this.getCapSlice(smokeCapability) ?? COLD },
          COLD,
        )
      }
      case 'vibration': {
        const COLD = { detected: false, lastChangedAt: 0 }
        return this.registerStatusOnly(
          vibrationCapability,
          {
            getStatus: async () => this.getCapSlice(vibrationCapability) ?? COLD,
          },
          COLD,
        )
      }
      case 'tamper': {
        const COLD = { tampered: false, lastChangedAt: 0 }
        return this.registerStatusOnly(
          tamperCapability,
          { getStatus: async () => this.getCapSlice(tamperCapability) ?? COLD },
          COLD,
        )
      }
      case 'temperature-sensor': {
        const COLD = { temperature: null, lastFetchedAt: 0 }
        return this.registerStatusOnly(
          temperatureSensorCapability,
          {
            getStatus: async () => this.getCapSlice(temperatureSensorCapability) ?? COLD,
          },
          COLD,
        )
      }
      case 'humidity-sensor': {
        const COLD = { humidity: null, lastFetchedAt: 0 }
        return this.registerStatusOnly(
          humiditySensorCapability,
          {
            getStatus: async () => this.getCapSlice(humiditySensorCapability) ?? COLD,
          },
          COLD,
        )
      }
      case 'pressure-sensor': {
        const COLD = { pressure: null, lastFetchedAt: 0 }
        return this.registerStatusOnly(
          pressureSensorCapability,
          {
            getStatus: async () => this.getCapSlice(pressureSensorCapability) ?? COLD,
          },
          COLD,
        )
      }
      case 'ambient-light-sensor': {
        const COLD = { illuminance: null, lastFetchedAt: 0 }
        return this.registerStatusOnly(
          ambientLightSensorCapability,
          {
            getStatus: async () => this.getCapSlice(ambientLightSensorCapability) ?? COLD,
          },
          COLD,
        )
      }
    }
  }

  private registerCover(plan: Z2mPlan): void {
    const COLD = {
      state: 'stopped' as const,
      position: null,
      tiltPosition: null,
      lastChangedAt: 0,
    }
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.getCapSlice(coverCapability) ?? COLD,
      open: async () => this.commandProp('cover-state', 'OPEN'),
      close: async () => this.commandProp('cover-state', 'CLOSE'),
      stop: async () => this.commandProp('cover-state', 'STOP'),
      ...(plan.cover.positionable
        ? {
            setPosition: async ({ position }: { position: number }) =>
              this.commandProp('cover-position', position),
          }
        : {}),
    }
    this.registerStatusOnly(coverCapability, provider, COLD)
  }

  private registerClimate(plan: Z2mPlan): void {
    const COLD = {
      mode: 'off' as const,
      availableModes: [],
      fanMode: '',
      availableFanModes: [],
      preset: '',
      availablePresets: [],
      target: null,
      targetHigh: null,
      targetLow: null,
      targetHumidity: null,
      currentTemp: null,
      currentHumidity: null,
      swingVertical: null,
      swingHorizontal: null,
      lastFetchedAt: 0,
    }
    const provider: InferNativeProvider<typeof climateControlCapability> = {
      getStatus: async () => this.getCapSlice(climateControlCapability) ?? COLD,
      setMode: async ({ mode }) => {
        if (!plan.climate.modes.includes(mode)) throw unsupported(`mode ${mode}`)
        this.commandProp('system-mode', mode)
      },
      setTarget: async ({ target }) => this.commandProp('setpoint', target),
      setFanMode: async () => {
        throw unsupported('fan mode')
      },
      setPreset: async () => {
        throw unsupported('presets')
      },
      setTargetRange: async () => {
        throw unsupported('a target range')
      },
      setTargetHumidity: async () => {
        throw unsupported('a humidity target')
      },
      setSwingVertical: async () => {
        throw unsupported('swing')
      },
      setSwingHorizontal: async () => {
        throw unsupported('swing')
      },
    }
    this.registerStatusOnly(climateControlCapability, provider, COLD)
  }
}

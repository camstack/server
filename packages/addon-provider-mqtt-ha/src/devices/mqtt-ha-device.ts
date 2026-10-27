import {
  BaseDevice,
  EventCategory,
  HvacModeSchema,
  ambientLightSensorCapability,
  batteryCapability,
  brightnessCapability,
  climateControlCapability,
  colorCapability,
  contactCapability,
  createEvent,
  eventEmitterCapability,
  floodCapability,
  humiditySensorCapability,
  ingestReading,
  motionCapability,
  numericSensorCapability,
  powerMeterCapability,
  quantityFromUnit,
  switchCapability,
  tamperCapability,
  temperatureSensorCapability,
  vibrationCapability,
  type DeviceContext,
  type DeviceFeature,
  type EventEmitterStatus,
  type EventFire,
  type HvacMode,
  type InferNativeProvider,
  type InferRuntimeState,
  type PowerMeterStatus,
  type ReadingQuantity,
} from '@camstack/types'
import {
  decodeBoolean,
  decodeClimate,
  decodeEvent,
  decodeLight,
  decodeNumber,
  evaluateAvailability,
  lightCommandPayload,
  type MqttHaLightChange,
} from '../mqtt-ha-entity-codec.js'
import type { MqttHaEntity } from '../mqtt-ha-discovery-types.js'
import type { MqttHaCap, MqttHaMeterField } from '../mqtt-ha-domain-mapping.js'
import { mqttHaStateGateway } from '../mqtt-ha-state-gateway.js'
import {
  mqttHaDeviceSchema,
  resolveDeviceModel,
  type MqttHaDeviceModel,
} from './mqtt-ha-device-config.js'

export { mqttHaDeviceSchema, type MqttHaDeviceConfig } from './mqtt-ha-device-config.js'

const METER_QUANTITY: Readonly<Record<MqttHaMeterField, ReadingQuantity>> = {
  watts: 'power',
  kwhTotal: 'energy',
  volts: 'voltage',
  amps: 'current',
}

const METER_FIELDS: readonly MqttHaMeterField[] = ['watts', 'kwhTotal', 'volts', 'amps']

function unsupported(what: string): Error {
  return new Error(`mqtt-ha: ${what} is not supported by this device`)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function isHvacMode(value: string): value is HvacMode {
  return HvacModeSchema.safeParse(value).success
}

/**
 * One adopted MQTT HA device: a physical device (every entity of one discovery
 * `device` block) or one lone entity. Its primary function picks the device
 * type; the rest are caps of the same device — battery, and power / energy /
 * voltage / current folded into `power-meter` (D951). Payloads are decoded
 * with each entity's own value template, so a JSON state topic (zigbee2mqtt)
 * and a plain one (a bare switch) are the same code path.
 */
export class MqttHaDevice extends BaseDevice<typeof mqttHaDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly brokerId: string
  private readonly model: MqttHaDeviceModel
  private eventSeq = 0
  private eventCount = 0

  constructor(ctx: DeviceContext) {
    const persisted = mqttHaDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, mqttHaDeviceSchema, { type: ctx.deviceMeta.type })
    this.brokerId = persisted.brokerId
    this.model = resolveDeviceModel(persisted)
    this.online = true
    void this.updateSourceInfo({
      id: persisted.deviceKey ?? persisted.entityKey,
      system: 'mqtt-ha',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    for (const cap of this.model.capabilities) this.registerCap(cap)
    for (const entity of this.model.entities.values()) {
      mqttHaStateGateway.subscribeEntity(this.brokerId, entity.entityKey, (topic, payload) =>
        this.onMessage(entity, topic, payload),
      )
    }
    this.refresh()
  }

  // ── Inbound ────────────────────────────────────────────────────────────

  private onMessage(entity: MqttHaEntity, _topic: string, payload: string): void {
    if (entity.component === 'event') this.fireEvent(entity, payload)
    this.refresh()
  }

  private reader() {
    return mqttHaStateGateway.readerFor(this.brokerId)
  }

  private payloadOf(entity: MqttHaEntity): string | undefined {
    return this.reader()(entity.stateTopic)
  }

  private bound(cap: MqttHaCap): MqttHaEntity | null {
    const key = this.model.bindings.get(cap)
    return key === undefined ? null : (this.model.entities.get(key) ?? null)
  }

  /** Recompute every slice from the last payloads; unchanged ones are not rewritten. */
  private refresh(): void {
    for (const cap of this.model.capabilities) this.refreshCap(cap)
    this.refreshAvailability()
  }

  private refreshAvailability(): void {
    for (const entity of this.model.entities.values()) {
      const available = evaluateAvailability(entity, this.reader())
      if (available !== null) {
        this.markOnline(available)
        return
      }
    }
  }

  private take(value: number, unit: string | null, quantity: ReadingQuantity): number | null {
    const result = ingestReading({ value, rawUnit: unit ?? undefined, quantity })
    if (result.ok) return result.value
    this.ctx.logger.warn('numeric reading refused', {
      tags: { deviceId: this.id },
      meta: { quantity, unit: unit ?? '', reason: result.reason },
    })
    return null
  }

  private numberOf(entity: MqttHaEntity, quantity: ReadingQuantity): number | null {
    const payload = this.payloadOf(entity)
    if (payload === undefined) return null
    const value = decodeNumber(entity, payload)
    return value === null ? null : this.take(value, entity.unitOfMeasurement, quantity)
  }

  private activeOf(entity: MqttHaEntity): boolean | null {
    const payload = this.payloadOf(entity)
    if (payload === undefined) return null
    if (entity.component === 'light' && entity.light?.json === true) {
      return decodeLight(entity, payload)?.on ?? null
    }
    return decodeBoolean(entity, payload)
  }

  private refreshCap(cap: MqttHaCap): void {
    const now = Date.now()
    switch (cap) {
      case 'switch': {
        const entity = this.bound('switch')
        const on = entity === null ? null : this.activeOf(entity)
        if (on === null || this.getCapSlice(switchCapability)?.on === on) return
        this.setCapSlice(switchCapability, { on, lastChangedAt: now })
        return
      }
      case 'brightness': {
        const entity = this.bound('brightness')
        const payload = entity === null ? undefined : this.payloadOf(entity)
        const pct =
          entity === null || payload === undefined
            ? null
            : decodeLight(entity, payload)?.brightnessPct
        if (pct === null || pct === undefined) return
        const percentage = clamp(pct, 0, 100)
        if (this.getCapSlice(brightnessCapability)?.percentage === percentage) return
        this.setCapSlice(brightnessCapability, { percentage, lastChangedAt: now })
        return
      }
      case 'color': {
        const entity = this.bound('color')
        const payload = entity === null ? undefined : this.payloadOf(entity)
        const mireds =
          entity === null || payload === undefined ? null : decodeLight(entity, payload)?.mireds
        if (mireds === null || mireds === undefined) return
        const rounded = Math.round(mireds)
        if (this.getCapSlice(colorCapability)?.mireds === rounded) return
        this.setCapSlice(colorCapability, { mode: 'mired', mireds: rounded, lastChangedAt: now })
        return
      }
      case 'power-meter':
        this.refreshMeter(now)
        return
      case 'battery': {
        const entity = this.bound('battery')
        const value = entity === null ? null : this.numberOf(entity, 'percentage')
        if (value === null) return
        const percentage = clamp(value, 0, 100)
        if (this.getCapSlice(batteryCapability)?.percentage === percentage) return
        this.setCapSlice(batteryCapability, {
          percentage,
          charging: 'unknown',
          sleeping: false,
          lastUpdated: now,
        })
        return
      }
      case 'contact':
      case 'motion':
      case 'flood':
      case 'vibration':
      case 'tamper':
        this.refreshBinary(cap, now)
        return
      case 'temperature-sensor': {
        const entity = this.bound(cap)
        const celsius = entity === null ? null : this.numberOf(entity, 'temperature')
        if (celsius === null) return
        this.setCapSlice(temperatureSensorCapability, { celsius, lastFetchedAt: now })
        return
      }
      case 'humidity-sensor': {
        const entity = this.bound(cap)
        const percent = entity === null ? null : this.numberOf(entity, 'humidity')
        if (percent === null) return
        this.setCapSlice(humiditySensorCapability, {
          percent: clamp(percent, 0, 100),
          lastFetchedAt: now,
        })
        return
      }
      case 'ambient-light-sensor': {
        const entity = this.bound(cap)
        const lux = entity === null ? null : this.numberOf(entity, 'illuminance')
        if (lux === null) return
        this.setCapSlice(ambientLightSensorCapability, {
          lux: Math.max(0, lux),
          lastFetchedAt: now,
        })
        return
      }
      case 'numeric-sensor': {
        const entity = this.bound(cap)
        if (entity === null) return
        const quantity = learnQuantity(entity.unitOfMeasurement)
        const value = quantity === null ? null : this.numberOf(entity, quantity)
        if (value === null) return
        this.setCapSlice(numericSensorCapability, { value, lastFetchedAt: now })
        return
      }
      case 'climate-control':
        this.refreshClimate(now)
        return
      case 'event-emitter':
        return
    }
  }

  private refreshMeter(now: number): void {
    const prev: PowerMeterStatus = this.getCapSlice(powerMeterCapability) ?? { lastFetchedAt: 0 }
    const next: { -readonly [K in keyof PowerMeterStatus]: PowerMeterStatus[K] } = { ...prev }
    let changed = false
    for (const field of METER_FIELDS) {
      const entityKey = this.model.meter[field]
      const entity = entityKey === undefined ? undefined : this.model.entities.get(entityKey)
      if (entity === undefined) continue
      const value = this.numberOf(entity, METER_QUANTITY[field])
      if (value === null || prev[field] === value) continue
      next[field] = value
      changed = true
    }
    if (!changed) return
    this.setCapSlice(powerMeterCapability, { ...next, lastFetchedAt: now })
  }

  private refreshBinary(
    cap: 'contact' | 'motion' | 'flood' | 'vibration' | 'tamper',
    now: number,
  ): void {
    const entity = this.bound(cap)
    const active = entity === null ? null : this.activeOf(entity)
    if (active === null) return
    switch (cap) {
      case 'contact': {
        const prior = this.getCapSlice(contactCapability)
        if (prior?.entryOpen === active) return
        this.setCapSlice(contactCapability, { entryOpen: active, lastChangedAt: now })
        return
      }
      case 'motion': {
        const prior = this.getCapSlice(motionCapability)
        if (prior?.detected === active) return
        this.setCapSlice(motionCapability, {
          detected: active,
          lastDetectedAt: active ? now : (prior?.lastDetectedAt ?? null),
          autoClearAfterMs: null,
        })
        return
      }
      case 'flood': {
        if (this.getCapSlice(floodCapability)?.flooded === active) return
        this.setCapSlice(floodCapability, { flooded: active, lastChangedAt: now })
        return
      }
      case 'vibration': {
        if (this.getCapSlice(vibrationCapability)?.detected === active) return
        this.setCapSlice(vibrationCapability, { detected: active, lastChangedAt: now })
        return
      }
      case 'tamper': {
        if (this.getCapSlice(tamperCapability)?.tampered === active) return
        this.setCapSlice(tamperCapability, { tampered: active, lastChangedAt: now })
        return
      }
    }
  }

  private refreshClimate(now: number): void {
    const entity = this.bound('climate-control')
    if (entity === null) return
    const reading = decodeClimate(entity, this.reader())
    const prior = this.getCapSlice(climateControlCapability)
    const climate = entity.climate
    const modes = (climate?.modes ?? []).filter(isHvacMode)
    const mode =
      reading.mode !== null && isHvacMode(reading.mode) ? reading.mode : (prior?.mode ?? 'off')
    this.setCapSlice(climateControlCapability, {
      mode,
      availableModes: modes,
      fanMode: prior?.fanMode ?? '',
      availableFanModes: [],
      preset: prior?.preset ?? '',
      availablePresets: [],
      target: reading.target ?? prior?.target ?? null,
      targetHigh: null,
      targetLow: null,
      targetHumidity: null,
      currentTemp: reading.currentTemp ?? prior?.currentTemp ?? null,
      currentHumidity: null,
      swingVertical: null,
      swingHorizontal: null,
      minTemp: climate?.minTemp ?? null,
      maxTemp: climate?.maxTemp ?? null,
      tempStep: climate?.tempStep ?? null,
      lastFetchedAt: now,
    })
  }

  private fireEvent(entity: MqttHaEntity, payload: string): void {
    const decoded = decodeEvent(entity, payload)
    if (decoded === null) return
    const fire: EventFire = {
      deviceId: this.id,
      eventType: decoded.eventType,
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
    this.setCapSlice(eventEmitterCapability, {
      eventTypes: [...entity.eventTypes],
      lastEvent: fire,
      eventCountSinceStart: ++this.eventCount,
    })
  }

  // ── Outbound ───────────────────────────────────────────────────────────

  private async command(
    entity: MqttHaEntity,
    topic: string | null,
    payload: string,
  ): Promise<void> {
    if (topic === null) throw new Error(`mqtt-ha: entity ${entity.entityKey} has no command topic`)
    await mqttHaStateGateway.publish(this.brokerId, topic, payload)
  }

  private lightEntity(): MqttHaEntity {
    const entity = this.bound('switch')
    if (entity === null) throw unsupported('light control')
    return entity
  }

  private async lightCommand(change: MqttHaLightChange): Promise<void> {
    const entity = this.lightEntity()
    await this.command(entity, entity.commandTopic, lightCommandPayload(entity, change))
  }

  // ── Registration ───────────────────────────────────────────────────────

  private registerCap(cap: MqttHaCap): void {
    switch (cap) {
      case 'switch':
        return this.registerSwitch()
      case 'brightness':
        return this.registerBrightness()
      case 'color':
        return this.registerColor()
      case 'power-meter':
        return this.registerStatusOnly(
          powerMeterCapability,
          { getStatus: async () => this.getCapSlice(powerMeterCapability) ?? { lastFetchedAt: 0 } },
          { lastFetchedAt: 0 },
        )
      case 'battery':
        return this.registerStatusOnly(
          batteryCapability,
          {
            getStatus: async () => this.getCapSlice(batteryCapability) ?? COLD_BATTERY,
            wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
          },
          COLD_BATTERY,
        )
      case 'contact':
        return this.registerStatusOnly(
          contactCapability,
          { getStatus: async () => this.getCapSlice(contactCapability) ?? COLD_CONTACT },
          COLD_CONTACT,
        )
      case 'motion':
        return this.registerMotion()
      case 'flood':
        return this.registerStatusOnly(
          floodCapability,
          { getStatus: async () => this.getCapSlice(floodCapability) ?? COLD_FLOOD },
          COLD_FLOOD,
        )
      case 'vibration':
        return this.registerStatusOnly(
          vibrationCapability,
          { getStatus: async () => this.getCapSlice(vibrationCapability) ?? COLD_VIBRATION },
          COLD_VIBRATION,
        )
      case 'tamper':
        return this.registerStatusOnly(
          tamperCapability,
          { getStatus: async () => this.getCapSlice(tamperCapability) ?? COLD_TAMPER },
          COLD_TAMPER,
        )
      case 'temperature-sensor':
        return this.registerStatusOnly(
          temperatureSensorCapability,
          {
            getStatus: async () =>
              this.getCapSlice(temperatureSensorCapability) ?? { celsius: null, lastFetchedAt: 0 },
          },
          { celsius: null, lastFetchedAt: 0 },
        )
      case 'humidity-sensor':
        return this.registerStatusOnly(
          humiditySensorCapability,
          {
            getStatus: async () =>
              this.getCapSlice(humiditySensorCapability) ?? { percent: null, lastFetchedAt: 0 },
          },
          { percent: null, lastFetchedAt: 0 },
        )
      case 'ambient-light-sensor':
        return this.registerStatusOnly(
          ambientLightSensorCapability,
          {
            getStatus: async () =>
              this.getCapSlice(ambientLightSensorCapability) ?? { lux: null, lastFetchedAt: 0 },
          },
          { lux: null, lastFetchedAt: 0 },
        )
      case 'numeric-sensor':
        return this.registerStatusOnly(
          numericSensorCapability,
          {
            getStatus: async () =>
              this.getCapSlice(numericSensorCapability) ?? { value: 0, lastFetchedAt: 0 },
          },
          { value: 0, lastFetchedAt: 0 },
        )
      case 'climate-control':
        return this.registerClimate()
      case 'event-emitter':
        return this.registerEventEmitter()
    }
  }

  /** Register a read-only cap and seed its slice unless one was restored. */
  private registerStatusOnly<C extends Parameters<DeviceContext['registerNativeCap']>[0]>(
    cap: C,
    provider: InferNativeProvider<C>,
    cold: InferRuntimeState<C> & Record<string, unknown>,
  ): void {
    this.ctx.registerNativeCap(cap, provider)
    if (this.getCapSlice(cap) === null) this.setCapSlice(cap, cold)
  }

  private registerSwitch(): void {
    const COLD = { on: false, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.getCapSlice(switchCapability) ?? COLD,
      setState: async ({ on }) => {
        const entity = this.bound('switch')
        if (entity === null) throw unsupported('switching')
        const payload =
          entity.component === 'light' && entity.light?.json === true
            ? lightCommandPayload(entity, { on })
            : on
              ? entity.payloadOn
              : entity.payloadOff
        await this.command(entity, entity.commandTopic, payload)
        this.setCapSlice(switchCapability, { on, lastChangedAt: Date.now() })
      },
    }
    this.registerStatusOnly(switchCapability, provider, COLD)
  }

  private registerBrightness(): void {
    const COLD = { percentage: 0, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof brightnessCapability> = {
      getStatus: async () => this.getCapSlice(brightnessCapability) ?? COLD,
      setBrightness: async ({ percentage }) => {
        await this.lightCommand({ brightnessPct: percentage })
        this.setCapSlice(brightnessCapability, { percentage, lastChangedAt: Date.now() })
      },
    }
    this.registerStatusOnly(brightnessCapability, provider, COLD)
  }

  private registerColor(): void {
    const COLD = { mode: 'mired' as const, lastChangedAt: 0 }
    const provider: InferNativeProvider<typeof colorCapability> = {
      getStatus: async () => this.getCapSlice(colorCapability) ?? COLD,
      setColor: async ({ color }) => {
        if (color.mode === 'mired') await this.lightCommand({ mireds: color.mireds })
        else if (color.mode === 'rgb') await this.lightCommand({ rgb: color.rgb })
        else await this.lightCommand({ hsv: { h: color.hsv.h, s: color.hsv.s } })
      },
    }
    this.registerStatusOnly(colorCapability, provider, COLD)
  }

  private registerMotion(): void {
    const COLD = { detected: false, lastDetectedAt: null, autoClearAfterMs: null }
    const provider: InferNativeProvider<typeof motionCapability> = {
      getStatus: async () => this.getCapSlice(motionCapability) ?? COLD,
      isDetected: async () => this.getCapSlice(motionCapability)?.detected === true,
    }
    this.registerStatusOnly(motionCapability, provider, COLD)
  }

  private registerClimate(): void {
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
        const entity = this.bound('climate-control')
        const topic = entity?.climate?.modeCommandTopic ?? null
        if (entity === null) throw unsupported('climate control')
        await this.command(entity, topic, mode)
      },
      setTarget: async ({ target }) => {
        const entity = this.bound('climate-control')
        if (entity === null) throw unsupported('climate control')
        await this.command(entity, entity.climate?.temperatureCommandTopic ?? null, String(target))
      },
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

  private registerEventEmitter(): void {
    const entity = this.bound('event-emitter')
    const COLD: EventEmitterStatus = {
      eventTypes: entity === null ? [] : [...entity.eventTypes],
      lastEvent: null,
      eventCountSinceStart: 0,
    }
    const provider: InferNativeProvider<typeof eventEmitterCapability> = {
      getStatus: async () => this.getCapSlice(eventEmitterCapability) ?? COLD,
    }
    this.registerStatusOnly(eventEmitterCapability, provider, COLD)
  }
}

const COLD_BATTERY = {
  percentage: null,
  charging: 'unknown' as const,
  sleeping: false,
  lastUpdated: 0,
}
const COLD_CONTACT = { entryOpen: false, lastChangedAt: 0 }
const COLD_FLOOD = { flooded: false, lastChangedAt: 0 }
const COLD_VIBRATION = { detected: false, lastChangedAt: 0 }
const COLD_TAMPER = { tampered: false, lastChangedAt: 0 }

function learnQuantity(unit: string | null): ReadingQuantity | null {
  if (unit === null) return 'none'
  const learned = quantityFromUnit(unit)
  if (learned === undefined || learned === 'device') return null
  return learned
}

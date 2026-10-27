import {
  binaryCapability,
  contactCapability,
  enumSensorCapability,
  floodCapability,
  motionCapability,
  numericSensorCapability,
  powerMeterCapability,
  quantityFromUnit,
  smokeCapability,
  type BinaryStatus,
  type ContactStatus,
  type DeviceContext,
  type EnumSensorStatus,
  type FloodStatus,
  type InferNativeProvider,
  type MotionStatus,
  type NumericSensorStatus,
  type PowerMeterStatus,
  type ReadingQuantity,
  type SmokeStatus,
} from '@camstack/types'
import { decodeBinary, decodeNumber, decodeText } from '../esphome-decode.js'
import { takeReading } from '../esphome-reading.js'
import type { EspState } from '../esphome-link.js'
import { EspChildDevice, stampOnChange, type EspStateOrigin } from './esp-child-device.js'

type PowerField = keyof Pick<
  PowerMeterStatus,
  'watts' | 'kwhTotal' | 'volts' | 'amps' | 'va' | 'powerFactor'
>

/** The quantity each power-meter field is stored in (a power factor is a plain ratio). */
const POWER_FIELD_QUANTITY: Readonly<Record<string, ReadingQuantity | null>> = {
  watts: 'power',
  kwhTotal: 'energy',
  volts: 'voltage',
  amps: 'current',
  va: 'apparent-power',
  powerFactor: null,
}

const COLD_NUMERIC: NumericSensorStatus = { value: null, lastFetchedAt: 0 }
const COLD_ENUM: EnumSensorStatus = { value: '', lastFetchedAt: 0 }
const COLD_BINARY: BinaryStatus = { on: false, lastChangedAt: 0 }
const COLD_CONTACT: ContactStatus = { entryOpen: false, lastChangedAt: 0 }
const COLD_FLOOD: FloodStatus = { flooded: false, lastChangedAt: 0 }
const COLD_SMOKE: SmokeStatus = { detected: false, lastChangedAt: 0 }
const COLD_MOTION: MotionStatus = { detected: false, lastDetectedAt: null, autoClearAfterMs: null }
const COLD_POWER: PowerMeterStatus = { lastFetchedAt: 0 }

function isPowerField(field: string): field is PowerField {
  return field in POWER_FIELD_QUANTITY
}

/**
 * The read-only ESPHome children: numeric / text sensors, the binary sensors by
 * device class, and the `power-meter` that folds a board's power, energy,
 * voltage and current sensors into one device. A sample that cannot be read
 * (missing, non-finite, unknown unit) leaves the slice as it was: a failed
 * measurement is never 0.
 */
export class EspSensorDevice extends EspChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerCap()
    this.attach()
  }

  protected ownedEntityIds(): readonly string[] {
    if (this.child.kind === 'power-meter') return Object.values(this.child.slots ?? {})
    return this.child.entityId === undefined ? [] : [this.child.entityId]
  }

  private registerCap(): void {
    switch (this.child.kind) {
      case 'numeric-sensor': {
        const provider: InferNativeProvider<typeof numericSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor') ?? COLD_NUMERIC,
        }
        this.ctx.registerNativeCap(numericSensorCapability, provider)
        this.runtimeState.setCapState('numeric-sensor', COLD_NUMERIC)
        return
      }
      case 'enum-sensor': {
        const provider: InferNativeProvider<typeof enumSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<EnumSensorStatus>('enum-sensor') ?? COLD_ENUM,
        }
        this.ctx.registerNativeCap(enumSensorCapability, provider)
        this.runtimeState.setCapState('enum-sensor', COLD_ENUM)
        return
      }
      case 'binary': {
        const provider: InferNativeProvider<typeof binaryCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<BinaryStatus>('binary') ?? COLD_BINARY,
        }
        this.ctx.registerNativeCap(binaryCapability, provider)
        this.runtimeState.setCapState('binary', COLD_BINARY)
        return
      }
      case 'contact': {
        const provider: InferNativeProvider<typeof contactCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<ContactStatus>('contact') ?? COLD_CONTACT,
        }
        this.ctx.registerNativeCap(contactCapability, provider)
        this.runtimeState.setCapState('contact', COLD_CONTACT)
        return
      }
      case 'flood': {
        const provider: InferNativeProvider<typeof floodCapability> = {
          getStatus: async () => this.runtimeState.getCapState<FloodStatus>('flood') ?? COLD_FLOOD,
        }
        this.ctx.registerNativeCap(floodCapability, provider)
        this.runtimeState.setCapState('flood', COLD_FLOOD)
        return
      }
      case 'smoke': {
        const provider: InferNativeProvider<typeof smokeCapability> = {
          getStatus: async () => this.runtimeState.getCapState<SmokeStatus>('smoke') ?? COLD_SMOKE,
        }
        this.ctx.registerNativeCap(smokeCapability, provider)
        this.runtimeState.setCapState('smoke', COLD_SMOKE)
        return
      }
      case 'motion': {
        const provider: InferNativeProvider<typeof motionCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<MotionStatus>('motion') ?? COLD_MOTION,
          isDetected: async () =>
            (this.runtimeState.getCapState<MotionStatus>('motion') ?? COLD_MOTION).detected,
        }
        this.ctx.registerNativeCap(motionCapability, provider)
        this.runtimeState.setCapState('motion', COLD_MOTION)
        return
      }
      case 'power-meter': {
        const provider: InferNativeProvider<typeof powerMeterCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_POWER,
        }
        this.ctx.registerNativeCap(powerMeterCapability, provider)
        this.runtimeState.setCapState('power-meter', COLD_POWER)
        return
      }
      default:
        return
    }
  }

  protected applyState(state: EspState, _origin: EspStateOrigin): void {
    const now = Date.now()
    switch (this.child.kind) {
      case 'numeric-sensor':
        if (state.type === 'sensor') this.applyNumeric(state, now)
        return
      case 'enum-sensor':
        if (state.type === 'text_sensor') this.applyEnum(state, now)
        return
      case 'power-meter':
        if (state.type === 'sensor') this.applyPower(state, now)
        return
      default:
        if (state.type === 'binary_sensor') this.applyBinary(decodeBinary(state), now)
        return
    }
  }

  private applyNumeric(state: Extract<EspState, { type: 'sensor' }>, now: number): void {
    const quantity = quantityFromUnit(this.child.unit)
    if (quantity === undefined) {
      // A sensor with no known unit has no quantity to convert into; publish nothing.
      this.ctx.logger.warn('esphome: sensor unit has no known quantity — reading skipped', {
        tags: { deviceId: this.id },
        meta: { unit: this.child.unit ?? '' },
      })
      return
    }
    if (this.sourceInfo.quantity !== quantity) void this.updateSourceInfo({ quantity })
    const value = takeReading(
      this.ctx.logger,
      this.id,
      decodeNumber(state),
      this.child.unit,
      quantity,
    )
    if (value === null) return
    this.runtimeState.setCapState('numeric-sensor', { value, lastFetchedAt: now })
  }

  private applyEnum(state: Extract<EspState, { type: 'text_sensor' }>, now: number): void {
    const value = decodeText(state)
    if (value === null) return
    this.runtimeState.setCapState('enum-sensor', { value, lastFetchedAt: now })
  }

  private applyPower(state: Extract<EspState, { type: 'sensor' }>, now: number): void {
    const field = Object.entries(this.child.slots ?? {}).find(([, id]) => id === state.id)?.[0]
    if (field === undefined || !isPowerField(field)) return
    const quantity = POWER_FIELD_QUANTITY[field]
    const raw = decodeNumber(state)
    const unit = this.child.slotUnits?.[field]
    const value =
      quantity === null || quantity === undefined
        ? raw
        : takeReading(this.ctx.logger, this.id, raw, unit, quantity)
    if (value === null) return
    const prev = this.runtimeState.getCapState<PowerMeterStatus>('power-meter') ?? COLD_POWER
    this.runtimeState.setCapState('power-meter', { ...prev, [field]: value, lastFetchedAt: now })
  }

  private applyBinary(on: boolean, now: number): void {
    switch (this.child.kind) {
      case 'binary': {
        const prev = this.runtimeState.getCapState<BinaryStatus>('binary') ?? COLD_BINARY
        this.runtimeState.setCapState('binary', {
          on,
          lastChangedAt: stampOnChange(prev.lastChangedAt, prev.on !== on, now),
        })
        return
      }
      case 'contact': {
        const prev = this.runtimeState.getCapState<ContactStatus>('contact') ?? COLD_CONTACT
        this.runtimeState.setCapState('contact', {
          entryOpen: on,
          lastChangedAt: stampOnChange(prev.lastChangedAt, prev.entryOpen !== on, now),
        })
        return
      }
      case 'flood': {
        const prev = this.runtimeState.getCapState<FloodStatus>('flood') ?? COLD_FLOOD
        this.runtimeState.setCapState('flood', {
          flooded: on,
          lastChangedAt: stampOnChange(prev.lastChangedAt, prev.flooded !== on, now),
        })
        return
      }
      case 'smoke': {
        const prev = this.runtimeState.getCapState<SmokeStatus>('smoke') ?? COLD_SMOKE
        this.runtimeState.setCapState('smoke', {
          detected: on,
          lastChangedAt: stampOnChange(prev.lastChangedAt, prev.detected !== on, now),
        })
        return
      }
      case 'motion': {
        const prev = this.runtimeState.getCapState<MotionStatus>('motion') ?? COLD_MOTION
        this.runtimeState.setCapState('motion', {
          detected: on,
          lastDetectedAt: on && !prev.detected ? now : prev.lastDetectedAt,
          autoClearAfterMs: null,
        })
        return
      }
      default:
        return
    }
  }
}

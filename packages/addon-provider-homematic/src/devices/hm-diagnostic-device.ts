import { z } from 'zod'
import {
  binaryCapability,
  numericSensorCapability,
  temperatureSensorCapability,
  type BinaryStatus,
  type DeviceContext,
  type InferNativeProvider,
  type NumericSensorStatus,
  type TemperatureSensorStatus,
  ingestReading,
  quantityFromUnit,
  type ReadingQuantity,
} from '@camstack/types'
import type { HmValue, ValueChangedEvent } from 'nodehomematic'
import { HmChildDevice, hmChildSchema } from './hm-child-device.js'
import { changeStamp, type HmValueOrigin } from './hm-change-stamp.js'

/**
 * Diagnostic child config. `capabilities` carries exactly one diagnostic cap
 * (`numeric-sensor` / `binary` / `temperature-sensor`); `sourceParams` are the
 * MAINTENANCE datapoint parameter names this child reads; `unit` is the display
 * unit for numeric diagnostics. `channel` is the MAINTENANCE channel address.
 */
export const hmDiagnosticSchema = hmChildSchema.extend({
  channel: z.string().min(1).describe('MAINTENANCE channel address'),
  capabilities: z.array(z.string()).min(1),
  role: z.string().optional(),
  unit: z.string().optional(),
  sourceParams: z.array(z.string()).min(1),
})

export type HmDiagnosticConfig = z.infer<typeof hmDiagnosticSchema>

/** Cold-start slices keyed by cap. */
const COLD_NUMERIC: NumericSensorStatus = { value: 0, lastFetchedAt: 0 }
const COLD_BINARY: BinaryStatus = { on: false, lastChangedAt: 0 }
const COLD_TEMP: TemperatureSensorStatus = { celsius: 0, lastFetchedAt: 0 }

/**
 * One Homematic MAINTENANCE-derived diagnostic accessory child — operating
 * voltage / signal (RSSI) / duty cycle / battery-low / temperature. Registers
 * a single `numeric-sensor`, `binary`, or `temperature-sensor` cap (per
 * `config.capabilities`) and writes its slice from facade `valueChanged`
 * pushes whose `parameter` matches one of `config.sourceParams`. Read-mostly:
 * the value arrives via push (cold-seeded so reads never miss).
 */
export class HmDiagnosticDevice extends HmChildDevice<typeof hmDiagnosticSchema> {
  private readonly capName: string
  private readonly unit: string | undefined
  private readonly sourceParams: ReadonlySet<string>

  constructor(ctx: DeviceContext) {
    super(ctx, hmDiagnosticSchema)
    const cfg = this.config.values
    this.capName = cfg.capabilities[0] ?? 'numeric-sensor'
    this.unit = cfg.unit
    this.sourceParams = new Set(cfg.sourceParams.map((p) => p.toUpperCase()))
    this.registerDiagnosticCap()
    this.attachValueChangedListener((event, origin) => this.handleValueChanged(event, origin))
  }

  private registerDiagnosticCap(): void {
    switch (this.capName) {
      case 'binary': {
        const provider: InferNativeProvider<typeof binaryCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<BinaryStatus>('binary') ?? COLD_BINARY,
        }
        this.ctx.registerNativeCap(binaryCapability, provider)
        this.runtimeState.setCapState('binary', COLD_BINARY)
        return
      }
      case 'temperature-sensor': {
        const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<TemperatureSensorStatus>('temperature-sensor') ??
            COLD_TEMP,
        }
        this.ctx.registerNativeCap(temperatureSensorCapability, provider)
        this.runtimeState.setCapState('temperature-sensor', COLD_TEMP)
        return
      }
      case 'numeric-sensor':
      default: {
        const cold = COLD_NUMERIC
        const provider: InferNativeProvider<typeof numericSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<NumericSensorStatus>('numeric-sensor') ?? cold,
        }
        this.ctx.registerNativeCap(numericSensorCapability, provider)
        this.runtimeState.setCapState('numeric-sensor', cold)
        return
      }
    }
  }

  private handleValueChanged(event: ValueChangedEvent, origin: HmValueOrigin): void {
    const now = event.ts || Date.now()
    const parameter = event.parameter.toUpperCase()
    if (!this.sourceParams.has(parameter)) return
    this.applyValue(event.value, now, origin)
  }

  private applyValue(value: HmValue, now: number, origin: HmValueOrigin): void {
    if (this.capName === 'binary') {
      if (typeof value !== 'boolean') return
      const prev = this.runtimeState.getCapState<BinaryStatus>('binary') ?? COLD_BINARY
      const lastChangedAt = changeStamp(origin, now, prev.lastChangedAt, prev.on === value)
      this.runtimeState.setCapState('binary', { on: value, lastChangedAt })
      return
    }
    if (typeof value !== 'number') return
    const stored = this.toBase(value)
    if (stored === null) return
    if (this.capName === 'temperature-sensor') {
      this.runtimeState.setCapState('temperature-sensor', { celsius: stored, lastFetchedAt: now })
      return
    }
    this.runtimeState.setCapState('numeric-sensor', { value: stored, lastFetchedAt: now })
  }

  /** Upstream diagnostic number → the quantity's base. Unknown units publish nothing. */
  private toBase(value: number): number | null {
    const quantity = this.readingQuantity()
    if (quantity === null) {
      this.warnRefusal('unknown-unit')
      return null
    }
    const result = ingestReading({ value, rawUnit: this.unit, quantity })
    if (!result.ok) {
      this.warnRefusal(result.reason)
      return null
    }
    if (this.capName === 'numeric-sensor' && this.sourceInfo.quantity !== quantity) {
      void this.updateSourceInfo({ quantity })
    }
    return result.value
  }

  private readingQuantity(): ReadingQuantity | null {
    if (this.capName === 'temperature-sensor') return 'temperature'
    if (this.unit === undefined) return 'none'
    const learned = quantityFromUnit(this.unit)
    if (learned === undefined || learned === 'device') return null
    return learned
  }

  private warnRefusal(reason: string): void {
    this.ctx.logger.warn('numeric reading refused', {
      tags: { deviceId: this.id },
      meta: { quantity: this.readingQuantity() ?? 'device', unit: this.unit ?? '', reason },
    })
  }
}

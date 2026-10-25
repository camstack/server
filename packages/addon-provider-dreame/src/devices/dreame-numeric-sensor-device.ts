import { z } from 'zod'
import {
  numericSensorCapability,
  type DeviceContext,
  type InferNativeProvider,
  type NumericSensorStatus,
} from '@camstack/types'
import { dreameChildSchema } from './dreame-child-device.js'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'numeric-sensor'

/** Persisted config for a generic numeric-sensor child: the shared Dreame child
 *  config plus the MIoT coordinates + presentation from the entity catalog. */
export const dreameNumericSensorSchema = dreameChildSchema.extend({
  siid: z.number().int().nonnegative(),
  piid: z.number().int().nonnegative(),
  unit: z.string().optional(),
  label: z.string().optional(),
})

export type DreameNumericSensorConfig = z.infer<typeof dreameNumericSensorSchema>

/**
 * A read-only Dreame numeric sensor exposed as a `DeviceType.Sensor` child under
 * the robot Container, backed by ONE MIoT property read through the shared device
 * handle's generic `getProperty`. Catalog-driven (see `dreame-entity-catalog.ts`)
 * — no per-sensor class. The value is whatever the device reports for the
 * configured `siid/piid`; `unit` is carried for display.
 */
export class DreameNumericSensorDevice extends DreameChildDevice {
  readonly #siid: number
  readonly #piid: number
  readonly #unit: string | undefined

  constructor(ctx: DeviceContext) {
    super(ctx)
    const cfg = dreameNumericSensorSchema.parse(ctx.persistedConfig ?? {})
    this.#siid = cfg.siid
    this.#piid = cfg.piid
    this.#unit = cfg.unit
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:sensor:${cfg.siid}-${cfg.piid}`,
      system: 'dreame',
    })
  }

  /** Read the configured property's numeric value from the shared handle, or null. */
  #readValue(): number | null {
    const v = this.resolveHandle()?.getProperty(this.#siid, this.#piid)?.value
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  #slice(value: number): NumericSensorStatus {
    return {
      value,
      ...(this.#unit !== undefined ? { unit: this.#unit } : {}),
      lastFetchedAt: Date.now(),
    }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof numericSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<NumericSensorStatus>(CAP_NAME) ?? this.#slice(0),
    }
    this.ctx.registerNativeCap(numericSensorCapability, provider)
    const initial = this.#readValue()
    this.runtimeState.setCapState(CAP_NAME, this.#slice(initial ?? 0))
  }

  protected override recomputeSlice(): void {
    const value = this.#readValue()
    if (value === null) return
    const current = this.runtimeState.getCapState<NumericSensorStatus>(CAP_NAME)
    if (current?.value === value) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(value))
  }
}

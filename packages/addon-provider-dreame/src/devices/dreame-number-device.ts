import { z } from 'zod'
import {
  controlCapability,
  DeviceRole,
  type ControlStatus,
  type DeviceContext,
  type InferNativeProvider,
} from '@camstack/types'
import { dreameChildSchema } from './dreame-child-device.js'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'control'

/** Persisted config for a generic number child: the shared Dreame child config
 *  plus the MIoT coordinates + the accepted range/unit from the entity catalog. */
export const dreameNumberSchema = dreameChildSchema.extend({
  siid: z.number().int().nonnegative(),
  piid: z.number().int().nonnegative(),
  label: z.string().optional(),
  min: z.number(),
  max: z.number(),
  step: z.number().positive(),
  unit: z.string().optional(),
})

export type DreameNumberConfig = z.infer<typeof dreameNumberSchema>

/**
 * A writable Dreame numeric setting exposed as a `DeviceType.Control` child
 * (`numeric-control` role) under the robot Container, backed by ONE direct MIoT
 * property holding a number. Reads pass the value through; `setValue` writes it
 * via the shared handle's generic `setProperty`. The `control` slice carries the
 * live value + min/max/step/unit (so the UI renders a bounded slider). Catalog-
 * driven (see `dreame-entity-catalog.ts` `DREAME_NUMBERS`) — no per-number class.
 */
export class DreameNumberDevice extends DreameChildDevice {
  readonly #siid: number
  readonly #piid: number
  readonly #min: number
  readonly #max: number
  readonly #step: number
  readonly #unit: string | undefined

  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.NumericControl)
    const cfg = dreameNumberSchema.parse(ctx.persistedConfig ?? {})
    this.#siid = cfg.siid
    this.#piid = cfg.piid
    this.#min = cfg.min
    this.#max = cfg.max
    this.#step = cfg.step
    this.#unit = cfg.unit
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:number:${cfg.siid}-${cfg.piid}`,
      system: 'dreame',
    })
  }

  /** Read the configured property's numeric value, or null when absent. */
  #read(): number | null {
    const v = this.resolveHandle()?.getProperty(this.#siid, this.#piid)?.value
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  #slice(value: number): ControlStatus {
    return {
      kind: 'numeric',
      value,
      options: [],
      lastChangedAt: Date.now(),
      min: this.#min,
      max: this.#max,
      step: this.#step,
      ...(this.#unit !== undefined ? { unit: this.#unit } : {}),
    }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof controlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ControlStatus>(CAP_NAME) ??
        this.#slice(this.#read() ?? this.#min),
      setValue: async ({ control }) => {
        if (control.kind !== 'numeric') {
          throw new Error(
            `DreameNumberDevice: expected a numeric value (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        const handle = this.resolveHandle()
        if (handle === null) {
          throw new Error(
            `DreameNumberDevice: handle unavailable (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        // Clamp to the declared range so an out-of-bounds UI value is never written.
        const clamped = Math.min(this.#max, Math.max(this.#min, control.value))
        await handle.setProperty({ siid: this.#siid, piid: this.#piid, value: clamped })
        this.runtimeState.setCapState(CAP_NAME, this.#slice(clamped))
      },
    }
    this.ctx.registerNativeCap(controlCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, this.#slice(this.#read() ?? this.#min))
  }

  protected override recomputeSlice(): void {
    const value = this.#read()
    if (value === null) return
    const current = this.runtimeState.getCapState<ControlStatus>(CAP_NAME)
    if (current?.value === value) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(value))
  }
}

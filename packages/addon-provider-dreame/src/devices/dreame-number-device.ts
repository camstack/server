import { z } from 'zod'
import {
  controlCapability,
  DeviceRole,
  type ControlStatus,
  type DeviceContext,
  type InferNativeProvider,
  type ReadingQuantity,
} from '@camstack/types'
import { dreameQuantity, dreameStep, dreameToBase, dreameToUpstream } from '../dreame-reading.js'
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
  readonly #unit: string | undefined
  readonly #quantity: ReadingQuantity | null
  readonly #baseMin: number
  readonly #baseMax: number
  readonly #baseStep: number | undefined

  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.NumericControl)
    const cfg = dreameNumberSchema.parse(ctx.persistedConfig ?? {})
    this.#siid = cfg.siid
    this.#piid = cfg.piid
    this.#unit = cfg.unit
    this.#quantity = dreameQuantity(cfg.unit)
    this.#baseMin = this.#toBase(cfg.min) ?? cfg.min
    this.#baseMax = this.#toBase(cfg.max) ?? cfg.max
    this.#baseStep =
      this.#quantity === null ? cfg.step : dreameStep(cfg.step, cfg.unit, this.#quantity)
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:number:${cfg.siid}-${cfg.piid}`,
      system: 'dreame',
      ...(this.#quantity !== null ? { quantity: this.#quantity } : {}),
    })
  }

  /** Read the configured property's numeric value, or null when absent. */
  #read(): number | null {
    const v = this.resolveHandle()?.getProperty(this.#siid, this.#piid)?.value
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  }

  #toBase(value: number): number | null {
    if (this.#quantity === null) return null
    return dreameToBase(value, this.#unit, this.#quantity)
  }

  #slice(upstream: number): ControlStatus | null {
    const value = this.#toBase(upstream)
    if (value === null) {
      this.ctx.logger.warn('numeric reading refused', {
        tags: { deviceId: this.id },
        meta: {
          quantity: this.#quantity ?? 'device',
          unit: this.#unit ?? '',
          reason: 'unknown-unit',
        },
      })
      return null
    }
    return {
      kind: 'numeric',
      value,
      options: [],
      lastChangedAt: Date.now(),
      min: this.#baseMin,
      max: this.#baseMax,
      ...(this.#baseStep !== undefined ? { step: this.#baseStep } : {}),
    }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof controlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ControlStatus>(CAP_NAME) ?? {
          kind: 'numeric',
          value: 0,
          options: [],
          lastChangedAt: 0,
        },
      setValue: async ({ control }) => {
        if (control.kind !== 'numeric') {
          throw new Error(
            `DreameNumberDevice: expected a numeric value (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        if (this.#quantity === null) {
          throw new Error(
            `DreameNumberDevice: unknown unit (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        const handle = this.resolveHandle()
        if (handle === null) {
          throw new Error(
            `DreameNumberDevice: handle unavailable (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        const clamped = Math.min(this.#baseMax, Math.max(this.#baseMin, control.value))
        const upstream = dreameToUpstream(clamped, this.#unit, this.#quantity)
        if (upstream === null) {
          throw new Error(
            `DreameNumberDevice: cannot convert back (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        await handle.setProperty({ siid: this.#siid, piid: this.#piid, value: upstream })
        const slice = this.#slice(upstream)
        if (slice !== null) this.runtimeState.setCapState(CAP_NAME, slice)
      },
    }
    this.ctx.registerNativeCap(controlCapability, provider)
    const initial = this.#read()
    const slice = initial === null ? null : this.#slice(initial)
    if (slice !== null) this.runtimeState.setCapState(CAP_NAME, slice)
  }

  protected override recomputeSlice(): void {
    const value = this.#read()
    if (value === null) return
    const slice = this.#slice(value)
    if (slice === null) return
    const current = this.runtimeState.getCapState<ControlStatus>(CAP_NAME)
    if (current?.value === slice.value) return
    this.runtimeState.setCapState(CAP_NAME, slice)
  }
}

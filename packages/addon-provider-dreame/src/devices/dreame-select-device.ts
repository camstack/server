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

/** One persisted select option: the MIoT int value + its display label. */
const dreameSelectOptionSchema = z.object({
  value: z.number().int(),
  label: z.string().min(1),
})

/** Persisted config for a generic select child: the shared Dreame child config
 *  plus the MIoT coordinates + the int↔label option map from the entity catalog. */
export const dreameSelectSchema = dreameChildSchema.extend({
  siid: z.number().int().nonnegative(),
  piid: z.number().int().nonnegative(),
  label: z.string().optional(),
  options: z.array(dreameSelectOptionSchema).min(1),
})

export type DreameSelectConfig = z.infer<typeof dreameSelectSchema>

/**
 * A writable Dreame enum exposed as a `DeviceType.Control` child (`select-control`
 * role) under the robot Container, backed by ONE direct MIoT property holding an
 * int. Reads map the reported int → its label; `setValue` maps the chosen label →
 * its int and writes it via the shared handle's generic `setProperty`. The
 * `control` slice carries the live label + the full option-label list (HA-parity).
 * Catalog-driven (see `dreame-entity-catalog.ts` `DREAME_SELECTS`) — no per-select
 * class.
 */
export class DreameSelectDevice extends DreameChildDevice {
  readonly #siid: number
  readonly #piid: number
  readonly #options: readonly { value: number; label: string }[]

  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.SelectControl)
    const cfg = dreameSelectSchema.parse(ctx.persistedConfig ?? {})
    this.#siid = cfg.siid
    this.#piid = cfg.piid
    this.#options = cfg.options
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:select:${cfg.siid}-${cfg.piid}`,
      system: 'dreame',
    })
  }

  /** Read the configured property's int and resolve it to a label, or null. */
  #readLabel(): string | null {
    const v = this.resolveHandle()?.getProperty(this.#siid, this.#piid)?.value
    if (typeof v !== 'number') return null
    return this.#options.find((o) => o.value === v)?.label ?? null
  }

  #labels(): string[] {
    return this.#options.map((o) => o.label)
  }

  #slice(value: string): ControlStatus {
    return { kind: 'select', value, options: this.#labels(), lastChangedAt: Date.now() }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof controlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ControlStatus>(CAP_NAME) ??
        this.#slice(this.#readLabel() ?? ''),
      setValue: async ({ control }) => {
        if (control.kind !== 'select') {
          throw new Error(
            `DreameSelectDevice: expected a select value (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        const option = this.#options.find((o) => o.label === control.value)
        if (option === undefined) {
          throw new Error(
            `DreameSelectDevice: unknown option "${control.value}" (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        const handle = this.resolveHandle()
        if (handle === null) {
          throw new Error(
            `DreameSelectDevice: handle unavailable (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        await handle.setProperty({ siid: this.#siid, piid: this.#piid, value: option.value })
        this.runtimeState.setCapState(CAP_NAME, this.#slice(option.label))
      },
    }
    this.ctx.registerNativeCap(controlCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, this.#slice(this.#readLabel() ?? ''))
  }

  protected override recomputeSlice(): void {
    const label = this.#readLabel()
    if (label === null) return
    const current = this.runtimeState.getCapState<ControlStatus>(CAP_NAME)
    if (current?.value === label) return
    this.runtimeState.setCapState(CAP_NAME, this.#slice(label))
  }
}

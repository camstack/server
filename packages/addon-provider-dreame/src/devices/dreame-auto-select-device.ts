import { z } from 'zod'
import {
  controlCapability,
  DeviceRole,
  type ControlStatus,
  type DeviceContext,
  type InferNativeProvider,
} from '@camstack/types'
import { VacuumDevice, type AutoSwitchKey } from '@apocaliss92/nodedreame'
import { dreameChildSchema } from './dreame-child-device.js'
import { DreameChildDevice } from './dreame-child-device.js'
import { isAutoSwitchKey } from './dreame-auto-switch-device.js'

const CAP_NAME = 'control'

const dreameAutoSelectOptionSchema = z.object({
  value: z.number().int(),
  label: z.string().min(1),
})

/** Persisted config for a packed auto-switch ENUM child: the shared Dreame child
 *  config plus the `autoSwitchKey` + the int↔label option map from the catalog. */
export const dreameAutoSelectSchema = dreameChildSchema.extend({
  autoSwitchKey: z.string().min(1),
  label: z.string().optional(),
  options: z.array(dreameAutoSelectOptionSchema).min(1),
})

export type DreameAutoSelectConfig = z.infer<typeof dreameAutoSelectSchema>

/**
 * An enum setting inside the PACKED `AUTO_SWITCH_SETTINGS` bundle, exposed as a
 * `DeviceType.Control` (`select-control` role) child. The auto_switch analog of
 * {@link DreameSelectDevice}: reads the int via `vacuum.autoSwitchProperty(key)`,
 * maps it to a label, and `setValue` maps the chosen label → int and sends it via
 * `setAutoSwitchProperty` (single-key merge-write). Catalog-driven (see
 * `dreame-entity-catalog.ts` `DREAME_AUTO_SELECTS`).
 */
export class DreameAutoSelectDevice extends DreameChildDevice {
  readonly #key: AutoSwitchKey
  readonly #options: readonly { value: number; label: string }[]

  constructor(ctx: DeviceContext) {
    super(ctx, DeviceRole.SelectControl)
    const cfg = dreameAutoSelectSchema.parse(ctx.persistedConfig ?? {})
    if (!isAutoSwitchKey(cfg.autoSwitchKey)) {
      throw new Error(
        `DreameAutoSelectDevice: unknown auto-switch key "${cfg.autoSwitchKey}" (device=${this.dreameDeviceId})`,
      )
    }
    this.#key = cfg.autoSwitchKey
    this.#options = cfg.options
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:auto-select:${cfg.autoSwitchKey}`,
      system: 'dreame',
    })
  }

  /** Resolve the handle narrowed to a VacuumDevice (the auto-switch API lives there). */
  #vacuum(): VacuumDevice | null {
    const handle = this.resolveHandle()
    return handle instanceof VacuumDevice ? handle : null
  }

  /** Decode this setting's int from the bundle and resolve it to a label, or null. */
  #readLabel(): string | null {
    const v = this.#vacuum()?.autoSwitchProperty(this.#key)
    if (typeof v !== 'number') return null
    return this.#options.find((o) => o.value === v)?.label ?? null
  }

  #slice(value: string): ControlStatus {
    return {
      kind: 'select',
      value,
      options: this.#options.map((o) => o.label),
      lastChangedAt: Date.now(),
    }
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof controlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ControlStatus>(CAP_NAME) ??
        this.#slice(this.#readLabel() ?? ''),
      setValue: async ({ control }) => {
        if (control.kind !== 'select') {
          throw new Error(
            `DreameAutoSelectDevice: expected a select value (device=${this.dreameDeviceId}, ${this.#key})`,
          )
        }
        const option = this.#options.find((o) => o.label === control.value)
        if (option === undefined) {
          throw new Error(
            `DreameAutoSelectDevice: unknown option "${control.value}" (device=${this.dreameDeviceId}, ${this.#key})`,
          )
        }
        const vacuum = this.#vacuum()
        if (vacuum === null) {
          throw new Error(
            `DreameAutoSelectDevice: handle unavailable (device=${this.dreameDeviceId}, ${this.#key})`,
          )
        }
        await vacuum.setAutoSwitchProperty(this.#key, option.value)
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

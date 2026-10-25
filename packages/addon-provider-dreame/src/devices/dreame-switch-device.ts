import { z } from 'zod'
import {
  switchCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { dreameChildSchema } from './dreame-child-device.js'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'switch'
const COLD: SwitchStatus = { on: false, lastChangedAt: 0 }

/** Persisted config for a generic direct-property switch child. */
export const dreameSwitchSchema = dreameChildSchema.extend({
  siid: z.number().int().nonnegative(),
  piid: z.number().int().nonnegative(),
  label: z.string().optional(),
})

export type DreameSwitchConfig = z.infer<typeof dreameSwitchSchema>

/**
 * A writable boolean Dreame setting exposed as a `DeviceType.Switch` child under
 * the robot Container, backed by ONE direct MIoT property (value 0/1) read/written
 * through the shared handle's generic `getProperty`/`setProperty`. Catalog-driven
 * (see `dreame-entity-catalog.ts` `DREAME_SWITCHES`) — no per-switch class. The
 * packed AI-obstacle toggles use {@link DreameAiSwitchDevice} instead.
 */
export class DreameSwitchDevice extends DreameChildDevice {
  readonly #siid: number
  readonly #piid: number

  constructor(ctx: DeviceContext) {
    super(ctx)
    const cfg = dreameSwitchSchema.parse(ctx.persistedConfig ?? {})
    this.#siid = cfg.siid
    this.#piid = cfg.piid
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:switch:${cfg.siid}-${cfg.piid}`,
      system: 'dreame',
    })
  }

  /** Read the configured property as a boolean (non-zero = on), or null when absent. */
  #read(): boolean | null {
    const v = this.resolveHandle()?.getProperty(this.#siid, this.#piid)?.value
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    return null
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>(CAP_NAME) ?? COLD,
      setState: async ({ on }) => {
        const handle = this.resolveHandle()
        if (handle === null) {
          throw new Error(
            `DreameSwitchDevice: handle unavailable (device=${this.dreameDeviceId}, ${this.#siid}/${this.#piid})`,
          )
        }
        await handle.setProperty({ siid: this.#siid, piid: this.#piid, value: on ? 1 : 0 })
        this.runtimeState.setCapState(CAP_NAME, { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    const on = this.#read()
    this.runtimeState.setCapState(CAP_NAME, on === null ? COLD : { on, lastChangedAt: Date.now() })
  }

  protected override recomputeSlice(): void {
    const on = this.#read()
    if (on === null) return
    const current = this.runtimeState.getCapState<SwitchStatus>(CAP_NAME)
    if (current?.on === on) return
    this.runtimeState.setCapState(CAP_NAME, { on, lastChangedAt: Date.now() })
  }
}

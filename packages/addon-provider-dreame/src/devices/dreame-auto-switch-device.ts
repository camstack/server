import { z } from 'zod'
import {
  switchCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { AUTO_SWITCH_JSON_KEY, VacuumDevice, type AutoSwitchKey } from '@apocaliss92/nodedreame'
import { dreameChildSchema } from './dreame-child-device.js'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'switch'
const COLD: SwitchStatus = { on: false, lastChangedAt: 0 }

/** Narrow a persisted string to a known auto-switch key (cast-free guard). */
export function isAutoSwitchKey(s: string): s is AutoSwitchKey {
  return Object.prototype.hasOwnProperty.call(AUTO_SWITCH_JSON_KEY, s)
}

/** Persisted config for a packed auto-switch boolean child: the shared Dreame
 *  child config plus the `autoSwitchKey` addressing it inside the bundle. */
export const dreameAutoSwitchSchema = dreameChildSchema.extend({
  autoSwitchKey: z.string().min(1),
  label: z.string().optional(),
})

export type DreameAutoSwitchConfig = z.infer<typeof dreameAutoSwitchSchema>

/**
 * A boolean setting inside the PACKED `AUTO_SWITCH_SETTINGS` bundle (siid 4 piid
 * 50), exposed as a `DeviceType.Switch` child. Unlike {@link DreameSwitchDevice}
 * it has no direct siid/piid — it is read/written through nodedreame's auto-switch
 * codec (`vacuum.autoSwitchProperty(key)` returns the int; `setAutoSwitchProperty`
 * sends a single-key merge-write that preserves the rest of the bundle). The
 * packed AI toggles use {@link DreameAiSwitchDevice}; this is the auto_switch
 * analog. Catalog-driven (see `dreame-entity-catalog.ts` `DREAME_AUTO_SWITCHES`).
 */
export class DreameAutoSwitchDevice extends DreameChildDevice {
  readonly #key: AutoSwitchKey

  constructor(ctx: DeviceContext) {
    super(ctx)
    const cfg = dreameAutoSwitchSchema.parse(ctx.persistedConfig ?? {})
    if (!isAutoSwitchKey(cfg.autoSwitchKey)) {
      throw new Error(
        `DreameAutoSwitchDevice: unknown auto-switch key "${cfg.autoSwitchKey}" (device=${this.dreameDeviceId})`,
      )
    }
    this.#key = cfg.autoSwitchKey
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:auto-switch:${cfg.autoSwitchKey}`,
      system: 'dreame',
    })
  }

  /** Resolve the handle narrowed to a VacuumDevice (the auto-switch API lives there). */
  #vacuum(): VacuumDevice | null {
    const handle = this.resolveHandle()
    return handle instanceof VacuumDevice ? handle : null
  }

  /** Decode this setting's bool from the packed bundle (1 = on), or null. */
  #read(): boolean | null {
    const v = this.#vacuum()?.autoSwitchProperty(this.#key)
    return typeof v === 'number' ? v === 1 : null
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>(CAP_NAME) ?? COLD,
      setState: async ({ on }) => {
        const vacuum = this.#vacuum()
        if (vacuum === null) {
          throw new Error(
            `DreameAutoSwitchDevice: handle unavailable (device=${this.dreameDeviceId}, ${this.#key})`,
          )
        }
        await vacuum.setAutoSwitchProperty(this.#key, on ? 1 : 0)
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

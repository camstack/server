import { z } from 'zod'
import { buttonCapability, type DeviceContext, type InferNativeProvider } from '@camstack/types'
import { dreameChildSchema } from './dreame-child-device.js'
import { DreameChildDevice } from './dreame-child-device.js'

/** Persisted config for a generic button child: the shared Dreame child config
 *  plus the MIoT action coordinates from the entity catalog. */
export const dreameButtonSchema = dreameChildSchema.extend({
  siid: z.number().int().nonnegative(),
  aiid: z.number().int().nonnegative(),
  label: z.string().optional(),
})

export type DreameButtonConfig = z.infer<typeof dreameButtonSchema>

/**
 * A fire-only Dreame action exposed as a `DeviceType.Button` child under the
 * robot Container, backed by ONE MIoT action invoked through the shared handle's
 * generic `callAction`. Button entities have no readable state — there is no
 * slice to seed or recompute. Catalog-driven (see `dreame-entity-catalog.ts`
 * `DREAME_BUTTONS`) — no per-button class.
 */
export class DreameButtonDevice extends DreameChildDevice {
  readonly #siid: number
  readonly #aiid: number

  constructor(ctx: DeviceContext) {
    super(ctx)
    const cfg = dreameButtonSchema.parse(ctx.persistedConfig ?? {})
    this.#siid = cfg.siid
    this.#aiid = cfg.aiid
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:button:${cfg.siid}-${cfg.aiid}`,
      system: 'dreame',
    })
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof buttonCapability> = {
      press: async () => {
        const handle = this.resolveHandle()
        if (handle === null) {
          throw new Error(
            `DreameButtonDevice: handle unavailable (device=${this.dreameDeviceId}, ${this.#siid}/${this.#aiid})`,
          )
        }
        await handle.callAction(this.#siid, this.#aiid)
      },
    }
    this.ctx.registerNativeCap(buttonCapability, provider)
  }

  /** Buttons are fire-only — there is no slice to recompute. */
  protected override recomputeSlice(): void {
    // intentionally empty
  }
}

import { buttonCapability, type DeviceContext, type InferNativeProvider } from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'

/**
 * HA-backed CamStack button device. Materialised on adoption of any
 * HA entity whose `mappedTo.capabilities` contains `button` — covers
 * the `button.*`, `input_button.*` and `scene.*` domains.
 *
 * Button entities are fire-only actuators: there is no readable state,
 * no runtime-state slice, and no `handleStatePush` override needed.
 * Pressing dispatches the activation service per the entity's domain:
 *   - `button.*` / `input_button.*` → `<domain>.press`
 *   - `scene.*`                      → `scene.turn_on` (scenes have no
 *     `press` service; activation is `turn_on`)
 * The domain is derived from the entity_id prefix.
 */
export class HaButtonDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerButtonCap()
  }

  private registerButtonCap(): void {
    const provider: InferNativeProvider<typeof buttonCapability> = {
      press: async () => {
        const domain = this.entityId.split('.')[0] ?? 'button'
        if (domain === 'scene') {
          await this.callHaService('scene', 'turn_on')
          return
        }
        await this.callHaService(domain, 'press')
      },
    }
    this.ctx.registerNativeCap(buttonCapability, provider)
  }
}

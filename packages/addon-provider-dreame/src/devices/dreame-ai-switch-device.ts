import { z } from 'zod'
import {
  switchCapability,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import { VacuumDevice as DreameVacuum, type DreameAiFeature } from '@apocaliss92/nodedreame'
import { dreameChildSchema } from './dreame-child-device.js'
import { DreameChildDevice } from './dreame-child-device.js'

const CAP_NAME = 'switch'
const COLD: SwitchStatus = { on: false, lastChangedAt: 0 }

/**
 * The AI-obstacle features camstack can surface as a Switch child. A const tuple
 * (not a free string) so the persisted `aiFeature` validates to a real
 * {@link DreameAiFeature} with no cast — and the library getter/setter accept it
 * directly. Mirror of nodedreame's `DreameAiFeature` union; `satisfies` rejects
 * a typo or a key the library does not know.
 */
const AI_FEATURE_KEYS = [
  'furnitureDetection',
  'obstacleDetection',
  'obstaclePicture',
  'fluidDetection',
  'petDetection',
  'obstacleImageUpload',
  'petAvoidance',
  'fuzzyObstacleDetection',
  'petPicture',
  'petFocusedDetection',
  'largeParticlesBoost',
  'humanDetection',
] as const satisfies readonly DreameAiFeature[]

/** Persisted config for an AI-switch child: the shared Dreame child config plus
 *  which AI feature this switch toggles. */
export const dreameAiSwitchSchema = dreameChildSchema.extend({
  aiFeature: z.enum(AI_FEATURE_KEYS).describe('Which AI-obstacle feature this switch toggles'),
})

export type DreameAiSwitchConfig = z.infer<typeof dreameAiSwitchSchema>

/** Human label for each AI-obstacle feature (the child device name). */
export const AI_FEATURE_LABEL: Readonly<Record<DreameAiFeature, string>> = {
  furnitureDetection: 'AI Furniture Detection',
  obstacleDetection: 'AI Obstacle Detection',
  obstaclePicture: 'AI Obstacle Picture',
  fluidDetection: 'AI Fluid Detection',
  petDetection: 'AI Pet Detection',
  obstacleImageUpload: 'AI Obstacle Image Upload',
  petAvoidance: 'AI Pet Avoidance',
  fuzzyObstacleDetection: 'Fuzzy Obstacle Detection',
  petPicture: 'AI Pet Picture',
  petFocusedDetection: 'AI Pet-Focused Detection',
  largeParticlesBoost: 'Large-Particles Boost',
  humanDetection: 'AI Human Detection',
}

/**
 * A single AI-obstacle toggle exposed as a `DeviceType.Switch` child grouped
 * UNDER the robot's Container (per the Dreame container directive — every
 * non-core entity is its own child, not folded onto the Vacuum). All of these
 * switches read/write ONE packed `AI_DETECTION` MIoT property; the library
 * (`VacuumDevice.aiFeature` / `setAiFeature`) decodes each feature out of the
 * bitmask/JSON and does the per-feature read-modify-write, so each switch stays
 * an independent boolean here.
 */
export class DreameAiSwitchDevice extends DreameChildDevice {
  readonly #feature: DreameAiFeature

  constructor(ctx: DeviceContext) {
    super(ctx)
    this.#feature = dreameAiSwitchSchema.parse(ctx.persistedConfig ?? {}).aiFeature
    // Give each AI switch a DISTINCT source id (the base seeds the bare did,
    // shared by every sibling) so it is individually addressable — the bare did
    // stays the Vacuum's identity.
    void this.updateSourceInfo({
      id: `${this.dreameDeviceId}:ai:${this.#feature}`,
      system: 'dreame',
    })
  }

  /** Narrow the generic handle to the library's typed {@link DreameVacuum}, or null. */
  private resolveVacuum(): DreameVacuum | null {
    const handle = this.resolveHandle()
    return handle instanceof DreameVacuum ? handle : null
  }

  protected override registerControlCap(): void {
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>(CAP_NAME) ?? COLD,
      setState: async ({ on }) => {
        const vacuum = this.resolveVacuum()
        if (vacuum === null) {
          throw new Error(
            `DreameAiSwitchDevice: vacuum handle unavailable (device=${this.dreameDeviceId}, feature=${this.#feature})`,
          )
        }
        await vacuum.setAiFeature(this.#feature, on)
        // Optimistic write-through; the next stateChanged push reconciles via
        // recomputeSlice() once the cloud echoes the new AI_DETECTION value.
        this.runtimeState.setCapState(CAP_NAME, { on, lastChangedAt: Date.now() })
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState(CAP_NAME, COLD)
  }

  protected override recomputeSlice(): void {
    const vacuum = this.resolveVacuum()
    if (vacuum === null) return
    const on = vacuum.aiFeature(this.#feature)
    // null = the packed AI_DETECTION value is not yet observed (or this feature
    // is not representable in the active encoding) — leave the last slice intact
    // rather than flapping the toggle to a false default.
    if (on === null) return
    const current = this.runtimeState.getCapState<SwitchStatus>(CAP_NAME)
    if (current?.on === on) return
    this.runtimeState.setCapState(CAP_NAME, { on, lastChangedAt: Date.now() })
  }
}

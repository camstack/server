import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { HeroModelSchema, HeroRowIdSchema } from '../device/hero/hero-model.js'

/**
 * hero-layout — what a device's hero says (D1023). Read-only: the FIXED
 * layouts live in `@camstack/types` and nothing here stores or edits one.
 * `getHeroModel` builds the pure model from the device's bindings and its
 * cap slices, so the admin UI and the viewer draw the same answer; `getLayout`
 * names the rows a device type carries.
 */

const heroInput = z.object({
  deviceId: z.number().int().nonnegative(),
  /**
   * Whether the caller may act on the device; absent = may. When false the model
   * lists what the caller must hide in `gated`. The actuating methods stay
   * guarded on their own: this only shapes what is drawn.
   */
  canActuate: z.boolean().optional(),
})

export const HeroLayoutRowsSchema = z.object({
  type: z.string(),
  rows: z.array(HeroRowIdSchema),
})
export type HeroLayoutRows = z.infer<typeof HeroLayoutRowsSchema>

export const heroLayoutCapability = {
  name: 'hero-layout',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** `null` = the device is unknown to the registry (never an empty hero). */
    getHeroModel: method(heroInput, HeroModelSchema.nullable(), {
      auth: 'protected',
      role: 'viewer',
    }),
    getLayout: method(z.object({ deviceType: z.string() }), HeroLayoutRowsSchema, {
      auth: 'protected',
      role: 'viewer',
    }),
  },
} as const satisfies CapabilityDefinition

export type IHeroLayoutProvider = InferProvider<typeof heroLayoutCapability>

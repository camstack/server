import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { HeroModelSchema, HeroRowIdSchema } from '../device/hero/hero-model.js'
import { HeroRowModelSchema } from '../device/hero/hero-row.js'

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

/** A list's most rows in one call; a longer list is read in pages. */
export const HERO_ROW_MODELS_MAX = 500

const rowModelsInput = z.object({
  deviceIds: z.array(z.number().int().nonnegative()).max(HERO_ROW_MODELS_MAX),
  /** As `canActuate` of `getHeroModel`; absent = may. */
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
    /**
     * The list rows of many devices in ONE call, projected from the same model as
     * the hero. One entry per requested id, in order. `null` has two meanings, both
     * "no row": the registry does not know the device, or reading it failed (the
     * provider logs that, tagged). It is never an empty row.
     */
    getRowModels: method(rowModelsInput, z.array(HeroRowModelSchema.nullable()), {
      auth: 'protected',
      role: 'viewer',
    }),
    /** The fixed rows of a kind: the type, refined by the role (D1033 — a heater is a switch). */
    getLayout: method(
      z.object({
        deviceType: z.string(),
        role: z.string().nullable().optional(),
      }),
      HeroLayoutRowsSchema,
      {
        auth: 'protected',
        role: 'viewer',
      },
    ),
  },
  vocabulary: {
    notOperatorFacing: 'the device hero model — read-only data the UI draws, never actuated',
  },
} as const satisfies CapabilityDefinition

export type IHeroLayoutProvider = InferProvider<typeof heroLayoutCapability>

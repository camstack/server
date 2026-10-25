/**
 * display-palette — the cluster's one colour table (D939).
 *
 * Hub singleton. `getPalette` reports `unknown` when the settings store
 * cannot be read; it does not pretend the bundled preset was stored.
 * `setPalette` refuses a palette that fails the ΔE / contrast rule and names
 * the pairs.
 */
import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import {
  paletteReadySchema,
  paletteResultSchema,
  paletteSwatchSchema,
  setPaletteInputSchema,
} from '../catalogs/display-palette.js'

const presetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  swatches: z.record(z.string(), paletteSwatchSchema),
  fallbacks: z.array(z.string()),
})

export const displayPaletteCapability = {
  name: 'display-palette',
  scope: 'system',
  mode: 'singleton',
  methods: {
    getPalette: method(z.void(), paletteResultSchema, { auth: 'protected', role: 'viewer' }),
    listPresets: method(z.void(), z.array(presetSummarySchema).readonly(), {
      auth: 'protected',
      role: 'viewer',
    }),
    setPalette: method(setPaletteInputSchema, paletteReadySchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IDisplayPaletteProvider = InferProvider<typeof displayPaletteCapability>

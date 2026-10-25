import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { WidgetMetadataSchema } from './addon-widgets-source.cap.js'

/**
 * `addon-widgets` — system-scoped singleton aggregator cap. Public-facing
 * surface that admin-ui consumes through `useAddonWidgetsListWidgets()`.
 *
 * The provider iterates every `addon-widgets-source` (collection)
 * provider and emits `EnrichedWidgetMetadata[]` enriched with versioned
 * `bundleUrl` strings pointing at
 * `/api/addon-widgets/<addonId>/<bundle>?v=<mtime>`. The filesystem
 * `mtime` cache-buster lets the browser pick up addon rebuilds without
 * manual reload — same scheme used by `addon-pages`.
 *
 * The hub-local builtin `addon-widgets-aggregator` (see
 * `@camstack/system/builtins/addon-widgets-aggregator`) registers the
 * provider. Splitting the public aggregator from the raw collection
 * keeps both ends in codegen — there's no hand-written wrapper.
 */

const EnrichedWidgetMetadataSchema = WidgetMetadataSchema.extend({
  addonId: z.string(),
  bundleUrl: z.string(),
})

export const addonWidgetsCapability = {
  name: 'addon-widgets',
  scope: 'system',
  mode: 'singleton',
  methods: {
    listWidgets: method(z.void(), z.array(EnrichedWidgetMetadataSchema).readonly()),
  },
} as const satisfies CapabilityDefinition

export type IAddonWidgetsAggregatorProvider = InferProvider<typeof addonWidgetsCapability>

/** One enriched widget row — `WidgetMetadata` + aggregator-stamped `addonId` + `bundleUrl`. */
export type EnrichedWidgetMetadata = z.infer<typeof EnrichedWidgetMetadataSchema>

export { EnrichedWidgetMetadataSchema }

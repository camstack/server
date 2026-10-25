import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `addon-pages` — system-scoped singleton aggregator cap. Public-facing
 * surface that admin-ui consumes through `useAddonPagesListPages()`.
 *
 * The provider iterates every `addon-pages-source` (collection) provider
 * and emits `AddonPageInfo[]` enriched with versioned `bundleUrl` strings
 * pointing at `/api/addon-pages/<addonId>/<bundle>?v=<mtime>`. The
 * filesystem `mtime` cache-buster lets the browser pick up addon
 * rebuilds without manual reload.
 *
 * The hub-local builtin `addon-pages-aggregator` (see
 * `@camstack/system/builtins/addon-pages-aggregator`) registers the
 * provider. Splitting the public aggregator from the raw collection
 * keeps both ends in codegen — there's no hand-written
 * `addon-pages.router.ts` wrapper anymore.
 */

const AddonPageDeclarationSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string(),
  path: z.string(),
  remoteName: z.string(),
  bundle: z.string(),
  // Sidebar docking — see addon-pages-source.cap.ts for the contract.
  section: z.string().optional(),
  sectionLabel: z.string().optional(),
})

const AddonPageInfoSchema = z.object({
  addonId: z.string(),
  page: AddonPageDeclarationSchema,
  bundleUrl: z.string(),
})

export const addonPagesCapability = {
  name: 'addon-pages',
  scope: 'system',
  mode: 'singleton',
  methods: {
    listPages: method(z.void(), z.array(AddonPageInfoSchema).readonly()),
  },
} as const satisfies CapabilityDefinition

export type IAddonPagesAggregatorProvider = InferProvider<typeof addonPagesCapability>

export { AddonPageInfoSchema }

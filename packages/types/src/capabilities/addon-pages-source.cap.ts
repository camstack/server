import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * `addon-pages-source` — collection cap exposing per-provider raw page
 * declarations. Every addon that contributes a UI page registers a
 * provider here. The hub-side singleton aggregator (`addon-pages` cap,
 * see `addon-pages.cap.ts`) walks this collection, stamps versioned
 * `bundleUrl` values, and returns the enriched `AddonPageInfo[]` list
 * that admin-ui consumes.
 *
 * The split exists because the public listing has a different output
 * shape than the per-provider raw declarations, and we want both ends
 * to flow through codegen instead of relying on a hand-written wrapper.
 */
const AddonPageDeclarationSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string(),
  path: z.string(),
  /**
   * Module Federation remote name — must match the `name` field on the
   * page addon's `federation()` plugin config. Used by admin-ui's
   * `<AddonPageLoader>` to call `loadRemote('<remoteName>/page')`.
   * Conventionally `addon_<id>_page` (snake_case; MF names cannot
   * contain hyphens).
   */
  remoteName: z.string(),
  /**
   * Bundle filename inside the addon's `dist/` dir served at
   * `/api/addon-pages/<addonId>/<bundle>`. With Module Federation this
   * is always `'remoteEntry.js'`; the value is kept on the metadata so
   * the static-file route can compute an mtime-based cache-buster URL
   * without a separate filesystem stat.
   */
  bundle: z.string(),
  /**
   * Sidebar section this page docks into. Well-known ids: `'detection'`,
   * `'cluster'`, `'administration'` — the page renders inside that group.
   * Any OTHER string creates (or joins) a custom section rendered after
   * the built-in groups; its label comes from `sectionLabel` (first
   * declaration wins), falling back to the id. Absent → the legacy
   * "Addon Pages" group.
   */
  section: z.string().optional(),
  /** Display label for a CUSTOM `section` id (ignored for well-known ids). */
  sectionLabel: z.string().optional(),
})

export const addonPagesSourceCapability = {
  name: 'addon-pages-source',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /**
     * `internal: true` did not gate the mount (see the 2026-08-26 note on
     * `data-store-provider`) — this was reachable on the AppRouter by ANY
     * authenticated session at the default `auth: 'protected'`. The only
     * consumer, the `addon-pages-aggregator` builtin, reads it via
     * `ctx.capabilities.getCollection('addon-pages-source')` — LOCAL-PROCESS
     * only, never tRPC (per `ctx.capabilities` seeing only the local
     * process). The public, enriched listing admin-ui actually consumes is
     * the separate `addon-pages` cap, unaffected by this change.
     */
    listPages: method(z.void(), z.array(AddonPageDeclarationSchema).readonly(), {
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IAddonPagesSourceProvider = InferProvider<typeof addonPagesSourceCapability>

export { AddonPageDeclarationSchema }

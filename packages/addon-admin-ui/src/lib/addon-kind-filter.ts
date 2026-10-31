/**
 * addon-kind-filter — the `?kind=integration` filter of System → Addons.
 * An integration addon is one that `integrations.getAvailableTypes` lists.
 * Pure: no router, no React.
 */

export type AddonKindFilter = 'integration'

export const ADDON_KIND_PARAM = 'kind'

export function parseAddonKindFilter(raw: string | null): AddonKindFilter | null {
  return raw === 'integration' ? 'integration' : null
}

/**
 * Keep the integration addons. `integrationAddonIds` is `null` while the
 * integration types have not answered — that is not "no integrations", so the
 * list is left whole until they do.
 */
export function filterIntegrationAddons<T extends { readonly manifest: { readonly id: string } }>(
  addons: readonly T[],
  integrationAddonIds: ReadonlySet<string> | null,
): readonly T[] {
  if (integrationAddonIds === null) return addons
  return addons.filter((a) => integrationAddonIds.has(a.manifest.id))
}

/** `/system/addons?kind=integration` */
export const BROWSE_INTEGRATIONS_URL = `/system/addons?${ADDON_KIND_PARAM}=integration`

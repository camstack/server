/**
 * integration-sections — the two blocks of the Integrations page. `System`
 * holds what the platform itself offers (blocks, grids, composed devices …):
 * integrations whose providing addon ships in a framework package, read from
 * the addon list's `manifest.packageName`. `Providers` holds the rest.
 */
import { isFrameworkPackage } from './framework-packages'

export interface AddonPackageRef {
  readonly manifest: { readonly id: string; readonly packageName?: string }
}

export interface IntegrationSections<T> {
  readonly providers: readonly T[]
  readonly system: readonly T[]
}

/** Ids of the addons shipped in a framework package. `undefined` (not answered) yields none. */
export function systemAddonIdsOf(
  addons: readonly AddonPackageRef[] | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const addon of addons ?? []) {
    if (isFrameworkPackage(addon.manifest.packageName)) ids.add(addon.manifest.id)
  }
  return ids
}

export function splitIntegrationSections<T extends { readonly addonId: string }>(
  items: readonly T[],
  systemAddonIds: ReadonlySet<string>,
): IntegrationSections<T> {
  return {
    providers: items.filter((item) => !systemAddonIds.has(item.addonId)),
    system: items.filter((item) => systemAddonIds.has(item.addonId)),
  }
}

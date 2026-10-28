/**
 * integration-sections — the two blocks of the Integrations page. `System`
 * holds what the platform itself offers (blocks, grids, composed devices …).
 * An addon declares its block on its manifest entry (`integrationSection`);
 * absent, the default applies: an addon shipped in a framework package
 * (`manifest.packageName`) is System, every other one is a Provider.
 */
import type { IntegrationSection } from '@camstack/types'
import { isFrameworkPackage } from './framework-packages'

export interface AddonPackageRef {
  readonly manifest: {
    readonly id: string
    readonly packageName?: string
    readonly integrationSection?: IntegrationSection
  }
}

export interface IntegrationSections<T> {
  readonly providers: readonly T[]
  readonly system: readonly T[]
}

/** The block an addon's integrations land in: the declared one first, then the package default. */
export function integrationSectionOf(manifest: AddonPackageRef['manifest']): IntegrationSection {
  if (manifest.integrationSection !== undefined) return manifest.integrationSection
  return isFrameworkPackage(manifest.packageName) ? 'system' : 'providers'
}

/** Ids of the addons whose integrations belong in System. `undefined` (not answered) yields none. */
export function systemAddonIdsOf(
  addons: readonly AddonPackageRef[] | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const addon of addons ?? []) {
    if (integrationSectionOf(addon.manifest) === 'system') ids.add(addon.manifest.id)
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

/**
 * The cards of a block are listed by the friendly name they display, in the
 * UI locale, ignoring case and accents. Returns a new array; the input is
 * never reordered. The Integrations page and the New Integration dialog both
 * order through this, so they always agree.
 */
export function sortByFriendlyName<T extends { readonly name: string }>(
  items: readonly T[],
  locale?: string,
): readonly T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }))
}

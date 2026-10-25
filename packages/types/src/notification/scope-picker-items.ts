/**
 * Nodes and packages as a PICKER lists them (D637). One projection shared by the
 * admin UI and the viewer, so the system family's two pickers group and label
 * the same way. The shape is structurally the pickers' `PickerItem<string>`.
 */
import type { NodeDirectoryEntry } from '../capabilities/nodes.cap.js'

export interface NcScopePickerItem {
  readonly id: string
  readonly name: string
  readonly type?: string
  readonly location?: string | null
  readonly detail?: string
}

export function nodePickerItems(
  nodes: readonly NodeDirectoryEntry[],
): readonly NcScopePickerItem[] {
  return nodes.map((node) => ({
    id: node.id,
    name: node.name,
    type: node.isHub ? 'hub' : 'agent',
    location: node.isOnline ? 'online' : 'offline',
    ...(node.name !== node.id ? { detail: node.id } : {}),
  }))
}

/**
 * The server's own package name: `server-update-available` / `server-updated`
 * carry it, and `addons.listPackages` does not list it.
 */
export const NC_SERVER_PACKAGE_NAME = '@camstack/server'

/**
 * Every package name an update EVENT carries as `packageName`, one per
 * producer. The package picker offers each of them whether or not
 * `addons.listPackages` lists it, because a rule scoped to a name no event
 * carries can never fire (and one an event carries must be pickable).
 *
 * - `@camstack/server` — `server-update-available` / `server-updated`: the hub
 *   root package (`HUB_ROOT_SPEC.packageName`, `@camstack/node-root`).
 * - `@camstack/system` — `server-update-available` from the framework check,
 *   which checks `[SYSTEM_PACKAGE]` only (`AddonPackageService.listFrameworkPackages`).
 *   `@camstack/types` / `@camstack/sdk` are framework packages for upload
 *   routing but are never announced, so they are NOT here.
 * - `camstack-wrapper` — `wrapper-update-available` (`WRAPPER_PACKAGE_NAME`,
 *   `wrapper-update-checker.ts`).
 *
 * Types cannot import those producers; the backend spec
 * `core/updates/__tests__/update-event-package-names.spec.ts` pins each literal
 * to its producer constant. This is a picker list, never a routing list.
 */
export const NC_UPDATE_EVENT_PACKAGE_NAMES = [
  NC_SERVER_PACKAGE_NAME,
  '@camstack/system',
  'camstack-wrapper',
] as const

type NcUpdateEventPackageName = (typeof NC_UPDATE_EVENT_PACKAGE_NAMES)[number]

const UPDATE_EVENT_PACKAGE_TYPE: Readonly<Record<NcUpdateEventPackageName, string>> = {
  '@camstack/server': 'server',
  '@camstack/system': 'framework',
  'camstack-wrapper': 'wrapper',
}

function isUpdateEventPackageName(name: string): name is NcUpdateEventPackageName {
  return NC_UPDATE_EVENT_PACKAGE_NAMES.some((pinned) => pinned === name)
}

export interface NcInstalledPackageLike {
  readonly name: string
  readonly version: string
}

/**
 * Every update-event package first (always offered: an event carries it), in
 * `NC_UPDATE_EVENT_PACKAGE_NAMES` order, then the installed addons sorted by
 * name. An installed version is the second line.
 */
export function packagePickerItems(
  packages: readonly NcInstalledPackageLike[],
): readonly NcScopePickerItem[] {
  const versions = new Map(packages.map((pkg) => [pkg.name, pkg.version]))
  const pinned = NC_UPDATE_EVENT_PACKAGE_NAMES.map((name) => {
    const version = versions.get(name)
    return {
      id: name,
      name,
      type: UPDATE_EVENT_PACKAGE_TYPE[name],
      location: null,
      ...(version !== undefined ? { detail: version } : {}),
    }
  })
  // `.sort` on a fresh array, never `toSorted`: the viewer runs on Hermes.
  const addons = packages
    .filter((pkg) => !isUpdateEventPackageName(pkg.name))
    .map((pkg) => ({
      id: pkg.name,
      name: pkg.name,
      type: 'addon',
      location: null,
      detail: pkg.version,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [...pinned, ...addons]
}

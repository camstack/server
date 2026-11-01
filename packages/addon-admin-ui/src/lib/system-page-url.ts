/**
 * The System page's address — the ONE builder for a link into one of its tabs.
 *
 * System (`/system/settings`, the path the sidebar's "System" entry and every
 * existing link already used) hosts the hub-level pages that have no tab strip
 * of their own: Settings and Capabilities (Terminal stays its own
 * sidebar entry by operator decision). Pages that
 * already own `?tab=` (Network, Identity, Data, Logs) stay their own sidebar
 * entries — nesting them would make two strips fight over one parameter.
 *
 * Secrets moved to Data (`/system/data?tab=secrets`). Data's Records tab owns
 * `?view=`, so the Secrets sub-view is `?secretsView=`; the former System
 * addresses (`/system/secrets`, `/system/settings?tab=secrets`) redirect there.
 */

export const SYSTEM_PAGE_PATH = '/system/settings'

export const SYSTEM_TABS = ['settings', 'capabilities'] as const
export type SystemTab = (typeof SYSTEM_TABS)[number]

/** Former standalone routes, each now a tab of the System page. */
export const SYSTEM_LEGACY_ROUTES: readonly { readonly path: string; readonly tab: SystemTab }[] = [
  { path: '/system/capabilities', tab: 'capabilities' },
]

/** `/system/settings?…&tab=<tab>`, keeping every other parameter of `search`. */
export function systemTabHref(tab: SystemTab, search = ''): string {
  const params = new URLSearchParams(search)
  params.delete('tab')
  params.set('tab', tab)
  return `${SYSTEM_PAGE_PATH}?${params.toString()}`
}

export const DATA_PAGE_PATH = '/system/data'

/** Former standalone Secrets route, now a tab of Data. */
export const SECRETS_LEGACY_PATH = '/system/secrets'

/**
 * `/system/data?tab=secrets[&secretsView=audit]` from a query written for the
 * old Secrets tab (`?view=audit`). Every other parameter is carried; the old
 * `view` is renamed because Data's Records tab owns that name.
 */
export function secretsTabHref(search = ''): string {
  const params = new URLSearchParams(search)
  const legacyView = params.get('view')
  params.delete('view')
  params.set('tab', 'secrets')
  if (legacyView === 'audit') params.set('secretsView', 'audit')
  return `${DATA_PAGE_PATH}?${params.toString()}`
}

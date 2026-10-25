/**
 * The System page's address — the ONE builder for a link into one of its tabs.
 *
 * System (`/system/settings`, the path the sidebar's "System" entry and every
 * existing link already used) hosts the hub-level pages that have no tab strip
 * of their own: Settings, Secrets and Capabilities (Terminal stays its own
 * sidebar entry by operator decision). Pages that
 * already own `?tab=` (Network, Identity, Data, Logs) stay their own sidebar
 * entries — nesting them would make two strips fight over one parameter.
 *
 * Secrets keeps its own `?view=` inside the tab, which is why a carried query
 * survives the redirect.
 */

export const SYSTEM_PAGE_PATH = '/system/settings'

export const SYSTEM_TABS = ['settings', 'secrets', 'capabilities'] as const
export type SystemTab = (typeof SYSTEM_TABS)[number]

/** Former standalone routes, each now a tab of the System page. */
export const SYSTEM_LEGACY_ROUTES: readonly { readonly path: string; readonly tab: SystemTab }[] = [
  { path: '/system/secrets', tab: 'secrets' },
  { path: '/system/capabilities', tab: 'capabilities' },
]

/** `/system/settings?…&tab=<tab>`, keeping every other parameter of `search`. */
export function systemTabHref(tab: SystemTab, search = ''): string {
  const params = new URLSearchParams(search)
  params.delete('tab')
  params.set('tab', tab)
  return `${SYSTEM_PAGE_PATH}?${params.toString()}`
}

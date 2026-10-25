/**
 * integration-hub-url — the address of an integration page, and the ONE
 * builder for a link into one.
 *
 * Every page built on `<IntegrationHub>` (Connectivity, Network → Remote
 * Access / Mesh Networks / TURN Servers, Identity → Authentication and Tokens &
 * sessions, Logs → Destinations) shows one integration at a time, chosen from a row of pills.
 * The choice lives in the URL so it survives a reload, walks with back/forward
 * and can be targeted from anywhere — a notification, the docs, another page:
 *
 *   /system/integrations?integration=export-alexa&section=settings
 *   /system/network?tab=remote-access&integration=cloudflare-tunnel
 *
 * - `integration` is the addon id (stable, unique, already what every cap call
 *   is routed by). Connectivity's message-broker connections are per addon too.
 * - `section` names a section of the integration's body (`settings`,
 *   `activity`, or a page's own panel id such as `devices`); the body scrolls
 *   it into view. A section nobody renders is ignored, never an error.
 * - `tab` is NOT ours: on Network / Identity / Logs it is `AdminTabs`'
 *   parameter. A hub page embedded under a tab strip declares its tab here, so
 *   the builder produces a link that opens the strip on it.
 *
 * `scripts/check-integration-hub-links.ts` pins this module as the only place
 * an `integration=` / `section=` query is spelled, and pins every page below
 * to a route `App.tsx` declares and a tab id its page renders.
 *
 * Pure: no router, no React. The router binding is
 * `hooks/useIntegrationSelection.ts`.
 */

/** The query parameter naming the integration on screen. */
export const INTEGRATION_PARAM = 'integration'

/** The query parameter naming a section of the integration's body. */
export const SECTION_PARAM = 'section'

/**
 * The params an integration page owns. An `AdminTabs` strip hosting one drops
 * them when the operator leaves the tab, so returning opens the page on its own
 * default rather than on another tab's stale selection.
 */
export const INTEGRATION_HUB_OWNED_PARAMS: readonly string[] = [INTEGRATION_PARAM, SECTION_PARAM]

/** Where each integration page lives. `tab` = the `AdminTabs` id hosting it. */
export const INTEGRATION_HUB_PAGES = {
  connectivity: { path: '/system/integrations', tab: null },
  remoteAccess: { path: '/system/network', tab: 'remote-access' },
  mesh: { path: '/system/network', tab: 'mesh' },
  turn: { path: '/system/network', tab: 'turn' },
  authentication: { path: '/system/identity', tab: 'authentication' },
  /** Identity → Tokens & sessions: one pill per credential kind (D819). */
  access: { path: '/system/identity', tab: 'access' },
  logging: { path: '/system/logs', tab: 'destinations' },
} as const satisfies Record<string, { readonly path: string; readonly tab: string | null }>

export type IntegrationHubPage = keyof typeof INTEGRATION_HUB_PAGES

/**
 * Connectivity's kind sections (`SectionedPage`, its `?tab=`): a page whose
 * registry `tab` is null picks its section per link, so an integration that
 * lives under Brokers is linked with `kindSection: 'brokers'`.
 */
export type ConnectivitySectionId = 'exporters' | 'email' | 'brokers' | 'calendars'

/** Section ids every addon-backed integration body renders. */
export const SETTINGS_SECTION = 'settings'
export const ACTIVITY_SECTION = 'activity'

export interface IntegrationTarget {
  /** The integration (addon id) to open. Omitted → the page's default. */
  readonly integration?: string
  /** The section of its body to bring into view. */
  readonly section?: string
  /** On a page with no fixed tab (Connectivity): the kind section to open. */
  readonly kindSection?: ConnectivitySectionId
}

/** A link to an integration page — the only way one is spelled. */
export function integrationHubHref(
  page: IntegrationHubPage,
  target: IntegrationTarget = {},
): string {
  const { path, tab } = INTEGRATION_HUB_PAGES[page]
  const params = new URLSearchParams()
  if (tab !== null) params.set('tab', tab)
  else if (target.kindSection !== undefined) params.set('tab', target.kindSection)
  if (target.integration !== undefined) params.set(INTEGRATION_PARAM, target.integration)
  if (target.section !== undefined) params.set(SECTION_PARAM, target.section)
  const query = params.toString()
  return query.length > 0 ? `${path}?${query}` : path
}

/**
 * The Addons catalog filtered to the packages that declare `capability`. The
 * builder lives in the UI library so an addon's own page can use it too.
 */
export { addonCatalogHref } from '@camstack/types'

export interface IntegrationSelectionInput {
  /** Every selectable integration id, in display order. */
  readonly ids: readonly string[]
  /** The id the URL asked for (`?integration=`), or null. */
  readonly requested: string | null
  /**
   * Whether the list has ANSWERED. Until it has, an id the list does not
   * contain is unknown, not stale — saying "not installed" about something we
   * have not heard back on yet is the D315 mistake.
   */
  readonly answered: boolean
  /** A legacy group link (Connectivity's `?tab=<kind>`), or null. */
  readonly legacyGroup?: string | null
  /** groupId → that group's first integration id (groups with none omitted). */
  readonly groupFirst?: Readonly<Record<string, string>>
}

export interface IntegrationSelection {
  /** The integration on screen; null only when nothing is selectable. */
  readonly selectedId: string | null
  /** The id the URL named that is not installed, once the list answered. */
  readonly staleId: string | null
}

/**
 * Which integration a URL opens. An explicit `?integration=` wins; a legacy
 * group link lands on its group's first integration; otherwise the first one.
 * An id that names nothing falls back AND is reported, so the page can say so
 * instead of silently showing a different integration.
 */
export function resolveIntegrationSelection(
  input: IntegrationSelectionInput,
): IntegrationSelection {
  const { ids, requested, answered, legacyGroup = null, groupFirst = {} } = input
  if (requested !== null && ids.includes(requested)) {
    return { selectedId: requested, staleId: null }
  }
  const staleId = requested !== null && answered ? requested : null
  const legacyTarget = legacyGroup !== null ? groupFirst[legacyGroup] : undefined
  if (legacyTarget !== undefined && ids.includes(legacyTarget)) {
    return { selectedId: legacyTarget, staleId }
  }
  return { selectedId: ids[0] ?? null, staleId }
}

/**
 * The query that selects `integrationId`: every other param kept, the section
 * reset (it belonged to the previous integration) unless one is given, and the
 * legacy group param dropped once an explicit integration replaces it.
 */
export function selectIntegrationParams(
  current: URLSearchParams,
  integrationId: string,
  legacyGroupParam: string | null = null,
  section: string | null = null,
): URLSearchParams {
  const next = new URLSearchParams(current)
  next.set(INTEGRATION_PARAM, integrationId)
  if (section === null) next.delete(SECTION_PARAM)
  else next.set(SECTION_PARAM, section)
  if (legacyGroupParam !== null) next.delete(legacyGroupParam)
  return next
}

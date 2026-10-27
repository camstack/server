/**
 * integration-instance-selection — the address of the addon-keyed integration
 * page (`/integrations/<addonId>?instances=<id>,<id>`) and the rules that read it.
 *
 * Pure: no router, no React.
 */

export const INSTANCES_PARAM = 'instances'

export interface InstanceRef {
  readonly id: string
}

export function parseInstanceIds(raw: string | null): readonly string[] {
  if (raw === null) return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * The instances the page shows: the requested ones that still exist (in the
 * addon's own order), or the FIRST instance when none is requested or none
 * of the requested ones exist.
 */
export function resolveSelectedInstanceIds(
  requested: readonly string[],
  instances: readonly InstanceRef[],
): readonly string[] {
  const first = instances[0]
  if (first === undefined) return []
  const wanted = new Set(requested)
  const kept = instances.filter((i) => wanted.has(i.id)).map((i) => i.id)
  return kept.length > 0 ? kept : [first.id]
}

export function integrationDetailUrl(addonId: string, instanceIds: readonly string[] = []): string {
  const base = `/integrations/${encodeURIComponent(addonId)}`
  return instanceIds.length === 0
    ? base
    : `${base}?${INSTANCES_PARAM}=${instanceIds.map(encodeURIComponent).join(',')}`
}

export interface RoutableIntegration {
  readonly id: string
  readonly addonId: string
}

export type DetailRoute =
  | { readonly kind: 'pending' }
  | { readonly kind: 'redirect'; readonly to: string }
  | { readonly kind: 'addon'; readonly addonId: string }

/**
 * A path segment under `/integrations/` is an ADDON id. An older per-instance
 * link carries an INTEGRATION id instead: it redirects to its addon's page
 * with that instance selected. Until the list answers nothing can be said.
 */
export function resolveDetailRoute(
  param: string,
  integrations: readonly RoutableIntegration[] | undefined,
): DetailRoute {
  if (integrations === undefined) return { kind: 'pending' }
  const legacy = integrations.find((i) => i.id === param)
  if (legacy !== undefined) {
    return { kind: 'redirect', to: integrationDetailUrl(legacy.addonId, [legacy.id]) }
  }
  return { kind: 'addon', addonId: param }
}

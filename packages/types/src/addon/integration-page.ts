/**
 * The admin page of an integration: `/integrations/<addonId>`, with the instance named in
 * `?instance=<integrationId>`. The one builder of that address — an addon that links to its own
 * integration page (an alert action, a notification) uses this instead of spelling the route.
 */

/** The query parameter that names the instance on the integration page. */
export const INTEGRATION_INSTANCE_PARAM = 'instance'

/** `/integrations/<addonId>`, with `?instance=<integrationId>` when an instance is given. */
export function integrationPageHref(addonId: string, integrationId?: string): string {
  const base = `/integrations/${encodeURIComponent(addonId)}`
  return integrationId === undefined || integrationId.length === 0
    ? base
    : `${base}?${INTEGRATION_INSTANCE_PARAM}=${encodeURIComponent(integrationId)}`
}

/**
 * integration-instance-selection — the address of the addon-keyed integration
 * page (`/integrations/<addonId>?instance=<integrationId>`) and the rule that
 * reads it. The one place that builds the URL.
 *
 * Pure: no router, no React.
 */

export const INSTANCE_PARAM = 'instance'

export interface InstanceRef {
  readonly id: string
}

/**
 * The instance the page shows: the requested one when it still exists, else
 * the FIRST instance of the addon. `null` when the addon has none.
 */
export function resolveSelectedInstanceId(
  requested: string | null,
  instances: readonly InstanceRef[],
): string | null {
  const first = instances[0]
  if (first === undefined) return null
  const match = instances.find((i) => i.id === requested)
  return match !== undefined ? match.id : first.id
}

/** `/integrations/<addonId>` with the instance named when one is given. */
export function integrationDetailUrl(addonId: string, instanceId?: string): string {
  const base = `/integrations/${encodeURIComponent(addonId)}`
  return instanceId === undefined || instanceId.length === 0
    ? base
    : `${base}?${INSTANCE_PARAM}=${encodeURIComponent(instanceId)}`
}

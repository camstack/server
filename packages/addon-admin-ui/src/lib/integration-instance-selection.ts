/**
 * integration-instance-selection — the address of the addon-keyed integration
 * page (`/integrations/<addonId>?instance=<integrationId>`) and the rule that
 * reads it. The one place that builds the URL.
 *
 * Pure: no router, no React. The address itself is `integrationPageHref` in `@dominevo/types`,
 * shared with the addons that link to their own page (an alert action).
 */
import { INTEGRATION_INSTANCE_PARAM, integrationPageHref } from '@dominevo/types'

export const INSTANCE_PARAM = INTEGRATION_INSTANCE_PARAM

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
  return integrationPageHref(addonId, instanceId)
}

/** Where the operator lands after a device is removed: its integration's page, else the list. */
export function removedDeviceDestination(
  integration: { readonly addonId: string; readonly id: string } | null,
): string {
  return integration?.id
    ? integrationDetailUrl(integration.addonId, integration.id)
    : '/integrations'
}

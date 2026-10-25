import type { ReactNode } from 'react'
import type { DeviceIntegrationResolution, DeviceItemDevice } from '@camstack/ui-library'
import { ProviderIcon } from './ProviderIcon'

/**
 * The integration badge beside a device row — the `<DeviceList
 * resolveIntegrationIcon>` every device table in this app passes.
 *
 * It draws the integration the row RESOLVED to, never the addon that serves
 * it: a composed device (D659) is served by `composer` and belongs to
 * "Blocks", so it wears the Blocks badge. An orphan row wears its serving
 * addon's badge as a diagnostic hint; the orphan box explicitly says that
 * badge is not an ownership answer. Not-yet-known (`unknown`) and no link
 * (`unlinked`) draw nothing rather than a guess.
 */
export function deviceIntegrationIcon(
  device: DeviceItemDevice,
  integration: DeviceIntegrationResolution,
): ReactNode | null {
  switch (integration.kind) {
    case 'resolved':
      return <ProviderIcon type={integration.integration.addonId} size="sm" />
    case 'orphan':
      return <ProviderIcon type={device.addonId} size="sm" />
    case 'unknown':
    case 'unlinked':
      return null
  }
}

/**
 * add-device-targets — what the Devices page "Add device" picker offers.
 *
 * An integration can take a new device when its addon is an installed
 * integration type that can add devices (`integrations.getAvailableTypes`, `canAdd`). Each such addon is
 * either already set up (one entry per instance, opened on the integration's
 * own add / scan / adopt flow) or not yet set up (offered the existing
 * integration wizard). A FIXED integration is declared by an addon and has no
 * add flow, so it is never offered.
 *
 * Pure: no router, no React.
 */

export interface AddDeviceType {
  readonly addonId: string
  readonly name: string
  /** The addon declares an add / discover / adopt flow. */
  readonly canAdd: boolean
}

export interface AddDeviceInstance {
  readonly id: string
  readonly addonId: string
  readonly name: string
  readonly enabled: boolean
  readonly info?: Readonly<Record<string, unknown>>
}

export interface AddDeviceTarget {
  readonly addonId: string
  readonly name: string
  /** Set-up instances that can take a device; empty = the addon is installed but has none yet. */
  readonly instances: readonly AddDeviceInstance[]
}

export function computeAddDeviceTargets(
  types: readonly AddDeviceType[],
  instances: readonly AddDeviceInstance[],
): readonly AddDeviceTarget[] {
  return types
    .filter((type) => type.canAdd)
    .map((type) => ({
      addonId: type.addonId,
      name: type.name,
      instances: instances.filter(
        (i) => i.addonId === type.addonId && i.enabled && i.info?.['fixed'] !== true,
      ),
    }))
    .filter(
      (target) =>
        target.instances.length > 0 ||
        !instances.some((i) => i.addonId === target.addonId && i.info?.['fixed'] === true),
    )
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The integration page opened on that instance's add / scan / adopt flow (`?add=1`). */
export function addDeviceUrl(addonId: string, instanceId: string): string {
  return `/integrations/${encodeURIComponent(addonId)}?instance=${encodeURIComponent(instanceId)}&add=1`
}

/** The existing integration wizard, opened on one addon (`?setup=`). */
export function setupIntegrationUrl(addonId: string): string {
  return `/integrations?setup=${encodeURIComponent(addonId)}`
}

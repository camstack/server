import type { DeviceManagerApi, InitialDeviceMeta } from '@dominevo/types'
import { UNIFI_SYSTEM } from './config.js'
import { UnifiFeatureDevice } from './devices/unifi-feature-device.js'
import { UnifiInfraDevice } from './devices/unifi-infra-device.js'
import { clientNativeId, infraNativeId, unifiStableId } from './unifi-discovery.js'
import { type UnifiCandidateKind, unifiDeviceTarget } from './unifi-device-kind.js'
import { buildInfraFeatures } from './unifi-mapping.js'
import { unifiControllers } from './unifi-node-resolver.js'

export interface UnifiAdoptInput {
  readonly integrationId: string
  readonly name: string
}

/** The create meta of a candidate: type and role from the one table (`unifiDeviceTarget`). */
function adoptMeta(
  kind: UnifiCandidateKind,
  name: string,
  integrationId: string,
): InitialDeviceMeta {
  const target = unifiDeviceTarget(kind)
  return {
    type: target.type,
    name,
    integrationId,
    ...(target.role !== null ? { role: target.role } : {}),
  }
}

/**
 * Creates the top-level devices of a UniFi integration. Every infra device (a console is the
 * workload Host; there is no Gateway, D1064) and every client Presence are SIBLINGS
 * (`parentDeviceId` null); the integration, not a device, owns the connection, so each device only carries the `integrationId` it follows.
 */
export function buildUnifiDeviceAdopter(input: {
  readonly devices: Pick<DeviceManagerApi, 'create' | 'getChildren'>
}): {
  readonly adoptInfra: (
    args: UnifiAdoptInput & { readonly infraId: string },
  ) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  readonly adoptClient: (
    args: UnifiAdoptInput & { readonly mac: string },
  ) => Promise<{ readonly deviceId: number }>
} {
  const { devices } = input
  return {
    adoptInfra: async ({ integrationId, name, infraId }) => {
      let infra = unifiControllers.getInfra(integrationId, infraId)
      if (infra === null) {
        // A device the controller gained since the last read: one re-list before refusing.
        await unifiControllers.getManager(integrationId)?.poll()
        infra = unifiControllers.getInfra(integrationId, infraId)
      }
      if (infra === null) {
        throw new Error(`unifi adopt: no infra device ${infraId} on integration ${integrationId}`)
      }
      const config = {
        integrationId,
        infraNativeId: infraId,
        model: infra.model,
        features: buildInfraFeatures(infra),
        system: UNIFI_SYSTEM,
        name,
      }
      const device = await devices.create(
        unifiStableId(integrationId, infraNativeId(infraId)),
        UnifiInfraDevice,
        config,
        null,
        adoptMeta(infra.kind, name, integrationId),
      )
      const children = await devices.getChildren(device.id)
      return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
    },
    adoptClient: async ({ integrationId, name, mac }) => {
      if (unifiControllers.getClient(integrationId, mac) === null) {
        throw new Error(`unifi adopt: no client ${mac} on integration ${integrationId}`)
      }
      const config = { kind: 'presence', integrationId, mac, system: UNIFI_SYSTEM, name }
      const device = await devices.create(
        unifiStableId(integrationId, clientNativeId(mac)),
        UnifiFeatureDevice,
        config,
        null,
        adoptMeta('client', name, integrationId),
      )
      return { deviceId: device.id }
    },
  }
}

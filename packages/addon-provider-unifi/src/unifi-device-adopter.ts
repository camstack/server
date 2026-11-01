import { type DeviceManagerApi, DeviceType } from '@camstack/types'
import { UNIFI_SYSTEM } from './config.js'
import { UnifiFeatureDevice } from './devices/unifi-feature-device.js'
import { UnifiGatewayDevice } from './devices/unifi-gateway-device.js'
import { UnifiInfraDevice } from './devices/unifi-infra-device.js'
import {
  clientNativeId,
  infraNativeId,
  UNIFI_GATEWAY_ID,
  unifiStableId,
} from './unifi-discovery.js'
import { buildInfraFeatures } from './unifi-mapping.js'
import { unifiControllers } from './unifi-node-resolver.js'

export interface UnifiAdoptInput {
  readonly integrationId: string
  readonly name: string
}

/**
 * Creates the top-level devices of a UniFi integration. The Gateway, every infra Container
 * and every client Presence are SIBLINGS (`parentDeviceId` null); the integration, not a
 * device, owns the connection, so each device only carries the `integrationId` it follows.
 */
export function buildUnifiDeviceAdopter(input: {
  readonly devices: Pick<DeviceManagerApi, 'create' | 'getChildren'>
}): {
  readonly adoptGateway: (args: UnifiAdoptInput) => Promise<{ readonly deviceId: number }>
  readonly adoptInfra: (
    args: UnifiAdoptInput & { readonly infraId: string },
  ) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  readonly adoptClient: (
    args: UnifiAdoptInput & { readonly mac: string },
  ) => Promise<{ readonly deviceId: number }>
} {
  const { devices } = input
  return {
    adoptGateway: async ({ integrationId, name }) => {
      const config = { nativeId: UNIFI_GATEWAY_ID, integrationId, system: UNIFI_SYSTEM }
      const device = await devices.create(
        unifiStableId(integrationId, UNIFI_GATEWAY_ID),
        UnifiGatewayDevice,
        config,
        null,
        { type: DeviceType.Gateway, name, integrationId },
      )
      return { deviceId: device.id }
    },
    adoptInfra: async ({ integrationId, name, infraId }) => {
      const infra = unifiControllers.getInfra(integrationId, infraId)
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
        { type: DeviceType.Container, name, integrationId },
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
        { type: DeviceType.Presence, name, integrationId },
      )
      return { deviceId: device.id }
    },
  }
}

import { type DeviceManagerApi, DeviceType } from '@camstack/types'
import { UNRAID_SYSTEM } from './config.js'
import { UnraidGatewayDevice } from './devices/unraid-gateway-device.js'
import { UnraidInstanceDevice } from './devices/unraid-instance-device.js'
import type { UnraidSnapshot } from './unraid-client-contract.js'
import { UNRAID_GATEWAY_ID, UNRAID_INSTANCE_ID, unraidStableId } from './unraid-discovery.js'
import { identitiesOf } from './unraid-entity-reconcile.js'

/**
 * Creates the two top-level devices of an Unraid integration. The Gateway and the instance
 * Container are SIBLINGS (`parentDeviceId` null); the integration, not a device, owns the
 * connection, so every device only carries the `integrationId` it follows.
 */
export function buildUnraidDeviceAdopter(input: {
  readonly devices: Pick<DeviceManagerApi, 'create' | 'getChildren'>
  readonly getSnapshot: (integrationId: string) => UnraidSnapshot | null
}): {
  readonly adoptGateway: (args: {
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  readonly adoptInstance: (args: {
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
} {
  const { devices, getSnapshot } = input
  return {
    adoptGateway: async ({ integrationId, name }) => {
      const config = { nativeId: UNRAID_GATEWAY_ID, integrationId, system: UNRAID_SYSTEM }
      const device = await devices.create(
        unraidStableId(integrationId, UNRAID_GATEWAY_ID),
        UnraidGatewayDevice,
        config,
        null,
        { type: DeviceType.Gateway, name, integrationId },
      )
      return { deviceId: device.id }
    },
    adoptInstance: async ({ integrationId, name }) => {
      const config = {
        nativeId: UNRAID_INSTANCE_ID,
        instanceId: integrationId,
        integrationId,
        entities: identitiesOf(getSnapshot(integrationId)),
        system: UNRAID_SYSTEM,
        name,
      }
      const device = await devices.create(
        unraidStableId(integrationId, UNRAID_INSTANCE_ID),
        UnraidInstanceDevice,
        config,
        null,
        { type: DeviceType.Container, name, integrationId },
      )
      const children = await devices.getChildren(device.id)
      return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
    },
  }
}

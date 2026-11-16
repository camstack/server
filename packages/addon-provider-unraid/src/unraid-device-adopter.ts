import { type DeviceManagerApi, DeviceRole, DeviceType } from '@camstack/types'
import { UNRAID_SYSTEM } from './config.js'
import { UnraidGatewayDevice } from './devices/unraid-gateway-device.js'
import { UnraidInstanceDevice } from './devices/unraid-instance-device.js'
import { UnraidWorkloadDevice } from './devices/unraid-workload-device.js'
import type { UnraidSnapshot } from './unraid-client-contract.js'
import {
  findWorkload,
  parseUnraidNativeId,
  UNRAID_GATEWAY_ID,
  UNRAID_INSTANCE_ID,
  unraidStableId,
} from './unraid-discovery.js'
import { identitiesOf } from './unraid-entity-reconcile.js'
import { unraidWorkloadRole } from './unraid-workload-state.js'

/** Inputs of one container / VM adoption: its `childNativeId` (`docker:…` / `vm:…`). */
export interface UnraidWorkloadAdoptInput {
  readonly integrationId: string
  readonly name: string
  readonly nativeId: string
}

/**
 * Creates the top-level devices of an Unraid integration. The Gateway, the instance
 * Container and every adopted Docker container / VM are SIBLINGS (`parentDeviceId` null);
 * the integration, not a device, owns the connection, so every device only carries the
 * `integrationId` it follows.
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
  readonly adoptWorkload: (args: UnraidWorkloadAdoptInput) => Promise<{ readonly deviceId: number }>
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
        { type: DeviceType.Workload, role: DeviceRole.Host, name, integrationId },
      )
      const children = await devices.getChildren(device.id)
      return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
    },
    adoptWorkload: async ({ integrationId, name, nativeId }) => {
      const parsed = parseUnraidNativeId(nativeId)
      if (parsed?.kind !== 'workload') {
        throw new Error(`unraid adopt: ${nativeId} is not a container or a VM`)
      }
      // Only what the server lists right now is adopted: a stale or mistyped id is refused.
      if (findWorkload(getSnapshot(integrationId), parsed.ref) === null) {
        throw new Error(`unraid adopt: no ${nativeId} on integration ${integrationId}`)
      }
      const config = {
        nativeId,
        integrationId,
        workload: parsed.ref,
        system: UNRAID_SYSTEM,
        name,
      }
      const device = await devices.create(
        unraidStableId(integrationId, nativeId),
        UnraidWorkloadDevice,
        config,
        null,
        {
          type: DeviceType.Workload,
          role: unraidWorkloadRole(parsed.ref.kind),
          name,
          integrationId,
        },
      )
      return { deviceId: device.id }
    },
  }
}

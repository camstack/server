/**
 * Discovery and adoption for Zigbee2MQTT. The Gateway and every sensor are offered as
 * SIBLING candidates (the Gateway is never the parent of the sensors); adopting one creates a
 * top-level device carrying the integration id. Replace `discover` with a real read of the remote.
 */
import {
  DeviceType,
  type DiscoveredChildDevice,
  errMsg,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import { Z2M_GATEWAY_ID } from './z2m-device-config.js'
import type { Z2mPlan } from './z2m-exposes.js'

/** A device the Zigbee2MQTT server lists and CamStack could adopt: its ieee address and its plan. */
export interface RemoteZigbeeDevice {
  readonly id: string
  readonly name: string
  readonly type: DeviceType
  readonly online: boolean | null
  readonly plan: Z2mPlan
}

export interface ProviderZigbeeZ2mAdoptionDeps {
  readonly hasIntegration: (integrationId: string) => Promise<boolean>
  readonly listIntegrations: () => Promise<readonly string[]>
  /** What the remote reports for the integration, or null while it is unreachable. */
  readonly discover: (integrationId: string) => Promise<readonly RemoteZigbeeDevice[] | null>
  /** Remote ids of the devices already adopted for the integration, with their device id. */
  readonly adopted: (integrationId: string) => Promise<ReadonlyMap<string, number>>
  readonly create: (input: {
    readonly integrationId: string
    readonly equipment: string
    readonly type: DeviceType
    readonly name: string
    readonly plan: Z2mPlan | null
  }) => Promise<number>
  readonly remove: (deviceId: number) => Promise<void>
  readonly logger: IScopedLogger
}

export function buildProviderZigbeeZ2mAdoptionProvider(
  deps: ProviderZigbeeZ2mAdoptionDeps,
): IDeviceAdoptionProvider {
  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    const sensors = await deps.discover(integrationId)
    const adopted = await deps.adopted(integrationId)
    const offered: DiscoveredChildDevice[] = [
      {
        childNativeId: Z2M_GATEWAY_ID,
        name: 'Zigbee2MQTT',
        type: DeviceType.Gateway,
        status: sensors === null ? 'offline' : 'online',
        metadata: {},
        alreadyAdopted: adopted.has(Z2M_GATEWAY_ID),
        adoptedDeviceId: adopted.get(Z2M_GATEWAY_ID) ?? null,
        capabilities: [],
      },
    ]
    for (const remote of sensors ?? []) {
      offered.push({
        childNativeId: remote.id,
        name: remote.name,
        type: remote.type,
        status: remote.online === false ? 'offline' : 'online',
        metadata: {},
        alreadyAdopted: adopted.has(remote.id),
        adoptedDeviceId: adopted.get(remote.id) ?? null,
        capabilities: remote.plan.capabilities,
      })
    }
    return offered
  }

  async function status(integrationId: string) {
    const all = await candidates(integrationId)
    return {
      lastDiscoveryAt: Date.now(),
      candidateCount: all.length,
      adoptedCount: all.filter((c) => c.alreadyAdopted).length,
      lastError: null,
    }
  }

  return {
    listCandidateFilters: async () => ({
      filters: [{ id: 'devices', label: 'Devices', isDefault: true }],
    }),
    listCandidates: async ({ integrationId, page, pageSize }) => {
      const all = await candidates(integrationId)
      const start = (page - 1) * pageSize
      return {
        candidates: all.slice(start, start + pageSize),
        totalCount: all.length,
        page,
        pageSize,
      }
    },
    getCandidate: async ({ integrationId, childNativeId }) =>
      (await candidates(integrationId)).find((c) => c.childNativeId === childNativeId) ?? null,
    getStatus: async () => {
      try {
        let candidateCount = 0
        let adoptedCount = 0
        for (const integrationId of await deps.listIntegrations()) {
          const s = await status(integrationId)
          candidateCount += s.candidateCount
          adoptedCount += s.adoptedCount
        }
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        }
      } catch (err: unknown) {
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        }
      }
    },
    refresh: async ({ integrationId }) => status(integrationId),
    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!(await deps.hasIntegration(integrationId))) {
        throw new Error('provider-zigbee-z2m adopt: integration ' + integrationId + ' not found')
      }
      const offered = await candidates(integrationId)
      const remotes = await deps.discover(integrationId)
      const adopted: Array<{
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }> = []
      for (const childNativeId of childNativeIds) {
        const candidate = offered.find((c) => c.childNativeId === childNativeId)
        if (candidate === undefined) {
          deps.logger.warn('provider-zigbee-z2m adopt: the remote reports nothing for this id', {
            meta: { childNativeId, integrationId },
          })
          continue
        }
        const deviceId = await deps.create({
          integrationId,
          equipment: childNativeId,
          type: candidate.type,
          name: perCandidate?.[childNativeId]?.name ?? candidate.name,
          plan: remotes?.find((r) => r.id === childNativeId)?.plan ?? null,
        })
        adopted.push({
          childNativeId,
          parentDeviceId: deviceId,
          accessoryDeviceIds: [],
        })
      }
      if (adopted.length === 0) throw new Error('provider-zigbee-z2m adopt: nothing was adopted')
      return { adopted }
    },
    release: async ({ camDeviceId }) => {
      await deps.remove(camDeviceId)
    },
    resync: async () => ({ changed: false, rebuiltChildren: 0 }),
  }
}

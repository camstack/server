import { errMsg, type IDeviceAdoptionProvider, type IScopedLogger } from '@camstack/types'
import type { AdoptionFilter, AdoptionStatus } from '@camstack/types'
import type { MqttHaDiscoveryStore } from './mqtt-ha-discovery-store.js'
import {
  adoptableMqttHaDevices,
  buildMqttHaDeviceCandidate,
  type MqttHaAdoptable,
} from './mqtt-ha-discovery.js'

const ENTITIES_FILTER: AdoptionFilter = {
  id: 'devices',
  label: 'Devices',
  isDefault: true,
}

export interface MqttHaAdoptionProviderDeps {
  readonly store: MqttHaDiscoveryStore
  readonly getMqttBrokerIdForIntegration: (integrationId: string) => Promise<string>
  readonly listAdoptedMqttHa: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptDevice: (input: {
    readonly brokerId: string
    readonly adoptable: MqttHaAdoptable
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly logger: IScopedLogger
}

/**
 * The device already adopted for this candidate. A group adopted by this flow
 * carries `deviceKey`. A device adopted before devices were grouped (or a lone
 * entity) carries only `entityKey`; it keeps its stableId and deviceId, and the
 * candidate that now contains that entity reports it as adopted instead of
 * offering a duplicate.
 */
async function adoptedDeviceIdFor(
  brokerId: string,
  adoptable: MqttHaAdoptable,
  listAdopted: MqttHaAdoptionProviderDeps['listAdoptedMqttHa'],
): Promise<number | null> {
  const { nativeId, entities } = adoptable.device
  const memberKeys = new Set(entities.map((e) => e.entityKey))
  for (const d of await listAdopted()) {
    if (d.config['system'] !== 'mqtt-ha' || d.config['brokerId'] !== brokerId) continue
    const deviceKey = d.config['deviceKey']
    const entityKey = d.config['entityKey']
    if (deviceKey === nativeId) return d.id
    if (deviceKey === undefined && typeof entityKey === 'string' && memberKeys.has(entityKey)) {
      return d.id
    }
  }
  return null
}

export function buildMqttHaAdoptionProvider(
  deps: MqttHaAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const {
    store,
    getMqttBrokerIdForIntegration,
    listAdoptedMqttHa,
    adoptDevice,
    removeDevice,
    logger,
  } = deps

  async function candidatesForBroker(brokerId: string) {
    const out = []
    for (const adoptable of adoptableMqttHaDevices(store.listForBroker(brokerId))) {
      const adoptedDeviceId = await adoptedDeviceIdFor(brokerId, adoptable, listAdoptedMqttHa)
      out.push(buildMqttHaDeviceCandidate({ adoptable, adoptedDeviceId }))
    }
    return out
  }

  return {
    listCandidateFilters: async () => ({ filters: [ENTITIES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize, filterText }) => {
      const brokerId = await getMqttBrokerIdForIntegration(integrationId)
      let candidates = await candidatesForBroker(brokerId)
      if (filterText?.search) {
        const q = filterText.search.toLowerCase()
        candidates = candidates.filter(
          (c) => c.name.toLowerCase().includes(q) || c.childNativeId.toLowerCase().includes(q),
        )
      }
      if (filterText?.unadoptedOnly === true) {
        candidates = candidates.filter((c) => !c.alreadyAdopted)
      }
      if (filterText?.adoptedOnly === true) {
        candidates = candidates.filter((c) => c.alreadyAdopted)
      }
      const totalCount = candidates.length
      const start = (page - 1) * pageSize
      const slice = candidates.slice(start, start + pageSize)
      return { candidates: slice, totalCount, page, pageSize }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      const brokerId = await getMqttBrokerIdForIntegration(integrationId)
      const adoptable = adoptableMqttHaDevices(store.listForBroker(brokerId)).find(
        (a) => a.device.nativeId === childNativeId,
      )
      if (adoptable === undefined) return null
      const adoptedDeviceId = await adoptedDeviceIdFor(brokerId, adoptable, listAdoptedMqttHa)
      return buildMqttHaDeviceCandidate({ adoptable, adoptedDeviceId })
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        for (const brokerId of store.listBrokerIds()) {
          candidateCount += (await candidatesForBroker(brokerId)).length
        }
        const adopted = await listAdoptedMqttHa()
        const adoptedCount = adopted.filter((d) => d.config['system'] === 'mqtt-ha').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('mqtt-ha adoption: getStatus failed', { meta: { error: errMsg(err) } })
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        } satisfies AdoptionStatus
      }
    },

    refresh: async ({ integrationId }) => {
      const brokerId = await getMqttBrokerIdForIntegration(integrationId)
      const candidates = await candidatesForBroker(brokerId)
      const adopted = await listAdoptedMqttHa()
      const adoptedCount = adopted.filter(
        (d) => d.config['system'] === 'mqtt-ha' && d.config['brokerId'] === brokerId,
      ).length
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount: candidates.length,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      const brokerId = await getMqttBrokerIdForIntegration(integrationId)
      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      const adoptables = adoptableMqttHaDevices(store.listForBroker(brokerId))
      for (const nativeId of childNativeIds) {
        const adoptable = adoptables.find((a) => a.device.nativeId === nativeId)
        if (adoptable === undefined) {
          logger.warn('mqtt-ha adopt: device not in discovery inventory — skipping', {
            meta: { brokerId, nativeId },
          })
          failures++
          continue
        }
        try {
          const name = perCandidate?.[nativeId]?.name ?? adoptable.device.name
          const { deviceId } = await adoptDevice({ brokerId, adoptable, integrationId, name })
          adopted.push({
            childNativeId: nativeId,
            parentDeviceId: deviceId,
            accessoryDeviceIds: [],
          })
        } catch (err: unknown) {
          logger.warn('mqtt-ha adopt: failed for device', {
            meta: { brokerId, nativeId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`mqtt-ha adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      void camDeviceId
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}

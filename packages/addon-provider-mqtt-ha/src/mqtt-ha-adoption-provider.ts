import { errMsg, type IDeviceAdoptionProvider, type IScopedLogger } from '@camstack/types'
import type { AdoptionFilter, AdoptionStatus } from '@camstack/types'
import type { MqttHaDiscoveryStore } from './mqtt-ha-discovery-store.js'
import { buildMqttHaEntityCandidate, mappableMqttHaEntity } from './mqtt-ha-discovery.js'

const ENTITIES_FILTER: AdoptionFilter = {
  id: 'entities',
  label: 'Entities',
  isDefault: true,
}

export interface MqttHaAdoptionProviderDeps {
  readonly store: MqttHaDiscoveryStore
  readonly getMqttBrokerIdForIntegration: (integrationId: string) => Promise<string>
  readonly listAdoptedMqttHa: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptEntity: (input: {
    readonly brokerId: string
    readonly entityKey: string
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly logger: IScopedLogger
}

async function adoptedDeviceIdForEntity(
  brokerId: string,
  entityKey: string,
  listAdopted: MqttHaAdoptionProviderDeps['listAdoptedMqttHa'],
): Promise<number | null> {
  for (const d of await listAdopted()) {
    if (
      d.config['system'] === 'mqtt-ha' &&
      d.config['brokerId'] === brokerId &&
      d.config['entityKey'] === entityKey
    ) {
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
    adoptEntity,
    removeDevice,
    logger,
  } = deps

  async function candidatesForBroker(brokerId: string) {
    const entities = store.listForBroker(brokerId).filter(mappableMqttHaEntity)
    const out = []
    for (const entity of entities) {
      const adoptedDeviceId = await adoptedDeviceIdForEntity(
        brokerId,
        entity.entityKey,
        listAdoptedMqttHa,
      )
      out.push(buildMqttHaEntityCandidate({ entity, adoptedDeviceId }))
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
      const entity = store.get(brokerId, childNativeId)
      if (entity === null || !mappableMqttHaEntity(entity)) return null
      const adoptedDeviceId = await adoptedDeviceIdForEntity(
        brokerId,
        entity.entityKey,
        listAdoptedMqttHa,
      )
      return buildMqttHaEntityCandidate({ entity, adoptedDeviceId })
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

      for (const entityKey of childNativeIds) {
        const entity = store.get(brokerId, entityKey)
        if (entity === null || !mappableMqttHaEntity(entity)) {
          logger.warn('mqtt-ha adopt: entity not in discovery inventory — skipping', {
            meta: { brokerId, entityKey },
          })
          failures++
          continue
        }
        try {
          const name = perCandidate?.[entityKey]?.name ?? entity.name
          const { deviceId } = await adoptEntity({
            brokerId,
            entityKey,
            integrationId,
            name,
          })
          adopted.push({
            childNativeId: entityKey,
            parentDeviceId: deviceId,
            accessoryDeviceIds: [],
          })
        } catch (err: unknown) {
          logger.warn('mqtt-ha adopt: failed for entity', {
            meta: { brokerId, entityKey, error: errMsg(err) },
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

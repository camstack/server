import {
  errMsg,
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import { buildEnpalCandidates } from './enpal-discovery.js'
import { ENPAL_SYSTEM } from './config.js'
import { findEquipment } from './enpal-equipment.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'

export interface EnpalAdoptionProviderDeps {
  readonly getSnapshot: (integrationId: string) => EnpalSnapshot | null
  readonly hasIntegration: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  readonly listAdopted: () => Promise<
    ReadonlyArray<{
      readonly id: number
      readonly config: Record<string, unknown>
    }>
  >
  /** Create the equipment Container; the kernel spawns its children. */
  readonly adoptDevice: (input: {
    readonly equipment: string
    readonly specIds: readonly string[]
    readonly integrationId: string
    readonly name: string
  }) => Promise<{
    readonly deviceId: number
    readonly accessoryDeviceIds: readonly number[]
  }>
  readonly removeDevice: (deviceId: number) => Promise<void>
  readonly findDeviceConfig: (deviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = {
  id: 'devices',
  label: 'Devices',
  isDefault: true,
}

export function buildEnpalAdoptionProvider(
  deps: EnpalAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const { getSnapshot, hasIntegration, listIntegrations, listAdopted, logger } = deps

  async function adoptedMap(integrationId: string): Promise<ReadonlyMap<string, number>> {
    const map = new Map<string, number>()
    for (const device of await listAdopted()) {
      const cfg = device.config
      if (cfg['system'] !== ENPAL_SYSTEM || cfg['integrationId'] !== integrationId) continue
      const equipment = cfg['equipment']
      if (typeof equipment === 'string') map.set(equipment, device.id)
    }
    return map
  }

  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    return buildEnpalCandidates({
      snapshot: getSnapshot(integrationId),
      adopted: await adoptedMap(integrationId),
    })
  }

  async function status(integrationId: string): Promise<AdoptionStatus> {
    return {
      lastDiscoveryAt: Date.now(),
      candidateCount: (await candidates(integrationId)).length,
      adoptedCount: (await adoptedMap(integrationId)).size,
      lastError: null,
    }
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

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

    getCandidate: async ({ integrationId, childNativeId }) => {
      const all = await candidates(integrationId)
      return all.find((c) => c.childNativeId === childNativeId) ?? null
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        let adoptedCount = 0
        for (const integrationId of listIntegrations()) {
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
      if (!hasIntegration(integrationId)) {
        throw new Error(`enpal adopt: integration ${integrationId} not found`)
      }
      const offered = await candidates(integrationId)
      const adopted: Array<{
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }> = []
      let failures = 0
      for (const equipmentId of childNativeIds) {
        try {
          const candidate = offered.find((c) => c.childNativeId === equipmentId)
          const equipment = findEquipment(equipmentId)
          if (candidate === undefined || equipment === undefined) {
            logger.warn('enpal adopt: the box reports nothing for this equipment — skipping', {
              meta: { equipment: equipmentId, integrationId },
            })
            failures++
            continue
          }
          const reported = new Set((candidate.children ?? []).map((c) => c.childNativeId))
          const specIds = equipment.specIds.filter((id) => reported.has(`${equipment.id}#${id}`))
          const { deviceId, accessoryDeviceIds } = await deps.adoptDevice({
            equipment: equipment.id,
            specIds,
            integrationId,
            name: perCandidate?.[equipmentId]?.name ?? equipment.name,
          })
          adopted.push({
            childNativeId: equipmentId,
            parentDeviceId: deviceId,
            accessoryDeviceIds,
          })
        } catch (err: unknown) {
          logger.warn('enpal adopt: failed to adopt equipment', {
            meta: { equipment: equipmentId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }
      if (adopted.length === 0 && failures > 0) {
        throw new Error(`enpal adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await deps.removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await deps.findDeviceConfig(camDeviceId)
      if (cfg === null || cfg['system'] !== ENPAL_SYSTEM) {
        throw new Error(`enpal resync: device ${camDeviceId} is not an Enpal device`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}

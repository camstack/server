import {
  errMsg,
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import { ECOWITT_SYSTEM } from './config.js'
import { ECOWITT_GATEWAY_DEVICE_KIND } from './devices/ecowitt-gateway-device.js'
import {
  buildEcowittGatewayCandidates,
  type EcowittDiscoverableSensor,
  gatewayDeviceNativeId,
  groupNativeId,
} from './ecowitt-discovery.js'
import { ECOWITT_DEVICE_GROUPS, type EcowittDeviceGroup } from './ecowitt-mapping.js'
import { configDeviceGroup } from './ecowitt-sensor-groups.js'

export interface EcowittAdoptionProviderDeps {
  /** The integration's live sensors, or [] while its gateway is unreachable. */
  readonly getSensors: (integrationId: string) => readonly EcowittDiscoverableSensor[]
  /** The integration's gateway key, or null when no client runs for it. */
  readonly gatewayKeyOf: (integrationId: string) => string | null
  readonly listIntegrations: () => readonly string[]
  /** The integration's display name, or null when it is unknown. */
  readonly integrationName: (integrationId: string) => Promise<string | null>
  readonly isOnline: (integrationId: string) => boolean
  readonly hasAdminLink: (integrationId: string) => boolean
  /** Top-level devices of this addon with their persisted blob. */
  readonly listAdopted: () => Promise<
    ReadonlyArray<{
      readonly id: number
      readonly config: Record<string, unknown>
    }>
  >
  /** Create the group Container (top-level); the kernel spawns its sensors. */
  readonly adoptContainer: (input: {
    readonly integrationId: string
    readonly gatewayKey: string
    readonly group: EcowittDeviceGroup
    readonly name: string
  }) => Promise<{
    readonly deviceId: number
    readonly accessoryDeviceIds: readonly number[]
  }>
  /** Create the Gateway device (top-level). */
  readonly adoptGateway: (input: {
    readonly integrationId: string
    readonly gatewayKey: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (deviceId: number) => Promise<void>
  readonly findDeviceConfig: (deviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = {
  id: 'devices',
  label: 'Devices',
  isDefault: true,
}

interface Adopted {
  gateway: number | null
  byGroup: Partial<Record<EcowittDeviceGroup, number | null>>
}

export function buildEcowittAdoptionProvider(
  deps: EcowittAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const { logger } = deps

  async function adopted(integrationId: string): Promise<Adopted> {
    const out: Adopted = { gateway: null, byGroup: {} }
    for (const device of await deps.listAdopted()) {
      const cfg = device.config
      if (cfg['system'] !== ECOWITT_SYSTEM || cfg['integrationId'] !== integrationId) continue
      if (cfg['kind'] === ECOWITT_GATEWAY_DEVICE_KIND) out.gateway = device.id
      else out.byGroup[configDeviceGroup(cfg)] = device.id
    }
    return out
  }

  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    const gatewayKey = deps.gatewayKeyOf(integrationId)
    if (gatewayKey === null) return []
    const have = await adopted(integrationId)
    return buildEcowittGatewayCandidates({
      gatewayId: gatewayKey,
      gatewayName: (await deps.integrationName(integrationId)) ?? 'Ecowitt',
      gateway: {
        online: deps.isOnline(integrationId),
        hasAdminLink: deps.hasAdminLink(integrationId),
        adoptedDeviceId: have.gateway,
      },
      sensors: deps.getSensors(integrationId),
      adoptedDeviceIdByGroup: have.byGroup,
    })
  }

  async function status(integrationId: string): Promise<AdoptionStatus> {
    const all = await candidates(integrationId)
    return {
      lastDiscoveryAt: Date.now(),
      candidateCount: all.length,
      adoptedCount: all.filter((c) => c.alreadyAdopted).length,
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
        for (const integrationId of deps.listIntegrations()) {
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
      const gatewayKey = deps.gatewayKeyOf(integrationId)
      if (gatewayKey === null) {
        throw new Error(`ecowitt adopt: integration ${integrationId} has no running client`)
      }
      const baseName = (await deps.integrationName(integrationId)) ?? 'Ecowitt'
      const have = await adopted(integrationId)
      const result: Array<{
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }> = []
      let failures = 0
      for (const nativeId of childNativeIds) {
        try {
          const chosenName = perCandidate?.[nativeId]?.name
          if (nativeId === gatewayDeviceNativeId(gatewayKey)) {
            if (have.gateway !== null) {
              result.push({
                childNativeId: nativeId,
                parentDeviceId: have.gateway,
                accessoryDeviceIds: [],
              })
              continue
            }
            const { deviceId } = await deps.adoptGateway({
              integrationId,
              gatewayKey,
              name: chosenName ?? baseName,
            })
            result.push({
              childNativeId: nativeId,
              parentDeviceId: deviceId,
              accessoryDeviceIds: [],
            })
            continue
          }
          const group = ECOWITT_DEVICE_GROUPS.find((g) => groupNativeId(gatewayKey, g) === nativeId)
          if (group === undefined) {
            logger.warn('ecowitt adopt: not a candidate of this gateway — skipping', {
              meta: { nativeId, integrationId },
            })
            failures++
            continue
          }
          const existing = have.byGroup[group]
          if (typeof existing === 'number') {
            result.push({
              childNativeId: nativeId,
              parentDeviceId: existing,
              accessoryDeviceIds: [],
            })
            continue
          }
          const { deviceId, accessoryDeviceIds } = await deps.adoptContainer({
            integrationId,
            gatewayKey,
            group,
            name: chosenName ?? `${baseName} — ${group}`,
          })
          result.push({
            childNativeId: nativeId,
            parentDeviceId: deviceId,
            accessoryDeviceIds,
          })
        } catch (err: unknown) {
          logger.warn('ecowitt adopt: failed to adopt a candidate', {
            meta: { nativeId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }
      if (result.length === 0 && failures > 0) {
        throw new Error(`ecowitt adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted: result }
    },

    release: async ({ camDeviceId }) => {
      await deps.removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await deps.findDeviceConfig(camDeviceId)
      if (cfg === null || cfg['system'] !== ECOWITT_SYSTEM) {
        throw new Error(`ecowitt resync: device ${camDeviceId} is not an Ecowitt device`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}

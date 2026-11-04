import {
  errMsg,
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import { VESYNC_SYSTEM } from './config.js'
import type { VeSyncPurifierSnapshot } from './vesync-client-contract.js'
import {
  buildVeSyncCandidates,
  parsePurifierNativeId,
  VESYNC_GATEWAY_NATIVE_ID,
} from './vesync-discovery.js'

export interface VeSyncAdoptionProviderDeps {
  readonly getPurifiers: (integrationId: string) => readonly VeSyncPurifierSnapshot[]
  readonly hasIntegration: (integrationId: string) => boolean
  readonly integrationOnline: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  readonly integrationName: (integrationId: string) => string | null
  readonly listAdopted: () => Promise<
    ReadonlyArray<{
      readonly id: number
      readonly config: Record<string, unknown>
    }>
  >
  /** Create the purifier Fan, parent null. The kernel spawns its accessories. */
  readonly adoptPurifier: (input: {
    readonly integrationId: string
    readonly cid: string
    readonly name: string
    readonly model: string | undefined
  }) => Promise<{ readonly deviceId: number }>
  /** Create the top-level Gateway device of the account. */
  readonly adoptGateway: (input: {
    readonly integrationId: string
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

export function buildVeSyncAdoptionProvider(
  deps: VeSyncAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const accountName = (integrationId: string): string =>
    deps.integrationName(integrationId) ?? 'VeSync'

  async function adoptedOf(integrationId: string): Promise<{
    readonly gatewayId: number | null
    readonly byCid: Record<string, number | null>
  }> {
    let gatewayId: number | null = null
    const byCid: Record<string, number | null> = {}
    for (const device of await deps.listAdopted()) {
      const cfg = device.config
      if (cfg['system'] !== VESYNC_SYSTEM || cfg['integrationId'] !== integrationId) continue
      if (cfg['kind'] === VESYNC_GATEWAY_NATIVE_ID) gatewayId = device.id
      const cid = cfg['purifierNativeId']
      if (typeof cid === 'string') byCid[cid] = device.id
    }
    return { gatewayId, byCid }
  }

  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    const adopted = await adoptedOf(integrationId)
    return buildVeSyncCandidates({
      integrationId,
      accountName: accountName(integrationId),
      online: deps.integrationOnline(integrationId),
      purifiers: deps.getPurifiers(integrationId),
      adoptedGatewayId: adopted.gatewayId,
      adoptedDeviceIdByCid: adopted.byCid,
    })
  }

  async function status(integrationId: string): Promise<AdoptionStatus> {
    const adopted = await adoptedOf(integrationId)
    const purifierCount = Object.keys(adopted.byCid).length
    return {
      lastDiscoveryAt: Date.now(),
      candidateCount: (await candidates(integrationId)).length,
      adoptedCount: purifierCount + (adopted.gatewayId === null ? 0 : 1),
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
        return { lastDiscoveryAt: Date.now(), candidateCount, adoptedCount, lastError: null }
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
      if (!deps.hasIntegration(integrationId)) {
        throw new Error(`vesync adopt: integration ${integrationId} not found`)
      }
      const adopted: Array<{
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }> = []
      let failures = 0
      for (const nativeId of childNativeIds) {
        try {
          if (nativeId === VESYNC_GATEWAY_NATIVE_ID) {
            const { deviceId } = await deps.adoptGateway({
              integrationId,
              name: perCandidate?.[nativeId]?.name ?? accountName(integrationId),
            })
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: deviceId,
              accessoryDeviceIds: [],
            })
            continue
          }
          const cid = parsePurifierNativeId(nativeId)
          if (cid === null) {
            deps.logger.warn('vesync adopt: not a purifier native id — skipping', {
              meta: { nativeId, integrationId },
            })
            failures++
            continue
          }
          const purifier = deps.getPurifiers(integrationId).find((p) => p.nativeId === cid)
          if (purifier === undefined) {
            deps.logger.warn('vesync adopt: the account reports no such purifier — skipping', {
              meta: { cid, integrationId },
            })
            failures++
            continue
          }
          const name =
            perCandidate?.[nativeId]?.name ??
            (purifier.name.length > 0 ? purifier.name : `purifier ${cid}`)
          const { deviceId } = await deps.adoptPurifier({
            integrationId,
            cid,
            name,
            model: purifier.model,
          })
          adopted.push({
            childNativeId: nativeId,
            parentDeviceId: deviceId,
            accessoryDeviceIds: [],
          })
        } catch (err: unknown) {
          deps.logger.warn('vesync adopt: failed to adopt', {
            meta: { nativeId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }
      if (adopted.length === 0 && failures > 0) {
        throw new Error(`vesync adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await deps.removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await deps.findDeviceConfig(camDeviceId)
      if (cfg === null || cfg['system'] !== VESYNC_SYSTEM) {
        throw new Error(`vesync resync: device ${camDeviceId} is not a VeSync device`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}

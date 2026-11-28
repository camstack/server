import {
  errMsg,
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@dominevo/types'
import { VESYNC_SYSTEM } from './config.js'
import type { VeSyncDeviceSnapshot } from './vesync-client-contract.js'
import {
  buildVeSyncCandidates,
  parseHumidifierNativeId,
  parsePurifierNativeId,
} from './vesync-discovery.js'

export interface VeSyncAdoptionProviderDeps {
  /** Every purifier and humidifier the account lists. */
  readonly getDevices: (integrationId: string) => readonly VeSyncDeviceSnapshot[]
  readonly hasIntegration: (integrationId: string) => boolean
  readonly integrationOnline: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  readonly integrationName: (integrationId: string) => string | null
  /** Start one background re-read of the account when its list is stale (never waits). */
  readonly revalidate: (integrationId: string) => void
  /** Re-list the account and resolve once it landed (joins a list already running). */
  readonly relist: (integrationId: string) => Promise<void>
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
  /** Create the humidifier, parent null. The kernel spawns its accessories. */
  readonly adoptHumidifier: (input: {
    readonly integrationId: string
    readonly cid: string
    readonly name: string
    readonly model: string | undefined
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
    readonly byCid: Record<string, number | null>
  }> {
    const byCid: Record<string, number | null> = {}
    for (const device of await deps.listAdopted()) {
      const cfg = device.config
      if (cfg['system'] !== VESYNC_SYSTEM || cfg['integrationId'] !== integrationId) continue
      const cid = cfg['purifierNativeId'] ?? cfg['humidifierNativeId']
      if (typeof cid === 'string') byCid[cid] = device.id
    }
    return { byCid }
  }

  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    const adopted = await adoptedOf(integrationId)
    return buildVeSyncCandidates({
      integrationId,
      accountName: accountName(integrationId),
      online: deps.integrationOnline(integrationId),
      devices: deps.getDevices(integrationId),
      adoptedDeviceIdByCid: adopted.byCid,
    })
  }

  async function status(integrationId: string): Promise<AdoptionStatus> {
    const adopted = await adoptedOf(integrationId)
    const deviceCount = Object.keys(adopted.byCid).length
    return {
      lastDiscoveryAt: Date.now(),
      candidateCount: (await candidates(integrationId)).length,
      adoptedCount: deviceCount,
      lastError: null,
    }
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize }) => {
      deps.revalidate(integrationId)
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

    refresh: async ({ integrationId }) => {
      await deps.relist(integrationId)
      return status(integrationId)
    },

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
          const humidifierCid = parseHumidifierNativeId(nativeId)
          if (humidifierCid !== null) {
            const humidifier = deps
              .getDevices(integrationId)
              .find((d) => d.kind === 'humidifier' && d.nativeId === humidifierCid)
            if (humidifier === undefined) {
              deps.logger.warn('vesync adopt: the account reports no such humidifier — skipping', {
                meta: { cid: humidifierCid, integrationId },
              })
              failures++
              continue
            }
            const { deviceId } = await deps.adoptHumidifier({
              integrationId,
              cid: humidifierCid,
              name:
                perCandidate?.[nativeId]?.name ??
                (humidifier.name.length > 0 ? humidifier.name : `humidifier ${humidifierCid}`),
              model: humidifier.model,
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
            deps.logger.warn('vesync adopt: not a purifier or humidifier native id — skipping', {
              meta: { nativeId, integrationId },
            })
            failures++
            continue
          }
          const purifier = deps
            .getDevices(integrationId)
            .find((d) => d.kind === 'purifier' && d.nativeId === cid)
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

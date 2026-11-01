import {
  errMsg,
  type AdoptionFilter,
  type AdoptionStatus,
  type DiscoveredChildDevice,
  type IDeviceAdoptionProvider,
  type IScopedLogger,
} from '@camstack/types'
import { UNIFI_SYSTEM } from './config.js'
import {
  buildDiscoveryCandidates,
  clientNativeId,
  infraNativeId,
  parseNativeId,
  UNIFI_GATEWAY_ID,
} from './unifi-discovery.js'
import type { UnifiAdoptInput } from './unifi-device-adopter.js'
import { unifiControllers } from './unifi-node-resolver.js'

export interface UnifiAdoptionProviderDeps {
  readonly hasIntegration: (integrationId: string) => boolean
  readonly listIntegrations: () => readonly string[]
  /** The integration's display name, or null when it is unknown. */
  readonly integrationName: (integrationId: string) => string | null
  /** Every top-level device of the addon with its persisted config. */
  readonly listAdopted: () => Promise<
    ReadonlyArray<{
      readonly id: number
      readonly config: Record<string, unknown>
    }>
  >
  readonly adoptGateway: (input: UnifiAdoptInput) => Promise<{ readonly deviceId: number }>
  readonly adoptInfra: (
    input: UnifiAdoptInput & { readonly infraId: string },
  ) => Promise<{ readonly deviceId: number; readonly accessoryDeviceIds: readonly number[] }>
  readonly adoptClient: (
    input: UnifiAdoptInput & { readonly mac: string },
  ) => Promise<{ readonly deviceId: number }>
  /** The ids of a device's children (empty when it has none). */
  readonly childDeviceIds: (deviceId: number) => Promise<readonly number[]>
  readonly removeDevice: (deviceId: number) => Promise<void>
  readonly findDeviceConfig: (deviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

const DEVICES_FILTER: AdoptionFilter = {
  id: 'devices',
  label: 'Devices',
  isDefault: true,
}

/** The `childNativeId` a persisted device of this addon was adopted under, or null. */
function adoptedNativeId(config: Record<string, unknown>): string | null {
  const gateway = config['nativeId']
  if (gateway === UNIFI_GATEWAY_ID) return UNIFI_GATEWAY_ID
  const infra = config['infraNativeId']
  if (typeof infra === 'string') return infraNativeId(infra)
  const mac = config['mac']
  if (config['kind'] === 'presence' && typeof mac === 'string') return clientNativeId(mac)
  return null
}

/**
 * The UniFi `device-adoption` provider: the controller's Gateway, its infra devices and its
 * network clients are candidates of the integration, adopted as top-level siblings.
 */
export function buildUnifiAdoptionProvider(
  deps: UnifiAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const { hasIntegration, listIntegrations, listAdopted, logger } = deps
  const controllerName = (integrationId: string): string =>
    deps.integrationName(integrationId) ?? 'UniFi Network'

  async function adoptedMap(integrationId: string): Promise<ReadonlyMap<string, number>> {
    const map = new Map<string, number>()
    for (const device of await listAdopted()) {
      const cfg = device.config
      if (cfg['system'] !== UNIFI_SYSTEM || cfg['integrationId'] !== integrationId) continue
      const nativeId = adoptedNativeId(cfg)
      if (nativeId !== null) map.set(nativeId, device.id)
    }
    return map
  }

  async function candidates(integrationId: string): Promise<readonly DiscoveredChildDevice[]> {
    return buildDiscoveryCandidates({
      controllerName: controllerName(integrationId),
      controllerOnline: unifiControllers.getManager(integrationId)?.status === 'connected',
      infra: unifiControllers.getInfraList(integrationId),
      clients: unifiControllers.getClientList(integrationId),
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
        return { lastDiscoveryAt: Date.now(), candidateCount, adoptedCount, lastError: null }
      } catch (err: unknown) {
        return { lastDiscoveryAt: null, candidateCount: 0, adoptedCount: 0, lastError: errMsg(err) }
      }
    },

    refresh: async ({ integrationId }) => status(integrationId),

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      if (!hasIntegration(integrationId)) {
        throw new Error(`unifi adopt: integration ${integrationId} not found`)
      }
      const already = await adoptedMap(integrationId)
      const adopted: Array<{
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }> = []
      let failures = 0
      for (const nativeId of childNativeIds) {
        try {
          const existingId = already.get(nativeId)
          if (existingId !== undefined) {
            // A retried adopt (the first reply was lost) is a no-op, never a duplicate.
            logger.info('unifi adopt: already adopted — skipping', {
              tags: { deviceId: existingId },
              meta: { nativeId, integrationId },
            })
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: existingId,
              accessoryDeviceIds: await deps.childDeviceIds(existingId),
            })
            continue
          }
          const parsed = parseNativeId(nativeId)
          const name = perCandidate?.[nativeId]?.name
          if (parsed?.kind === 'gateway') {
            const { deviceId } = await deps.adoptGateway({
              integrationId,
              name: name ?? controllerName(integrationId),
            })
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: deviceId,
              accessoryDeviceIds: [],
            })
          } else if (parsed?.kind === 'infra') {
            const infra = unifiControllers.getInfra(integrationId, parsed.id)
            const { deviceId, accessoryDeviceIds } = await deps.adoptInfra({
              integrationId,
              infraId: parsed.id,
              name:
                name ?? (infra && infra.name.length > 0 ? infra.name : (infra?.model ?? parsed.id)),
            })
            adopted.push({ childNativeId: nativeId, parentDeviceId: deviceId, accessoryDeviceIds })
          } else if (parsed?.kind === 'client') {
            const client = unifiControllers.getClient(integrationId, parsed.mac)
            const { deviceId } = await deps.adoptClient({
              integrationId,
              mac: parsed.mac,
              name: name ?? (client && client.hostname.length > 0 ? client.hostname : parsed.mac),
            })
            adopted.push({
              childNativeId: nativeId,
              parentDeviceId: deviceId,
              accessoryDeviceIds: [],
            })
          } else {
            logger.warn('unifi adopt: not a candidate of this integration — skipping', {
              meta: { nativeId, integrationId },
            })
            failures++
          }
        } catch (err: unknown) {
          logger.warn('unifi adopt: failed to adopt candidate', {
            meta: { nativeId, integrationId, error: errMsg(err) },
          })
          failures++
        }
      }
      if (adopted.length === 0 && failures > 0) {
        throw new Error(`unifi adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await deps.removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await deps.findDeviceConfig(camDeviceId)
      if (cfg === null || cfg['system'] !== UNIFI_SYSTEM) {
        throw new Error(`unifi resync: device ${camDeviceId} is not a UniFi device`)
      }
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}

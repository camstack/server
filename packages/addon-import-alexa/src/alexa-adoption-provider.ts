import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  IDeviceAdoptionProvider,
  AdoptionStatus,
  AdoptionFilter,
  DiscoveredChildDevice,
} from '@camstack/types'
import type { AlexaAppliance } from './alexa-client.js'
import { buildAlexaApplianceCandidate, mappableAppliance } from './alexa-discovery.js'

/** Narrow registry surface consumed by the adoption provider. */
export interface AlexaAdoptionRegistry {
  /** The live appliance inventory for a broker (or [] when unknown). */
  getAppliancesForBroker(id: string): readonly AlexaAppliance[]
  list(): readonly { readonly id: string; readonly name: string }[]
  has(id: string): boolean
}

export interface AlexaAdoptionProviderDeps {
  readonly registry: AlexaAdoptionRegistry
  readonly getBrokerIdForIntegration: (integrationId: string) => Promise<string>
  readonly listAdoptedAlexa: () => Promise<
    ReadonlyArray<{ readonly id: number; readonly config: Record<string, unknown> }>
  >
  readonly adoptAppliance: (input: {
    readonly brokerId: string
    readonly appliance: AlexaAppliance
    readonly integrationId: string
    readonly name: string
  }) => Promise<{ readonly deviceId: number }>
  readonly removeDevice: (camDeviceId: number) => Promise<void>
  readonly findDeviceConfig: (camDeviceId: number) => Promise<Record<string, unknown> | null>
  readonly logger: IScopedLogger
}

/** Single granularity: each Alexa appliance adopts as one device. */
const DEVICES_FILTER: AdoptionFilter = { id: 'devices', label: 'Devices', isDefault: true } as const

/** Resolve the adopted CamStack device id for a (broker, appliance), or null. */
async function adoptedApplianceId(
  brokerId: string,
  applianceId: string,
  listAdoptedAlexa: AlexaAdoptionProviderDeps['listAdoptedAlexa'],
): Promise<number | null> {
  for (const d of await listAdoptedAlexa()) {
    if (
      d.config['system'] === 'alexa' &&
      d.config['brokerId'] === brokerId &&
      d.config['applianceId'] === applianceId
    ) {
      return d.id
    }
  }
  return null
}

/**
 * Construct the `device-adoption` cap provider for the Alexa import addon. Pure
 * builder. One broker = one Amazon account; each mappable appliance is a flat
 * device candidate. Mirrors the Ecowitt / Matter adoption provider (minus the
 * Container fan-out — Alexa appliances are standalone devices).
 */
export function buildAlexaAdoptionProvider(
  deps: AlexaAdoptionProviderDeps,
): IDeviceAdoptionProvider {
  const {
    registry,
    getBrokerIdForIntegration,
    listAdoptedAlexa,
    adoptAppliance,
    removeDevice,
    findDeviceConfig,
    logger,
  } = deps

  async function candidatesForBroker(brokerId: string): Promise<DiscoveredChildDevice[]> {
    const appliances = registry.getAppliancesForBroker(brokerId).filter(mappableAppliance)
    const out: DiscoveredChildDevice[] = []
    for (const appliance of appliances) {
      const adoptedDeviceId = await adoptedApplianceId(
        brokerId,
        appliance.applianceId,
        listAdoptedAlexa,
      )
      out.push(buildAlexaApplianceCandidate({ appliance, adoptedDeviceId }))
    }
    return out
  }

  return {
    listCandidateFilters: async () => ({ filters: [DEVICES_FILTER] }),

    listCandidates: async ({ integrationId, page, pageSize }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      const candidates = await candidatesForBroker(brokerId)
      return { candidates, totalCount: candidates.length, page, pageSize }
    },

    getCandidate: async ({ integrationId, childNativeId }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      const candidates = await candidatesForBroker(brokerId)
      return candidates.find((c) => c.childNativeId === childNativeId) ?? null
    },

    getStatus: async () => {
      try {
        let candidateCount = 0
        for (const broker of registry.list()) {
          candidateCount += (await candidatesForBroker(broker.id)).length
        }
        const adopted = await listAdoptedAlexa()
        const adoptedCount = adopted.filter((d) => d.config['system'] === 'alexa').length
        return {
          lastDiscoveryAt: Date.now(),
          candidateCount,
          adoptedCount,
          lastError: null,
        } satisfies AdoptionStatus
      } catch (err: unknown) {
        logger.warn('alexa adoption: getStatus failed', { meta: { error: errMsg(err) } })
        return {
          lastDiscoveryAt: null,
          candidateCount: 0,
          adoptedCount: 0,
          lastError: errMsg(err),
        } satisfies AdoptionStatus
      }
    },

    refresh: async ({ integrationId }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      const candidates = await candidatesForBroker(brokerId)
      const adopted = await listAdoptedAlexa()
      const adoptedCount = adopted.filter(
        (d) => d.config['system'] === 'alexa' && d.config['brokerId'] === brokerId,
      ).length
      return {
        lastDiscoveryAt: Date.now(),
        candidateCount: candidates.length,
        adoptedCount,
        lastError: null,
      } satisfies AdoptionStatus
    },

    adopt: async ({ integrationId, childNativeIds, perCandidate }) => {
      const brokerId = await getBrokerIdForIntegration(integrationId)
      if (!registry.has(brokerId)) {
        throw new Error(`alexa adopt: broker ${brokerId} not connected`)
      }
      const appliances = registry.getAppliancesForBroker(brokerId)
      const adopted: {
        readonly childNativeId: string
        readonly parentDeviceId: number
        readonly accessoryDeviceIds: readonly number[]
      }[] = []
      let failures = 0

      for (const nativeId of childNativeIds) {
        const appliance = appliances.find((a) => a.applianceId === nativeId)
        if (appliance === undefined) {
          logger.warn('alexa adopt: appliance not found in inventory — skipping', {
            meta: { nativeId, brokerId },
          })
          failures++
          continue
        }
        try {
          const name = perCandidate?.[nativeId]?.name ?? appliance.name
          const { deviceId } = await adoptAppliance({ brokerId, appliance, integrationId, name })
          adopted.push({
            childNativeId: nativeId,
            parentDeviceId: deviceId,
            accessoryDeviceIds: [],
          })
        } catch (err: unknown) {
          logger.warn('alexa adopt: failed to adopt appliance', {
            meta: { brokerId, applianceId: appliance.applianceId, error: errMsg(err) },
          })
          failures++
        }
      }

      if (adopted.length === 0 && failures > 0) {
        throw new Error(`alexa adopt: all ${failures} adopt(s) failed`)
      }
      return { adopted }
    },

    release: async ({ camDeviceId }) => {
      await removeDevice(camDeviceId)
    },

    resync: async ({ camDeviceId }) => {
      const cfg = await findDeviceConfig(camDeviceId)
      if (cfg === null) throw new Error(`alexa resync: device ${camDeviceId} not found`)
      if (cfg['system'] !== 'alexa') {
        throw new Error(`alexa resync: device ${camDeviceId} is not an Alexa device`)
      }
      const brokerId = String(cfg['brokerId'])
      if (!registry.has(brokerId)) {
        throw new Error(`alexa resync: broker ${brokerId} no longer connected`)
      }
      // A full structural drift report (re-derive caps from the live interfaces)
      // is a follow-up.
      return { changed: false, rebuiltChildren: 0 }
    },
  }
}

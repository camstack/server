/**
 * Network discovery across providers.
 *
 * A provider that declares discovery modes (`getDiscoveryModes`) is not asked
 * to scan: its modes go to the `local-network` engine, ONE `scanNetwork` call
 * serves every such provider, and each provider gets back only the hits its own
 * modes produced, to classify. A provider with a `custom` mode additionally
 * keeps running its own `discoverDevices`, handed the subnets the engine
 * covered. A provider that declares nothing (or predates the method) keeps the
 * old `discoverDevices` path.
 */
import type {
  DiscoveryHit,
  DiscoveryMode,
  InferProvider,
  IScopedLogger,
  ScanNetworkResult,
  ScanRequest,
  deviceProviderCapability,
} from '@camstack/types'
import { errMsg } from '@camstack/types'

type FullDeviceProvider = InferProvider<typeof deviceProviderCapability>
/** The three provider methods discovery uses. */
export type DiscoveryProvider = Pick<
  FullDeviceProvider,
  'getDiscoveryModes' | 'classifyDiscoveryHits' | 'discoverDevices'
>
type DeviceProvider = DiscoveryProvider
type Candidates = Awaited<ReturnType<DeviceProvider['discoverDevices']>>
export type DiscoveryCandidateList = Candidates

export interface DiscoveryOrchestratorDeps {
  readonly requireProvider: (addonId: string) => Promise<DeviceProvider>
  readonly scanNetwork: (input: {
    readonly requests: readonly ScanRequest[]
    readonly subnets?: readonly string[]
  }) => Promise<ScanNetworkResult>
  /**
   * `stableId`s of the candidates that already became an integration. A failed
   * read hides nothing (D49): the list is shown whole.
   */
  readonly originStableIds: () => Promise<ReadonlySet<string>>
  readonly logger: IScopedLogger
}

export interface ProviderDiscoveryOutcome {
  readonly addonId: string
  readonly candidates: Candidates
  readonly error: string | null
}

export interface DiscoverRequest {
  readonly addonIds: readonly string[]
  /** Per-scan provider params; reach a provider's classify / custom scan as-is. */
  readonly params?: Record<string, unknown>
  /** Extra CIDRs for this scan only. */
  readonly subnets?: readonly string[]
}

interface Participant {
  readonly addonId: string
  readonly provider: DeviceProvider
  readonly modes: readonly DiscoveryMode[]
}

/** A provider without the method (an older addon) or one that fails it is a legacy provider. */
async function declaredModes(provider: DeviceProvider): Promise<readonly DiscoveryMode[]> {
  try {
    return await provider.getDiscoveryModes({})
  } catch {
    return []
  }
}

function hasCustom(modes: readonly DiscoveryMode[]): boolean {
  return modes.some((m) => m.kind === 'custom')
}

function hasEngineMode(modes: readonly DiscoveryMode[]): boolean {
  return modes.some((m) => m.kind !== 'custom')
}

function mergeByStableId(lists: readonly Candidates[]): Candidates {
  const seen = new Set<string>()
  const out: Candidates[number][] = []
  for (const list of lists) {
    for (const c of list) {
      if (seen.has(c.stableId)) continue
      seen.add(c.stableId)
      out.push(c)
    }
  }
  return out
}

async function ownedOrigins(deps: DiscoveryOrchestratorDeps): Promise<ReadonlySet<string>> {
  try {
    return await deps.originStableIds()
  } catch (err) {
    deps.logger.warn('discovery: integration origins unreadable, hiding nothing', {
      meta: { error: errMsg(err) },
    })
    return new Set()
  }
}

/** A candidate that already became an integration is not offered again (D984). */
function withoutOwned(
  outcome: ProviderDiscoveryOutcome,
  owned: ReadonlySet<string>,
): ProviderDiscoveryOutcome {
  if (owned.size === 0) return outcome
  return { ...outcome, candidates: outcome.candidates.filter((c) => !owned.has(c.stableId)) }
}

export async function discoverProviders(
  deps: DiscoveryOrchestratorDeps,
  request: DiscoverRequest,
): Promise<readonly ProviderDiscoveryOutcome[]> {
  const loaded = await Promise.all(
    request.addonIds.map(async (addonId) => {
      try {
        const provider = await deps.requireProvider(addonId)
        return { addonId, provider, modes: await declaredModes(provider), error: null }
      } catch (err) {
        return { addonId, provider: null, modes: [], error: errMsg(err) }
      }
    }),
  )
  const participants: Participant[] = []
  for (const l of loaded) {
    if (l.provider !== null && l.modes.length > 0) {
      participants.push({ addonId: l.addonId, provider: l.provider, modes: l.modes })
    }
  }

  let scan: ScanNetworkResult | null = null
  let scanError: string | null = null
  if (participants.length > 0) {
    try {
      scan = await deps.scanNetwork({
        requests: participants.map((p) => ({ providerId: p.addonId, modes: [...p.modes] })),
        ...(request.subnets !== undefined ? { subnets: request.subnets } : {}),
      })
    } catch (err) {
      scanError = errMsg(err)
      deps.logger.warn('discovery: network scan failed', { meta: { error: scanError } })
    }
  }

  const owned = await ownedOrigins(deps)
  const outcomes = await Promise.all(
    loaded.map(async (l): Promise<ProviderDiscoveryOutcome> => {
      const { addonId, provider } = l
      if (provider === null) {
        return { addonId, candidates: [], error: l.error }
      }
      try {
        if (l.modes.length === 0) {
          const candidates = await provider.discoverDevices(
            request.params === undefined ? {} : { params: request.params },
          )
          return { addonId, candidates, error: null }
        }
        const lists: Candidates[] = []
        if (hasEngineMode(l.modes)) {
          if (scan === null) throw new Error(scanError ?? 'network scan unavailable')
          const hits: DiscoveryHit[] = scan.hits
            .filter((h) => h.providerId === addonId)
            .map((h) => h.hit)
          if (hits.length > 0) {
            lists.push(
              await provider.classifyDiscoveryHits({
                hits,
                ...(request.params !== undefined ? { params: request.params } : {}),
              }),
            )
          }
        }
        if (hasCustom(l.modes)) {
          lists.push(
            await provider.discoverDevices({
              params: { ...request.params, subnets: scan?.subnetsScanned ?? [] },
            }),
          )
        }
        return { addonId, candidates: mergeByStableId(lists), error: null }
      } catch (err) {
        deps.logger.warn('discovery provider scan failed', {
          meta: { addonId, error: errMsg(err) },
        })
        return { addonId, candidates: [], error: errMsg(err) }
      }
    }),
  )
  return outcomes.map((o) => withoutOwned(o, owned))
}

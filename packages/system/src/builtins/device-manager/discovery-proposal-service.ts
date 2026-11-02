/**
 * Where the two discovery feeds meet (D994).
 *
 * - `runSweep`: the existing provider discovery (`discoverProviders`), run on
 *   the schedule `local-network` keeps; every candidate becomes a proposal.
 * - `reportObservations`: what the passive listener heard. Each sighting is
 *   matched against the discovery modes the providers DECLARE and handed to the
 *   matching provider's `classifyDiscoveryHits`, exactly like a scan hit.
 *
 * Adoption is not here: a proposal is adopted through `adoptDevice` or the
 * integration setup form, the flows the scan modal already uses.
 */
import {
  errMsg,
  type DiscoveryHit,
  type DiscoveryMode,
  type DiscoveryObservation,
  type DiscoveryProposal,
  type IScopedLogger,
} from '@camstack/types'
import { normalizeServiceType } from '../local-network/scan/dns-wire.js'
import {
  type DiscoveryOrchestratorDeps,
  type DiscoveryProvider,
  discoverProviders,
} from './discovery-orchestrator.js'
import type { DiscoveryProposalStore, ProposalOwnership } from './discovery-proposal-store.js'

/** The hit a declared mode would have produced for this sighting, per matching mode. */
export function hitsForObservation(
  modes: readonly DiscoveryMode[],
  observation: DiscoveryObservation,
): readonly DiscoveryHit[] {
  const hits: DiscoveryHit[] = []
  modes.forEach((mode, modeIndex) => {
    if (observation.kind === 'mdns' && mode.kind === 'mdns') {
      if (normalizeServiceType(mode.serviceType) !== observation.serviceType) return
      if (
        mode.instancePattern !== undefined &&
        !instanceMatches(mode.instancePattern, observation.instance)
      ) {
        return
      }
      hits.push({
        modeIndex,
        host: observation.address ?? observation.host,
        port: observation.port,
        mdns: {
          instance: observation.instance,
          host: observation.host,
          port: observation.port,
          txt: observation.txt,
        },
      })
    } else if (observation.kind === 'ssdp' && mode.kind === 'ssdp') {
      if (mode.searchTarget.toLowerCase() !== observation.target.toLowerCase()) return
      hits.push({
        modeIndex,
        host: observation.host,
        port: observation.port,
        http: { status: 200, headers: observation.headers, bodyText: '' },
      })
    }
  })
  return hits
}

function instanceMatches(pattern: string, instance: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(instance)
  } catch {
    return false
  }
}

export interface DiscoveryProposalServiceDeps {
  readonly store: DiscoveryProposalStore
  readonly orchestrator: DiscoveryOrchestratorDeps
  readonly providerIds: () => Promise<readonly string[]>
  readonly requireProvider: (addonId: string) => Promise<DiscoveryProvider>
  readonly ownership: () => Promise<ProposalOwnership>
  readonly logger: IScopedLogger
}

export class DiscoveryProposalService {
  constructor(private readonly deps: DiscoveryProposalServiceDeps) {}

  async runSweep(): Promise<{ providers: number; proposed: number }> {
    const addonIds = await this.deps.providerIds()
    const outcomes = await discoverProviders(this.deps.orchestrator, { addonIds })
    let proposed = 0
    for (const outcome of outcomes) {
      if (outcome.error !== null) continue
      proposed += await this.deps.store.observe(outcome.addonId, outcome.candidates)
    }
    this.deps.logger.info('discovery sweep recorded', {
      meta: { providers: addonIds.length, proposed },
    })
    return { providers: addonIds.length, proposed }
  }

  async reportObservations(
    observations: readonly DiscoveryObservation[],
  ): Promise<{ proposed: number }> {
    if (observations.length === 0) return { proposed: 0 }
    const addonIds = await this.deps.providerIds()
    let proposed = 0
    for (const addonId of addonIds) {
      try {
        const provider = await this.deps.requireProvider(addonId)
        const modes = await provider.getDiscoveryModes({})
        const hits = observations.flatMap((o) => hitsForObservation(modes, o))
        if (hits.length === 0) continue
        const candidates = await provider.classifyDiscoveryHits({ hits })
        proposed += await this.deps.store.observe(addonId, candidates)
      } catch (err) {
        this.deps.logger.warn('passive discovery: provider could not classify', {
          meta: { addonId, error: errMsg(err) },
        })
      }
    }
    return { proposed }
  }

  async list(): Promise<readonly DiscoveryProposal[]> {
    return this.deps.store.listVisible(await this.deps.ownership())
  }

  dismiss(id: string): Promise<boolean> {
    return this.deps.store.dismiss(id)
  }
}

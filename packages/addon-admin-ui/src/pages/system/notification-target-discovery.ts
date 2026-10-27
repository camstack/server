/**
 * Pure rules of the "Find devices" flow on the notification targets page.
 *
 * Any kind that declares `supportsDiscovery` can be searched. The provider
 * answers with candidates; this decides which of them are new, and builds the
 * target a ticked candidate becomes. Nothing here knows a kind by name.
 */
import type { DiscoveredTarget, Target, TargetKind } from '@camstack/types'

/** The kinds whose provider can list candidates. */
export function discoverableKinds<K extends TargetKind>(kinds: readonly K[]): K[] {
  return kinds.filter((kind) => kind.supportsDiscovery)
}

/**
 * Whether a saved target of the same kind already points at the candidate.
 * The kind's `destinationKeys` say what identifies the destination. A key the
 * saved target does not carry does not contradict (it may predate the key), but
 * at least one key must match, so a kind without keys never claims a match.
 */
export function isAlreadyConfigured(
  proposal: DiscoveredTarget,
  targets: readonly Target[],
  kind: TargetKind,
): boolean {
  const keys = kind.destinationKeys ?? []
  return targets.some((target) => {
    if (target.kind !== kind.kind) return false
    let matched = 0
    for (const key of keys) {
      const wanted = proposal.config[key]
      const have = target.config[key]
      if (wanted === undefined || have === undefined) continue
      if (wanted !== have) return false
      matched += 1
    }
    return matched > 0
  })
}

/** The candidates that no saved target covers yet, in the order the provider gave them. */
export function newTargetsFrom(
  found: readonly DiscoveredTarget[],
  targets: readonly Target[],
  kind: TargetKind,
): DiscoveredTarget[] {
  return found.filter((proposal) => !isAlreadyConfigured(proposal, targets, kind))
}

export function targetFromProposal(
  proposal: DiscoveredTarget,
  kind: TargetKind,
  id: string,
): Target {
  return {
    id,
    name: proposal.suggestedName,
    kind: kind.kind,
    addonId: kind.addonId,
    enabled: true,
    config: proposal.config,
  }
}

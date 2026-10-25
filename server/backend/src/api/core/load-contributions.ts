/**
 * The hub's assembly of every addon's OWN reported cost.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is an ENUMERATION, not an authority. Each `load-contribution` provider is
 * either in-process or an RPC proxy the `CapabilityRegistry` already built for
 * a forked runner or an agent, so this reaches the contributors over transport
 * that already exists — no new UDS message, no second registry (D3). Every
 * entry it returns was produced by the addon that owns the cost; hub-main adds
 * only `addonId`, which is the one fact a contributor must not be trusted to
 * report about itself.
 *
 * There is no hand-kept list of what costs what, and that is the whole point:
 * a list rots at the first addition and rots INVISIBLY — nothing fails, an
 * operator simply never sees the family somebody added. Modelled on
 * `buildLogChannelPlane`, which solved the same problem for diagnostic
 * channels.
 *
 * ## One provider failing must not silence the others
 *
 * Each is awaited on its own and a failure is REPORTED, never swallowed: a
 * branch that drops work logs it. A runner that is mid-respawn contributes
 * nothing for one call, and the rest of the cluster still answers.
 */
import type { ILoadContributionProvider, ReportedLoadContribution } from '@camstack/types'
import { errMsg } from '@camstack/types'

/** What {@link buildLoadContributionPlane} needs off the registry, and no more. */
export interface LoadContributionProviderSource {
  entries(): readonly (readonly [string, ILoadContributionProvider])[]
}

export interface LoadContributionPlane {
  /** Every entry every provider reports, tagged with who reported it. */
  contributions(): Promise<readonly ReportedLoadContribution[]>
}

/** A plane that reaches nothing. The shape of a hub with no addon booted yet. */
export const EMPTY_LOAD_CONTRIBUTION_PLANE: LoadContributionPlane = {
  contributions: async () => [],
}

export function buildLoadContributionPlane(
  source: LoadContributionProviderSource,
  onProviderError?: (addonId: string, error: string) => void,
): LoadContributionPlane {
  return {
    contributions: async () => {
      const out: ReportedLoadContribution[] = []
      for (const [addonId, provider] of source.entries()) {
        try {
          for (const entry of await provider.list()) {
            out.push({ ...entry, addonId })
          }
        } catch (err: unknown) {
          onProviderError?.(addonId, errMsg(err))
        }
      }
      return out
    },
  }
}

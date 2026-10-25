/**
 * The hub's assembly of every addon's OWN reported losses, per camera.
 *
 * The exact twin of `load-contributions.ts`, and deliberately so: an
 * ENUMERATION, not an authority. Each `failure-contribution` provider is either
 * in-process or an RPC proxy the `CapabilityRegistry` already built for a forked
 * runner or an agent, so this reaches the contributors over transport that
 * already exists — no new UDS message, no second registry (D3). Every entry was
 * produced by the addon that owns the failing path; hub-main adds only
 * `addonId`, the one fact a contributor must not be trusted to report about
 * itself.
 *
 * ## One provider failing must not silence the others
 *
 * Each is awaited on its own and a failure is REPORTED, never swallowed — a
 * branch that drops work logs it. A runner mid-respawn contributes nothing for
 * one call and the rest of the cluster still answers. That matters more here
 * than on the cost plane: the runners most likely to be mid-respawn are exactly
 * the ones whose failure counters are being asked about.
 *
 * ## What this plane must never do
 *
 * It must not sum across cameras, and it must not compute a rate. Both are the
 * consumer's job, on entries that carry `attempts` — a hub-side fleet total is
 * the number that answered nothing on 2026-08-28.
 */
import type { IFailureContributionProvider, ReportedFailureContribution } from '@camstack/types'
import { errMsg } from '@camstack/types'

/** What {@link buildFailureContributionPlane} needs off the registry, and no more. */
export interface FailureContributionProviderSource {
  entries(): readonly (readonly [string, IFailureContributionProvider])[]
}

export interface FailureContributionPlane {
  /** Every counter every provider reports, tagged with who reported it. */
  contributions(): Promise<readonly ReportedFailureContribution[]>
}

/** A plane that reaches nothing. The shape of a hub with no addon booted yet. */
export const EMPTY_FAILURE_CONTRIBUTION_PLANE: FailureContributionPlane = {
  contributions: async () => [],
}

export function buildFailureContributionPlane(
  source: FailureContributionProviderSource,
  onProviderError?: (addonId: string, error: string) => void,
): FailureContributionPlane {
  return {
    contributions: async () => {
      const out: ReportedFailureContribution[] = []
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

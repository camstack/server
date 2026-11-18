/**
 * The persisted proposals of passive discovery (D994), shown inside the scan
 * modal — the same source as the scan itself.
 *
 * `useDiscoveryProposals` backs the pill on the page's Scan button: `count` is
 * `null` until the query has ANSWERED (an unanswered query is not "0"), and `0`
 * means no pill. `DiscoveredProposalsSection` lists the proposals
 * (`deviceManager.listDiscoveryProposals` already hides what was dismissed,
 * adopted or set up as an integration) and renders nothing for an empty answer.
 *
 * Adopt reuses the scan modal's flows: a `setupIntegration` proposal opens the
 * integration form, any other goes through `deviceManager.adoptDevice`.
 */
import {
  Badge,
  Button,
  TEXT_SECTION_LABEL,
  useDeviceManagerAdoptDevice,
  useDeviceManagerDismissDiscoveryProposal,
  useDeviceManagerListDiscoveryProposals,
} from '@camstack/ui-library'
import type { DiscoveryProposal } from '@camstack/types'
import { Check, Loader2 } from 'lucide-react'
import { type ReactElement, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { integrationSetupSeed, type IntegrationFormSeed } from './integration-setup-seed'

/** The list re-reads on this clock; the listener and the sweep fill it in the background. */
const PROPOSALS_REFRESH_MS = 60_000

type Proposal = DiscoveryProposal

interface DiscoveryProposalsState {
  /** Background-discovered proposals, or `null` while the query has not answered. */
  readonly count: number | null
  /** Re-read the list (the section and the pill share one cache entry). */
  readonly refresh: () => void
}

export function useDiscoveryProposals(): DiscoveryProposalsState {
  const query = useDeviceManagerListDiscoveryProposals(
    {},
    { refetchInterval: PROPOSALS_REFRESH_MS },
  )
  const { refetch } = query
  const refresh = useCallback(() => void refetch(), [refetch])
  return { count: query.data === undefined ? null : query.data.proposals.length, refresh }
}

/** The count pill on the Scan button; nothing for an unanswered query or zero. */
export function DiscoveryProposalPill({
  count,
}: {
  readonly count: number | null
}): ReactElement | null {
  if (count === null || count === 0) return null
  return (
    <Badge variant="info" style="fill" size="sm" data-testid="discovery-pill">
      {count}
    </Badge>
  )
}

interface DiscoveredProposalsSectionProps {
  readonly onSetupIntegration: (seed: IntegrationFormSeed) => void
}

export function DiscoveredProposalsSection({
  onSetupIntegration,
}: DiscoveredProposalsSectionProps): ReactElement | null {
  const { t } = useTranslation()
  const query = useDeviceManagerListDiscoveryProposals(
    {},
    { refetchInterval: PROPOSALS_REFRESH_MS },
  )
  const adopt = useDeviceManagerAdoptDevice()
  const dismiss = useDeviceManagerDismissDiscoveryProposal()
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const { refetch } = query

  const withBusy = useCallback(
    async (id: string, run: () => Promise<unknown>) => {
      setBusy((prev) => new Set(prev).add(id))
      try {
        await run()
        void refetch()
      } catch {
        // the row stays in the list, still actionable
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    },
    [refetch],
  )

  const onAdopt = useCallback(
    async (proposal: Proposal) => {
      const seed = integrationSetupSeed(proposal.addonId, proposal.candidate)
      if (seed !== null) {
        onSetupIntegration(seed)
        return
      }
      await withBusy(proposal.id, () =>
        adopt.mutateAsync({ addonId: proposal.addonId, candidate: proposal.candidate }),
      )
    },
    [adopt, onSetupIntegration, withBusy],
  )

  const onDismiss = useCallback(
    (proposal: Proposal) => withBusy(proposal.id, () => dismiss.mutateAsync({ id: proposal.id })),
    [dismiss, withBusy],
  )

  const proposals = query.data?.proposals ?? []
  if (proposals.length === 0) return null

  return (
    <section className="space-y-2" data-testid="discovery-proposals">
      <h3 className="flex items-center gap-2">
        <span className={TEXT_SECTION_LABEL}>
          {t('integrations.discoveryProposals.title', 'Found in the background')}
        </span>
        <span className="text-[10px] text-foreground-subtle">({proposals.length})</span>
      </h3>
      <div className="space-y-1.5">
        {proposals.map((proposal) => (
          <div
            key={proposal.id}
            data-testid="discovery-proposal"
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {proposal.candidate.suggestedName}
              </p>
              <p className="truncate text-xs text-foreground-muted">{proposal.addonId}</p>
            </div>
            {busy.has(proposal.id) ? (
              <Loader2 className="h-4 w-4 animate-spin text-foreground-muted" aria-hidden />
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={() => void onDismiss(proposal)}>
                  {t('integrations.discoveryProposals.dismiss', 'Dismiss')}
                </Button>
                <Button size="sm" onClick={() => void onAdopt(proposal)}>
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  {t('integrations.discoveryProposals.adopt', 'Adopt')}
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

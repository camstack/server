/**
 * "N new devices found" — the persisted proposals of passive discovery (D994).
 *
 * The banner reads `deviceManager.listDiscoveryProposals`, which already hides
 * what was dismissed, adopted or set up as an integration. It renders nothing
 * until that query has ANSWERED with at least one proposal: an unanswered query
 * is not an empty list, and an empty list needs no banner.
 *
 * Adopt reuses the scan modal's flows: a `setupIntegration` proposal opens the
 * integration form, any other goes through `deviceManager.adoptDevice`.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useDeviceManagerAdoptDevice,
  useDeviceManagerDismissDiscoveryProposal,
  useDeviceManagerListDiscoveryProposals,
} from '@camstack/ui-library'
import type { DiscoveryProposal } from '@camstack/types'
import { Check, Loader2, Radar } from 'lucide-react'
import { type ReactElement, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { integrationSetupSeed, type IntegrationFormSeed } from './integration-setup-seed'

/** The banner re-reads on this clock; the listener and the sweep fill it in the background. */
const PROPOSALS_REFRESH_MS = 60_000

type Proposal = DiscoveryProposal

interface DiscoveryProposalsBannerProps {
  readonly onSetupIntegration: (seed: IntegrationFormSeed) => void
}

export function DiscoveryProposalsBanner({
  onSetupIntegration,
}: DiscoveryProposalsBannerProps): ReactElement | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const query = useDeviceManagerListDiscoveryProposals(
    {},
    { refetchInterval: PROPOSALS_REFRESH_MS },
  )
  const proposals = query.data?.proposals ?? []
  if (proposals.length === 0) return null
  return (
    <>
      <div
        role="status"
        data-testid="discovery-banner"
        className="flex flex-wrap items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-xs text-foreground"
      >
        <Radar className="h-3.5 w-3.5 text-info" aria-hidden />
        <span className="flex-1">
          {t('integrations.discoveryBanner.count', {
            defaultValue_one: '{{count}} new device found',
            defaultValue_other: '{{count}} new devices found',
            count: proposals.length,
          })}
        </span>
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          {t('integrations.discoveryBanner.review', 'Review')}
        </Button>
      </div>
      <DiscoveryProposalsModal
        open={open}
        onClose={() => setOpen(false)}
        proposals={proposals}
        onChanged={() => void query.refetch()}
        onSetupIntegration={(seed) => {
          setOpen(false)
          onSetupIntegration(seed)
        }}
      />
    </>
  )
}

interface DiscoveryProposalsModalProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly proposals: readonly Proposal[]
  /** An adoption or a dismissal went through: re-read the list. */
  readonly onChanged: () => void
  readonly onSetupIntegration: (seed: IntegrationFormSeed) => void
}

function DiscoveryProposalsModal({
  open,
  onClose,
  proposals,
  onChanged,
  onSetupIntegration,
}: DiscoveryProposalsModalProps): ReactElement {
  const { t } = useTranslation()
  const adopt = useDeviceManagerAdoptDevice()
  const dismiss = useDeviceManagerDismissDiscoveryProposal()
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

  const withBusy = useCallback(
    async (id: string, run: () => Promise<unknown>) => {
      setBusy((prev) => new Set(prev).add(id))
      try {
        await run()
        onChanged()
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
    [onChanged],
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

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-primary" />
              {t('integrations.discoveryBanner.title', 'New devices found')}
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-1.5">
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
                    {t('integrations.discoveryBanner.dismiss', 'Dismiss')}
                  </Button>
                  <Button size="sm" onClick={() => void onAdopt(proposal)}>
                    <Check className="h-3.5 w-3.5" aria-hidden />
                    {t('integrations.discoveryBanner.adopt', 'Adopt')}
                  </Button>
                </>
              )}
            </div>
          ))}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

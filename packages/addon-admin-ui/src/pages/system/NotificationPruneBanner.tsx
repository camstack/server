/**
 * "Disabled on <date>: its last device (#id) was deleted."
 *
 * Shown on a rule / timelapse / digest the deleted-device prune switched off
 * (`notification-prunes.ts` has the why). It renders NOTHING while the answer
 * is pending, when the read fails, and when there is no such prune: this is a
 * bonus sentence on an editor that works without it, and "no prunes" is never
 * a claim an unanswered read may make (D315).
 */

import { useSystem } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { NC_ADDON_ID } from './notification-rule-status'
import {
  NC_LIST_PRUNES_ACTION,
  type NcPruneRuleKind,
  type NcPruneView,
  parsePrunes,
  pruneBannerFor,
  pruneBannerText,
} from './notification-prunes'

export interface NotificationPruneBannerProps {
  readonly kind: NcPruneRuleKind
  readonly ruleId: string
  /** The SAVED rule's switch — the banner is about the rule, not the form. */
  readonly enabled: boolean
  /** The SAVED rule's `updatedAt` — a rule touched since the prune gets none. */
  readonly updatedAt: number
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString()
}

export function NotificationPruneBanner({
  kind,
  ruleId,
  enabled,
  updatedAt,
}: NotificationPruneBannerProps) {
  const system = useSystem()
  const query = useQuery({
    // One key for every editor: the ledger is small and answers every rule.
    queryKey: ['pipelineAnalytics', NC_LIST_PRUNES_ACTION],
    // A disabled rule is the only one that can carry a banner.
    enabled: !enabled,
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<readonly NcPruneView[] | null> => {
      // `.mutate`: the generic bridge is declared as a mutation (see
      // `NotificationRuleStatus.tsx`).
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_LIST_PRUNES_ACTION,
        input: {},
      })
      return parsePrunes(raw)
    },
  })
  const prunes = query.data
  if (prunes === undefined || prunes === null) return null
  const prune = pruneBannerFor(prunes, kind, ruleId, enabled, updatedAt)
  if (prune === null) return null
  return (
    <div
      data-testid="nc-prune-banner"
      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
    >
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      <span>{pruneBannerText(prune, formatDate)}</span>
    </div>
  )
}

export default NotificationPruneBanner

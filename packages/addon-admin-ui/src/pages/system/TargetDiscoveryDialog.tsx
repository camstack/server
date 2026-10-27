/**
 * "Find devices" on the notification targets page. For every kind that declares
 * `supportsDiscovery`, ask its provider for candidates, drop the ones a saved
 * target already covers, and let the operator tick the rest. Nothing here
 * knows a kind by name.
 */
import type { DiscoveredTarget, Target } from '@camstack/types'
import { Button, Checkbox, ErrorBox, ItemFormDialog, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Loader2, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { newTargetsFrom, targetFromProposal } from './notification-target-discovery'
import { KindIcon, type TargetKindWithIcon } from './target-kind-icon'

interface KindFinding {
  readonly kind: TargetKindWithIcon
  readonly proposals: readonly DiscoveredTarget[]
  readonly error: string | null
}

function rowKey(kind: TargetKindWithIcon, index: number): string {
  return `${kind.kind}:${index}`
}

export function TargetDiscoveryDialog({
  kinds,
  targets,
  onClose,
  onAdded,
}: {
  readonly kinds: readonly TargetKindWithIcon[]
  readonly targets: readonly Target[]
  readonly onClose: () => void
  readonly onAdded: () => void
}) {
  const { t } = useTranslation()
  const system = useSystem()
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())

  const search = useQuery({
    queryKey: ['notificationOutput', 'discoverTargets', kinds.map((kind) => kind.kind)],
    queryFn: async (): Promise<readonly KindFinding[]> =>
      Promise.all(
        kinds.map(async (kind): Promise<KindFinding> => {
          try {
            const found = await system.trpcClient.notificationOutput.discoverTargets.query({
              addonId: kind.addonId,
              kind: kind.kind,
            })
            return { kind, proposals: newTargetsFrom(found, targets, kind), error: null }
          } catch (err: unknown) {
            return {
              kind,
              proposals: [],
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }),
      ),
    staleTime: 0,
    gcTime: 0,
  })

  const findings = search.data ?? []
  const chosen = useMemo(
    () =>
      findings.flatMap((finding) =>
        finding.proposals.flatMap((proposal, index) =>
          unticked.has(rowKey(finding.kind, index)) ? [] : [{ finding, proposal, index }],
        ),
      ),
    [findings, unticked],
  )
  const total = findings.reduce((sum, finding) => sum + finding.proposals.length, 0)

  const add = useMutation({
    mutationFn: async (): Promise<void> => {
      const stamp = Date.now()
      for (const [position, row] of chosen.entries()) {
        const target = targetFromProposal(
          row.proposal,
          row.finding.kind,
          `${row.finding.kind.kind}-${stamp}-${position}`,
        )
        await system.trpcClient.notificationOutput.upsertTarget.mutate({
          addonId: row.finding.kind.addonId,
          target,
        })
      }
    },
    onSuccess: onAdded,
  })

  const toggle = (key: string): void =>
    setUnticked((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <ItemFormDialog
      open
      onClose={onClose}
      icon={Search}
      title={t('system.notificationTargets.discoverTitle', 'Devices found')}
      width="lg"
      testId="target-discovery-dialog"
      error={add.error instanceof Error ? add.error.message : null}
      footer={
        <Button
          size="sm"
          type="button"
          disabled={add.isPending || chosen.length === 0}
          onClick={() => add.mutate()}
        >
          {add.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t('system.notificationTargets.discoverAdd', 'Add selected ({{count}})', {
            count: chosen.length,
          })}
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-foreground-subtle">
          {t(
            'system.notificationTargets.discoverHelp',
            'These devices are available on your connected accounts and have no target yet. Tick the ones to add.',
          )}
        </p>
        {search.isLoading ? (
          <p className="flex items-center gap-2 text-xs text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('system.notificationTargets.discoverSearching', 'Looking for devices…')}
          </p>
        ) : null}
        {!search.isLoading && total === 0 && findings.every((finding) => finding.error === null) ? (
          <p className="text-xs text-foreground-subtle">
            {t(
              'system.notificationTargets.discoverNone',
              'Every device that was found already has a target.',
            )}
          </p>
        ) : null}
        {findings.map((finding) => (
          <section key={finding.kind.kind} className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium text-foreground">
              <KindIcon
                kind={finding.kind}
                imgClassName="h-5 w-5 object-contain shrink-0"
                fallbackClassName="text-lg leading-5"
              />
              <span>{finding.kind.label}</span>
            </div>
            {finding.error !== null ? (
              <ErrorBox
                message={t(
                  'system.notificationTargets.discoverFailed',
                  'Could not look for {{kind}}: {{message}}',
                  { kind: finding.kind.label, message: finding.error },
                )}
              />
            ) : null}
            {finding.proposals.length > 0 ? (
              <ul className="divide-y divide-border rounded-md border border-border">
                {finding.proposals.map((proposal, index) => {
                  const key = rowKey(finding.kind, index)
                  return (
                    <li key={key} className="flex items-center gap-3 px-3 py-2">
                      <Checkbox
                        checked={!unticked.has(key)}
                        aria-label={t('system.notificationTargets.discoverPick', 'Add {{name}}', {
                          name: proposal.suggestedName,
                        })}
                        onChange={() => toggle(key)}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {proposal.suggestedName}
                      </span>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </section>
        ))}
      </div>
    </ItemFormDialog>
  )
}

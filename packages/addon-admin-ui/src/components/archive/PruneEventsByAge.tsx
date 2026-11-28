/**
 * Archive Tools → cluster-wide "prune events older than N days": permanently
 * deletes every event (and its media) older than the cutoff across all cameras,
 * behind a danger confirm.
 */
import { Button, Select, useConfirm, usePipelineAnalyticsPruneEvents } from '@dominevo/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Scissors } from 'lucide-react'
import { useCallback, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

const DAY_MS = 24 * 60 * 60 * 1000
const PRUNE_AGE_DAYS: readonly number[] = [1, 7, 30, 90]
const DEFAULT_AGE_DAYS = 30

export function PruneEventsByAge(): ReactElement {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
  const [ageDays, setAgeDays] = useState<number>(DEFAULT_AGE_DAYS)
  const prune = usePipelineAnalyticsPruneEvents({
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [['pipelineAnalytics']] })
    },
  })

  const onPrune = useCallback(async (): Promise<void> => {
    const ok = await confirm({
      title: t('recordings.eventsManagementSection.pruneTitle', { count: ageDays }),
      message: t(
        'recordings.eventsManagementSection.permanentlyDeletesEveryEventMotion',
        'Permanently deletes every event (motion / object / audio) older than the cutoff across all cameras, and their media. This cannot be undone.',
      ),
      confirmLabel: t('recordings.eventsManagementSection.pruneEvents', 'Prune events'),
      variant: 'danger',
    })
    if (!ok) return
    prune.mutate({ olderThanMs: Date.now() - ageDays * DAY_MS, reason: 'retention' }) // i18n-ignore: server-side reason code
  }, [confirm, prune, ageDays, t])

  return (
    <section
      className="flex flex-wrap items-center gap-2 text-xs"
      data-testid="prune-events-by-age"
    >
      <span className="text-foreground-subtle">
        {t('recordings.eventsManagementSection.pruneEventsOlderThan', 'Prune events older than')}
      </span>
      <Select
        wrapperClassName="inline-block w-auto"
        value={ageDays}
        onChange={(e) => setAgeDays(Number(e.target.value))}
        aria-label={t(
          'recordings.eventsManagementSection.pruneEventsOlderThan',
          'Prune events older than',
        )}
      >
        {PRUNE_AGE_DAYS.map((days) => (
          <option key={days} value={days}>
            {t('recordings.eventsManagementSection.ageDays', { count: days })}
          </option>
        ))}
      </Select>
      <Button variant="secondary" onClick={() => void onPrune()} disabled={prune.isPending}>
        {prune.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Scissors className="h-3 w-3" />
        )}
        {t('recordings.eventsManagementSection.pruneNow', 'Prune now')}
      </Button>
    </section>
  )
}

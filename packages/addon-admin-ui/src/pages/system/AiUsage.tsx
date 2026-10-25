/**
 * AI → Usage. The `llm.getUsage` server-side rollup (never raw call rows).
 *
 * Was a hand-rolled `<table>` inside an `overflow-x-auto` div — the one thing
 * on this page that already WAS a table, but not the shared one: no pinned
 * header, no internal scroll, no mobile rule. It is a `DataTable` now, so a
 * 90-day rollup scrolls its own rows with the column header pinned.
 */
import type { LlmProfile, LlmUsageRollup } from '@camstack/types'
import {
  DataTable,
  EmptyState,
  ErrorBox,
  SECTION_BODY,
  SectionCard,
  Select,
  Skeleton,
  TABLE_SCROLL_MAX_H,
  useSystem,
} from '@camstack/ui-library'
import type { DataColumn } from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Gauge } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PROFILES_KEY, USAGE_KEY } from './ai-page.helpers'

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_DAYS = [1, 7, 30, 90] as const

export function AiUsagePage() {
  const { t } = useTranslation()
  const system = useSystem()
  const [days, setDays] = useState<number>(7)

  // Anchored to MIDNIGHT, not to `Date.now()`. The rollup rows are per-day, so
  // a `since` in the middle of a day would clip the oldest bucket to a partial
  // one — and a bound that moves on every render is a bound the cache can never
  // settle on. The query key carries `days`, not the derived timestamp, for the
  // same reason.
  const since = useMemo(() => {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    return midnight.getTime() - (days - 1) * DAY_MS
  }, [days])

  const profilesQuery = useQuery({
    queryKey: PROFILES_KEY,
    queryFn: (): Promise<readonly LlmProfile[]> => system.trpcClient.llm.listProfiles.query({}),
  })
  const usageQuery = useQuery({
    queryKey: [...USAGE_KEY, days],
    queryFn: (): Promise<readonly LlmUsageRollup[]> =>
      system.trpcClient.llm.getUsage.query({ since }),
  })

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of profilesQuery.data ?? []) m.set(p.id, p.name)
    return m
  }, [profilesQuery.data])

  const columns = useMemo(
    (): readonly DataColumn<LlmUsageRollup>[] => [
      {
        key: 'day',
        header: t('ai.colDay', 'Day'),
        nowrap: true,
        render: (r) => <span className="tabular-nums">{r.day}</span>,
      },
      {
        key: 'consumer',
        header: t('ai.colConsumer', 'Consumer'),
        nowrap: true,
        render: (r) => <span className="text-foreground">{r.consumer}</span>,
      },
      {
        key: 'profile',
        header: t('ai.colProfile', 'Profile'),
        render: (r) => (
          <span className="text-foreground">{nameById.get(r.profileId) ?? r.profileId}</span>
        ),
      },
      {
        key: 'calls',
        header: t('ai.colCalls', 'Calls'),
        align: 'right',
        nowrap: true,
        render: (r) => <span className="tabular-nums">{String(r.calls)}</span>,
      },
      {
        key: 'okErr',
        header: t('ai.colOkErr', 'OK / err'),
        align: 'right',
        nowrap: true,
        render: (r) => (
          <span className={`tabular-nums ${r.errorCalls > 0 ? 'text-danger' : ''}`}>
            {`${String(r.okCalls)} / ${String(r.errorCalls)}`}
          </span>
        ),
      },
      {
        key: 'tokens',
        header: t('ai.colTokens', 'In / out tok'),
        align: 'right',
        nowrap: true,
        render: (r) => (
          <span className="tabular-nums">{`${String(r.inputTokens)} / ${String(r.outputTokens)}`}</span>
        ),
      },
      {
        key: 'latency',
        header: t('ai.colAvgMs', 'Avg ms'),
        align: 'right',
        nowrap: true,
        render: (r) => <span className="tabular-nums">{String(Math.round(r.avgLatencyMs))}</span>,
      },
    ],
    [nameById, t],
  )

  const rows = usageQuery.data ?? []

  // The window picker sits in the card header, where it stays when the window
  // is empty — it was in `AdminPage embedded`'s `actions`, which render nothing.
  const windowPicker = (
    <div className="w-36">
      <Select
        aria-label={t('ai.window', 'Window')}
        value={String(days)}
        options={WINDOW_DAYS.map((d) => ({
          value: String(d),
          // `days`, not `count`: i18next treats a `count` option as a PLURAL
          // selector and looks for `_one`/`_other` suffixed keys first.
          label: t('ai.lastDays', 'Last {{days}} days', { days: d }),
        }))}
        onChange={(e) => setDays(Number(e.target.value))}
      />
    </div>
  )

  return (
    <SectionCard
      headingId="ai-usage-list"
      title={t('ai.usageList', 'Rollup')}
      actions={windowPicker}
    >
      {usageQuery.isPending ? (
        <div className={`${SECTION_BODY} space-y-2`} data-testid="ai-usage-loading">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : usageQuery.isError ? (
        <div className={SECTION_BODY}>
          <ErrorBox
            title={t('ai.usageFailed', 'Failed to read usage')}
            message={
              usageQuery.error instanceof Error
                ? usageQuery.error.message
                : t('common.error', 'Error')
            }
            onRetry={() => void usageQuery.refetch()}
          />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={Gauge} title={t('ai.noUsage', 'No AI calls in this window.')} />
      ) : (
        <DataTable<LlmUsageRollup>
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.day}|${r.consumer}|${r.profileId}`}
          minWidthPx={720}
          bordered={false}
          maxBodyHeight={TABLE_SCROLL_MAX_H}
        />
      )}
    </SectionCard>
  )
}

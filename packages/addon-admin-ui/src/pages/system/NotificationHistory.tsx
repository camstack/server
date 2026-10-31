/**
 * Delivery HISTORY tab (slice D2).
 *
 * Wires `notificationRules.getHistory` — a read-only view over the durable
 * outbox — with filters (rule, device, status, time range, limit) and THREE
 * distinct states:
 *   - ROWS         → the matching deliveries, newest-first.
 *   - EMPTY        → the query succeeded with zero rows ("no deliveries").
 *   - UNAVAILABLE  → the query ERRORED (the method is not live on this hub
 *                    until the next server-update train). This is deliberately
 *                    distinguished from EMPTY: a blank page would read as
 *                    "nothing was delivered" when the truth is "history can't be
 *                    queried yet" (slice C review LOW).
 *
 * Status badges: pending / sent / dead, with the failure `error` surfaced on a
 * dead row.
 *
 * The rule filter is SEEDED from `?ruleId=` — a rules-table row's History
 * action lands here that way — and written back when the operator changes it,
 * so the URL and the filter never disagree (`notification-history.helpers.ts`).
 */

import type { NcHistoryEntry, NcHistoryStatus, NcRule } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import type { DataColumn } from '@camstack/ui-library'
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  TABLE_SCROLL_MAX_H,
  useDeviceManagerListAll,
  useSystem,
} from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { History, Loader2, RefreshCw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AdminPage } from '../../components/AdminPage'
import {
  type HistoryFilterState,
  historyRuleOptions,
  initialHistoryFilter,
  withHistoryRuleParam,
} from './notification-history.helpers'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const WINDOW_OPTIONS: readonly { readonly value: number; readonly labelKey: string }[] = [
  { value: 1, labelKey: 'system.notificationHistory.windowLastHour' },
  { value: 24, labelKey: 'system.notificationHistory.windowLast24h' },
  { value: 24 * 7, labelKey: 'system.notificationHistory.windowLast7d' },
  { value: 0, labelKey: 'system.notificationHistory.windowAllTime' },
]

const STATUS_OPTIONS: readonly { readonly value: string; readonly labelKey: string }[] = [
  { value: '', labelKey: 'system.notificationHistory.statusAny' },
  { value: 'pending', labelKey: 'system.notificationHistory.statusPending' },
  { value: 'sent', labelKey: 'system.notificationHistory.statusSent' },
  { value: 'dead', labelKey: 'system.notificationHistory.statusDead' },
]

const LIMIT_OPTIONS: readonly number[] = [50, 100, 250, 500]

function parseStatus(value: string): NcHistoryStatus | undefined {
  return value === 'pending' || value === 'sent' || value === 'dead' ? value : undefined
}

function statusVariant(status: NcHistoryStatus): 'info' | 'success' | 'danger' {
  switch (status) {
    case 'pending':
      return 'info'
    case 'sent':
      return 'success'
    case 'dead':
      return 'danger'
  }
}

/** Title + body frozen on the row at fire time — what the phone actually showed. */
function historyNotificationText(entry: NcHistoryEntry): {
  readonly title: string
  readonly body: string
} {
  const se = entry.subject.systemEvent
  if (se !== undefined) {
    return { title: se.title, body: se.body }
  }
  const label = entry.subject.label ?? entry.subject.className
  const zones = entry.subject.zones.length > 0 ? ` in ${entry.subject.zones.join(', ')}` : ''
  return { title: entry.ruleName, body: `${label}${zones}` }
}

function HistoryDeliveryDialog({
  entry,
  cameraName,
  onClose,
}: {
  readonly entry: NcHistoryEntry
  readonly cameraName: string
  readonly onClose: () => void
}) {
  const { t } = useTranslation()
  const text = historyNotificationText(entry)
  const se = entry.subject.systemEvent
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        width="md"
        placement="sheet-on-mobile"
        scroll="body"
        data-testid="history-delivery-detail"
      >
        <DialogHeader>
          <DialogTitle className="min-w-0 break-words">{text.title || entry.ruleName}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <dl className="space-y-3">
            <div>
              <dt className="text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
                {t('system.notificationHistory.body', 'Body')}
              </dt>
              <dd className="mt-1 whitespace-pre-wrap text-sm text-foreground">
                {text.body.length > 0 ? text.body : '—'}
              </dd>
            </div>
            <div className="grid grid-cols-2 gap-3 text-[11px]">
              <div>
                <dt className="font-medium text-foreground-subtle">
                  {t('system.notificationHistory.when', 'When')}
                </dt>
                <dd className="text-foreground">{new Date(entry.createdAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground-subtle">
                  {t('system.notificationHistory.status', 'Status')}
                </dt>
                <dd className="text-foreground">{entry.status}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground-subtle">
                  {t('system.notificationHistory.rule', 'Rule')}
                </dt>
                <dd className="text-foreground">{entry.ruleName}</dd>
              </div>
              <div>
                <dt className="font-medium text-foreground-subtle">
                  {t('system.notificationHistory.device', 'Device')}
                </dt>
                <dd className="text-foreground">{cameraName}</dd>
              </div>
              {se !== undefined ? (
                <div className="col-span-2">
                  <dt className="font-medium text-foreground-subtle">
                    {t('system.notificationHistory.kind', 'Kind')}
                  </dt>
                  <dd className="text-foreground">{se.kind}</dd>
                </div>
              ) : null}
              {entry.error !== undefined ? (
                <div className="col-span-2">
                  <dt className="font-medium text-foreground-subtle">
                    {t('common.error', 'Error')}
                  </dt>
                  <dd className="text-danger">{entry.error}</dd>
                </div>
              ) : null}
            </div>
          </dl>
        </DialogBody>
        <DialogFooter>
          <Button type="button" size="sm" variant="secondary" onClick={onClose}>
            {t('common.close', 'Close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function NotificationHistoryPage() {
  const { t } = useTranslation()
  const system = useSystem()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useState<HistoryFilterState>(() => initialHistoryFilter(searchParams))
  const [selected, setSelected] = useState<NcHistoryEntry | null>(null)
  const patch = (next: Partial<HistoryFilterState>): void =>
    setFilter((prev) => ({ ...prev, ...next }))
  const pickRule = (ruleId: string): void => {
    patch({ ruleId })
    setSearchParams(withHistoryRuleParam(searchParams, ruleId), { replace: true })
  }

  const rulesQuery = useQuery({
    queryKey: ['notificationRules', 'listRules', 'forHistory'],
    queryFn: async (): Promise<readonly NcRule[]> =>
      (await system.trpcClient.notificationRules.listRules.query({})).rules,
  })

  // The SHARED fleet query — same hook, same tRPC key and same cache entry the
  // sidebar search keeps warm, so opening this tab costs no round-trip and a
  // rename invalidated on `[['deviceManager']]` reaches it. It used to be a raw
  // `trpcClient.deviceManager.listAll.query({})` under a private key: a full
  // 1 019-row projection, no shared window (D274 matches the tRPC key prefix,
  // not `['deviceManager','listAll','forHistory']`) and no invalidation.
  //
  // `slim` is safe here BY FIELD: this reads `type`, `id` and `name`, and slim
  // drops only `config`, `metadata` and `sourceInfo`. The camera predicate is
  // still `type === Camera` client-side, NOT the server's `isCamera` filter —
  // those are different questions (`isCamera` is "has getStreamSources()" for a
  // hub-live device), and swapping them would change which rows appear.
  const devicesQuery = useDeviceManagerListAll({ projection: 'slim' })

  const nowMs = Date.now()
  const historyQuery = useQuery({
    queryKey: ['notificationRules', 'getHistory', filter],
    // Never auto-retry: a NOT_FOUND (method not live yet) must surface at once
    // as the "requires server update" state, not spin through retries.
    retry: false,
    queryFn: async (): Promise<readonly NcHistoryEntry[]> => {
      const since = filter.windowHours > 0 ? nowMs - filter.windowHours * 3_600_000 : undefined
      const res = await system.trpcClient.notificationRules.getHistory.query({
        filter: {
          limit: filter.limit,
          ...(filter.ruleId ? { ruleId: filter.ruleId } : {}),
          ...(filter.deviceId ? { deviceId: Number(filter.deviceId) } : {}),
          ...(parseStatus(filter.status) ? { status: parseStatus(filter.status) } : {}),
          ...(since !== undefined ? { since } : {}),
        },
      })
      return res.entries
    },
  })

  const cameraNameById = useMemo(() => {
    const m = new Map<number, string>()
    for (const d of devicesQuery.data ?? []) {
      if (d.type !== DeviceType.Camera) continue
      m.set(d.id, d.name)
    }
    return m
  }, [devicesQuery.data])

  const cameraName = (deviceId: number): string =>
    cameraNameById.get(deviceId) ?? t('system.notificationHistory.cameraFallback', { deviceId })

  const entries = historyQuery.data ?? []
  const unavailable = historyQuery.isError

  return (
    <AdminPage
      embedded
      icon={History}
      title={t('system.notificationHistory.deliveryHistory', 'Delivery history')}
      subtitle={t(
        'system.notificationHistory.aSearchableLogOfEvery',
        'A searchable log of every notification the rules delivered (or failed to deliver).',
      )}
    >
      {/* Filters */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <div>
          <label className="mb-1 block text-[10px] font-medium text-foreground-subtle">
            {t('system.notificationHistory.rule', 'Rule')}
          </label>
          <Select
            data-testid="history-rule-filter"
            value={filter.ruleId}
            onChange={(e) => pickRule(e.target.value)}
            options={[
              ...historyRuleOptions({
                rules: rulesQuery.data ?? [],
                answered: rulesQuery.isSuccess,
                selected: filter.ruleId,
              }),
            ]}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-foreground-subtle">
            {t('system.notificationHistory.camera', 'Camera')}
          </label>
          <Select
            value={filter.deviceId}
            onChange={(e) => patch({ deviceId: e.target.value })}
            options={[
              { value: '', label: t('system.notificationHistory.allCameras', 'All cameras') },
              ...(devicesQuery.data ?? []).map((c) => ({
                value: String(c.id),
                label: c.name,
              })),
            ]}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-foreground-subtle">
            {t('system.notificationHistory.status', 'Status')}
          </label>
          <Select
            value={filter.status}
            onChange={(e) => patch({ status: e.target.value })}
            options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-foreground-subtle">
            {t('system.notificationHistory.window', 'Window')}
          </label>
          <Select
            value={String(filter.windowHours)}
            onChange={(e) => patch({ windowHours: Number(e.target.value) })}
            options={WINDOW_OPTIONS.map((o) => ({ value: String(o.value), label: t(o.labelKey) }))}
          />
        </div>
        <div>
          <label className="mb-1 block text-[10px] font-medium text-foreground-subtle">
            {t('system.notificationHistory.limit', 'Limit')}
          </label>
          <Select
            value={String(filter.limit)}
            onChange={(e) => patch({ limit: Number(e.target.value) })}
            options={LIMIT_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          />
        </div>
      </div>

      {historyQuery.isLoading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {/* UNAVAILABLE — distinguishable from empty. */}
      {unavailable && !historyQuery.isLoading && (
        <Card>
          <div className="flex flex-col items-center gap-2 px-4 py-14 text-center">
            <History className="h-6 w-6 text-foreground-subtle" />
            <div className="text-sm font-medium text-foreground">
              {t(
                'system.notificationHistory.deliveryHistoryRequiresAServer',
                'Delivery history requires a server update',
              )}
            </div>
            <p className="max-w-md text-xs text-foreground-subtle">
              {t(
                'system.notificationHistory.theHistoryQueryIsNot',
                'The history query is not available on this hub yet. It becomes queryable after the next server update ships the notification-center history endpoint. Rules still deliver and record their outcome in the meantime.',
              )}
            </p>
            <Button
              variant="unstyled"
              type="button"
              onClick={() => void historyQuery.refetch()}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" /> {t('common.retry')}
            </Button>
          </div>
        </Card>
      )}

      {/* EMPTY — succeeded, zero rows. */}
      {!unavailable && !historyQuery.isLoading && entries.length === 0 && (
        <div className="py-16 text-center text-xs text-foreground-subtle">
          {t(
            'system.notificationHistory.noDeliveriesMatchTheseFilters',
            'No deliveries match these filters.',
          )}
        </div>
      )}

      {/* ROWS — a responsive table: horizontally scrollable on narrow
          viewports (the page itself never scrolls sideways), and vertically
          inside its own card so the five filters above it stay reachable while
          the operator reads 500 deliveries. A card stack cannot answer "which
          rule keeps failing?", so this is a table at every width. */}
      {!unavailable && entries.length > 0 && (
        <Card>
          <DataTable<NcHistoryEntry>
            columns={historyColumns(cameraName)}
            rows={entries}
            rowKey={(e) => e.id}
            minWidthPx={720}
            bordered={false}
            maxBodyHeight={TABLE_SCROLL_MAX_H}
            onRowClick={(row) => setSelected(row)}
          />
        </Card>
      )}

      {selected !== null && (
        <HistoryDeliveryDialog
          entry={selected}
          cameraName={cameraName(selected.deviceId)}
          onClose={() => setSelected(null)}
        />
      )}
    </AdminPage>
  )
}

/**
 * The history table columns. A delivery row is naturally tabular — when /
 * rule / camera / subject / status — and the operator scans it by column
 * ("which rule keeps failing?"), which a card list makes impossible.
 * The error text keeps its own full-width column: a dead row without its
 * reason is useless.
 */
function historyColumns(
  cameraName: (deviceId: number) => string,
): readonly DataColumn<NcHistoryEntry>[] {
  return [
    {
      key: 'when',
      header: i18n.t('system.notificationHistory.when', 'When'),
      nowrap: true,
      render: (e) => (
        <span className="text-[11px] text-foreground-subtle">
          {new Date(e.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'rule',
      header: i18n.t('system.notificationHistory.rule', 'Rule'),
      render: (e) => <span className="text-xs font-medium text-foreground">{e.ruleName}</span>,
    },
    {
      key: 'camera',
      header: i18n.t('system.notificationHistory.camera', 'Camera'),
      nowrap: true,
      render: (e) => (
        <span className="text-[11px] text-foreground-subtle">{cameraName(e.deviceId)}</span>
      ),
    },
    {
      key: 'subject',
      header: i18n.t('system.notificationHistory.notification', 'Notification'),
      render: (e) => {
        const text = historyNotificationText(e)
        return (
          <span className="block max-w-[18rem]">
            <span className="block truncate text-[11px] font-medium text-foreground">
              {text.title.length > 0 ? text.title : (e.subject.label ?? e.subject.className)}
            </span>
            {text.body.length > 0 ? (
              <span className="block truncate text-[10px] text-foreground-subtle">{text.body}</span>
            ) : null}
          </span>
        )
      },
    },
    {
      key: 'status',
      header: i18n.t('system.notificationHistory.status', 'Status'),
      nowrap: true,
      render: (e) => (
        <span className="flex items-center gap-1.5">
          <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
          {e.attempts > 1 ? (
            <span className="text-[10px] text-foreground-subtle">×{e.attempts}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'error',
      header: i18n.t('system.notificationHistory.detail', 'Detail'),
      render: (e) =>
        e.error ? (
          <span className="text-[11px] text-danger">{e.error}</span>
        ) : (
          <span className="text-[11px] text-foreground-subtle">—</span>
        ),
    },
  ]
}

export default NotificationHistoryPage

/**
 * The keychain audit (who stored, revealed, rotated, reset — never a value),
 * newest first, a page at a time. The hub answers the most recent
 * `KEYCHAIN_AUDIT_FETCH` entries; paging is over that window.
 */
import type { KeychainAuditAction, KeychainAuditEntry } from '@camstack/types'
import { Badge, Button, DataTable, type DataColumn } from '@camstack/ui-library'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { TFunction } from 'i18next'
import { useMemo, useState } from 'react'
import { formatWhen } from './format'
import { Truncated } from './Truncated'
import { useTranslation } from 'react-i18next'

/** The cap's own maximum for `listAudit.limit`. */
export const KEYCHAIN_AUDIT_FETCH = 500
export const KEYCHAIN_AUDIT_PAGE_SIZE = 25

/** Actions that hand out material or change the key are the ones worth spotting. */
const LOUD: ReadonlySet<KeychainAuditAction> = new Set([
  'reveal',
  'download-recovery-key',
  'rotate-master-key',
  'reset',
])

function auditColumns(t: TFunction): DataColumn<KeychainAuditEntry>[] {
  return [
    { key: 'at', header: t('system.keychainAuditTable.colWhen'), render: (a) => formatWhen(a.at) },
    {
      key: 'action',
      header: t('system.keychainAuditTable.colAction'),
      render: (a) => <Badge variant={LOUD.has(a.action) ? 'warning' : 'default'}>{a.action}</Badge>,
    },
    {
      key: 'actor',
      header: t('system.keychainAuditTable.colActor'),
      render: (a) => <span className="font-mono">{a.actor}</span>,
    },
    {
      key: 'ref',
      header: t('system.keychainAuditTable.colRef'),
      render: (a) =>
        a.ref === null ? (
          <span className="text-foreground-subtle">—</span>
        ) : (
          <Truncated value={a.ref} srLabel="secret ref" maxWidthClass="max-w-[22rem]" />
        ),
    },
    {
      key: 'detail',
      header: t('system.keychainAuditTable.colDetail'),
      render: (a) => <span className="text-foreground-muted">{a.detail ?? ''}</span>,
    },
  ]
}

export function KeychainAuditTable({
  entries,
}: {
  readonly entries: readonly KeychainAuditEntry[] | undefined
}) {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)
  const columns = useMemo(() => auditColumns(t), [t])
  if (entries === undefined)
    return <p className="text-xs text-foreground-subtle">{t('common.loading', 'Loading…')}</p>
  const pages = Math.max(1, Math.ceil(entries.length / KEYCHAIN_AUDIT_PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const start = current * KEYCHAIN_AUDIT_PAGE_SIZE
  const rows = entries.slice(start, start + KEYCHAIN_AUDIT_PAGE_SIZE)
  return (
    <div className="space-y-2">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(a) => a.id}
        minWidthPx={760}
        emptyMessage={t(
          'secrets.keychainAuditTable.nothingHasBeenAuditedYet',
          'Nothing has been audited yet.',
        )}
      />
      {entries.length > KEYCHAIN_AUDIT_PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-foreground-subtle">
          <span>
            {t(
              entries.length >= KEYCHAIN_AUDIT_FETCH
                ? 'system.keychainAuditTable.rangeRecent'
                : 'system.keychainAuditTable.range',
              { from: start + 1, to: start + rows.length, total: entries.length },
            )}
          </span>
          <span className="inline-flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              aria-label={t('secrets.keychainAuditTable.previousPage', 'Previous page')}
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <span className="tabular-nums">
              {current + 1} / {pages}
            </span>
            <Button
              size="sm"
              variant="outline"
              aria-label={t('secrets.keychainAuditTable.nextPage', 'Next page')}
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The files on the selected node — one row per model × format — as the
 * library DataTable (cards below `sm`, so a phone never scrolls sideways).
 */
import { useState, type ReactNode } from 'react'
import { BTN_COMPACT_DANGER, DataTable, type DataColumn, Button } from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import type { InstalledDeviceChip, InstalledFileRow } from '../../ui/installed-inventory.js'
import { formatMB } from '../../ui/model-studio-ui.js'
import { FillBadges } from '../FillBadges.js'
import { InlineRename } from '../InlineRename.js'
import { DeviceChips } from './DeviceChips.js'
import { PrecisionBadge, StaleBadge, UsageBadge } from './UsageBadge.js'
import { providerLabel } from './provider-label.js'
import { useT } from '../../i18n/index.js'

export interface InstalledFilesTableProps {
  readonly rows: readonly InstalledFileRow[]
  readonly emptyMessage: string
  readonly onRemove: (row: InstalledFileRow) => Promise<void>
  readonly onRename: (row: InstalledFileRow, name: string) => Promise<void>
  /** A chip click on a node-scoped CamStack row (activate / settings). */
  readonly onChip: (row: InstalledFileRow, chip: InstalledDeviceChip) => Promise<void>
  readonly onError: (message: string) => void
}

function ModelCell({
  row,
  onRename,
  onError,
}: {
  readonly row: InstalledFileRow
  readonly onRename: (name: string) => Promise<void>
  readonly onError: (message: string) => void
}): ReactNode {
  const { t } = useT()
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 whitespace-normal"
      data-testid="installed-file"
      data-row-key={row.key}
      data-usage={row.usage}
      data-removable={row.removable ? 'true' : 'false'}
    >
      {row.renameable ? (
        <InlineRename name={row.name} modelId={row.modelId} onRename={onRename} onError={onError} />
      ) : (
        <span className="text-xs font-medium text-foreground break-words">
          {row.name} <span className="font-normal text-foreground-subtle">· {row.modelId}</span>
        </span>
      )}
      <span className="text-[10px] text-foreground-subtle break-words">
        {row.stepId} · {providerLabel(row.provider, t)}
        {row.clusterScoped ? t('filesTable.clusterModel') : ''}
        {row.description ? ` · ${row.description}` : ''}
      </span>
      <FillBadges supplies={row.supplies} />
    </div>
  )
}

function FormatCell({ row }: { readonly row: InstalledFileRow }): ReactNode {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className="font-mono text-[11px] text-foreground">{row.format}</span>
      {row.precision !== undefined && <PrecisionBadge precision={row.precision} />}
      {row.onDisk === 'stale' && <StaleBadge />}
    </span>
  )
}

function RemoveCell({
  row,
  busy,
  onRemove,
}: {
  readonly row: InstalledFileRow
  readonly busy: boolean
  readonly onRemove: () => void
}): ReactNode {
  const { t } = useT()
  if (!row.removable) return null
  return (
    <Button
      variant="unstyled"
      type="button"
      className={BTN_COMPACT_DANGER}
      disabled={busy}
      onClick={onRemove}
      aria-label={t('filesTable.removeAria', { modelId: row.modelId, format: row.format })}
      title={t('filesTable.removeTitle', { modelId: row.modelId, format: row.format })}
    >
      {busy && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />}
      {t('filesTable.remove')}
    </Button>
  )
}

function useBusyRows() {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const run = async (key: string, work: () => Promise<void>): Promise<void> => {
    setBusy((prev) => new Set([...prev, key]))
    try {
      await work()
    } finally {
      setBusy((prev) => new Set([...prev].filter((k) => k !== key)))
    }
  }
  return { busy, run }
}

export function InstalledFilesTable({
  rows,
  emptyMessage,
  onRemove,
  onRename,
  onChip,
  onError,
}: InstalledFilesTableProps): ReactNode {
  const { t } = useT()
  const { busy, run } = useBusyRows()
  const guarded = (row: InstalledFileRow, work: () => Promise<void>) => {
    void run(row.key, async () => {
      try {
        await work()
      } catch (err) {
        onError(err instanceof Error ? err.message : t('filesTable.actionFailed'))
      }
    })
  }

  const columns: readonly DataColumn<InstalledFileRow>[] = [
    {
      key: 'model',
      header: t('filesTable.cols.model'),
      nowrap: false,
      sortValue: (r) => r.name,
      render: (r) => <ModelCell row={r} onRename={(name) => onRename(r, name)} onError={onError} />,
    },
    {
      key: 'format',
      header: t('filesTable.cols.format'),
      sortValue: (r) => r.format,
      render: (r) => <FormatCell row={r} />,
    },
    {
      key: 'size',
      header: t('filesTable.cols.size'),
      align: 'right',
      sortValue: (r) => r.sizeMB,
      render: (r) => <span className="font-mono text-[11px]">{formatMB(r.sizeMB)}</span>,
    },
    {
      key: 'devices',
      header: t('filesTable.cols.devices'),
      nowrap: false,
      notSortableReason: t('filesTable.devicesNotSortable'),
      render: (r) => (
        <DeviceChips
          chips={r.chips}
          disabled={busy.has(r.key)}
          onChip={
            r.clusterScoped || r.origin !== 'pipeline' || r.usage === 'outside-pools'
              ? undefined
              : (chip) => guarded(r, () => onChip(r, chip))
          }
        />
      ),
    },
    {
      key: 'status',
      header: t('filesTable.cols.status'),
      sortValue: (r) => r.usage,
      render: (r) => <UsageBadge usage={r.usage} />,
    },
    {
      key: 'actions',
      align: 'right',
      render: (r) => (
        <RemoveCell row={r} busy={busy.has(r.key)} onRemove={() => guarded(r, () => onRemove(r))} />
      ),
    },
  ]

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.key}
      minWidthPx={760}
      emptyMessage={emptyMessage}
      defaultSort={{ columnKey: 'model', dir: 'asc' }}
      rowClassName={(r) => (r.usage === 'unused' ? 'bg-warning/[0.03]' : undefined)}
    />
  )
}

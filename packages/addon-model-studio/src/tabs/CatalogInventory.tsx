/**
 * Catalog inventory — registered models for one provider on the selected node.
 * Presence + Remove only (Distribute removed: Import lands on the chosen node).
 */
import { FillBadges } from '../components/FillBadges.js'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  DataTable,
  ErrorBox,
  Skeleton,
  TABLE_SCROLL_MAX_H,
  type AddonPageProps,
  type DataColumn,
} from '@camstack/ui-library'
import {
  inferModelProvider,
  type CustomModelDescriptor,
  type ModelProviderId,
} from '@camstack/types'
import { listAvailability, listCustomModels, removeCustomModel } from '../ui/api.js'
import {
  formatMB,
  formatsByNode,
  toModelRows,
  type AvailabilityMap,
  type ModelRow,
} from '../ui/model-studio-ui.js'
import { Trans, useT } from '../i18n/index.js'

export interface CatalogInventoryProps {
  readonly trpc: AddonPageProps['trpc']
  readonly refreshKey: number
  readonly provider: Exclude<ModelProviderId, 'camstack'>
  readonly nodeId: string
}

interface InventoryRow {
  readonly id: string
  readonly name: string
  readonly stepId: string
  readonly description: string
  readonly supplies: ModelRow['supplies']
  readonly formats: readonly string[]
  readonly sizeMB: number
}

function toInventoryRows(rows: readonly ModelRow[], nodeId: string): readonly InventoryRow[] {
  return rows.map((row) => {
    const onNodes = formatsByNode(row.nodes)
    const formats = onNodes.find((n) => n.nodeId === nodeId)?.formats ?? []
    return {
      id: row.id,
      name: row.name,
      stepId: row.stepId,
      description: row.description ?? '',
      supplies: row.supplies,
      formats,
      sizeMB: row.sizeMB,
    }
  })
}

function ModelCell({ row }: { readonly row: InventoryRow }): ReactNode {
  const { t } = useT()
  return (
    <div
      className="flex min-w-0 flex-col gap-0.5 whitespace-normal"
      data-testid="catalog-inventory-row"
      data-model-id={row.id}
    >
      <span className="text-xs font-medium text-foreground break-words">
        {row.name} <span className="font-normal text-foreground-subtle">· {row.id}</span>
      </span>
      <span className="text-[10px] text-foreground-subtle break-words">
        {t('inventory.step', { stepId: row.stepId })}
        {row.description ? ` · ${row.description}` : ''}
      </span>
      <FillBadges supplies={row.supplies} />
    </div>
  )
}

export function CatalogInventory({ trpc, refreshKey, provider, nodeId }: CatalogInventoryProps) {
  const { t } = useT()
  const [models, setModels] = useState<CustomModelDescriptor[]>([])
  const [availability, setAvailability] = useState<AvailabilityMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [m, a] = await Promise.all([listCustomModels(trpc), listAvailability(trpc)])
      setModels([...m])
      setAvailability(a)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('inventory.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [trpc, t])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load, refreshKey])

  const rows = useMemo(() => {
    const filtered = models.filter((m) => inferModelProvider(m.entry) === provider)
    const modelRows = toModelRows(filtered, availability).filter((row) =>
      row.nodes.some((n) => n.nodeId === nodeId),
    )
    return toInventoryRows(modelRows, nodeId)
  }, [models, availability, provider, nodeId])

  const handleRemove = useCallback(
    async (id: string) => {
      try {
        await removeCustomModel(trpc, id)
        await load()
      } catch (err) {
        setError(err instanceof Error ? err.message : t('inventory.removeFailed'))
      }
    },
    [trpc, load, t],
  )

  const columns: readonly DataColumn<InventoryRow>[] = useMemo(
    () => [
      {
        key: 'model',
        header: t('inventory.cols.model'),
        nowrap: false,
        sortValue: (r) => r.name,
        render: (r) => <ModelCell row={r} />,
      },
      {
        key: 'formats',
        header: t('inventory.cols.formats'),
        nowrap: false,
        notSortableReason: t('inventory.formatsNotSortable'),
        render: (r) => (
          <span className="inline-flex flex-wrap gap-1">
            {r.formats.map((f) => (
              <span
                key={f}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border bg-success/10 text-success border-success/30"
              >
                {f}
              </span>
            ))}
          </span>
        ),
      },
      {
        key: 'size',
        header: t('inventory.cols.size'),
        align: 'right',
        sortValue: (r) => r.sizeMB,
        render: (r) => <span className="font-mono text-[11px]">{formatMB(r.sizeMB)}</span>,
      },
      {
        key: 'actions',
        align: 'right',
        render: (r) => (
          <Button
            variant="danger"
            size="sm"
            onClick={() => void handleRemove(r.id)}
            aria-label={t('inventory.removeAria', { name: r.name })}
            title={t('inventory.removeTitle')}
          >
            {t('inventory.remove')}
          </Button>
        ),
      },
    ],
    [handleRemove, t],
  )

  if (loading) {
    return (
      <div className="space-y-2 py-4" data-testid="catalog-inventory" data-provider={provider}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-24 w-full" />
        <p className="text-center text-sm text-foreground-subtle">{t('inventory.loading')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="catalog-inventory" data-provider={provider}>
      {error !== null && <ErrorBox title={t('inventory.errorTitle')} message={error} />}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-foreground-subtle">
          <Trans
            i18nKey="inventory.summary"
            values={{ count: rows.length, nodeId }}
            components={{ mono: <span className="font-mono" /> }}
          />
        </span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        minWidthPx={640}
        maxBodyHeight={TABLE_SCROLL_MAX_H}
        defaultSort={{ columnKey: 'model', dir: 'asc' }}
        emptyMessage={t('inventory.empty', { provider, nodeId })}
      />
    </div>
  )
}

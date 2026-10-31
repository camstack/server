/**
 * Shared Import action row: per-format Import / imported / blocked + optional
 * cluster presence chips (node · format).
 */
import type { ModelFormat } from '@camstack/types'
import { formatMB, type ModelNodePresence } from '../ui/model-studio-ui.js'
import {
  isPluginCatalogImported,
  pluginCatalogImportBlockedReason,
} from '../plugin-catalog/plugin-catalog-catalog-selectors.js'
import { useT } from '../i18n/index.js'
import { Button } from '@camstack/ui-library'

const FORMAT_LABEL: Readonly<Record<string, string>> = {
  onnx: 'ONNX',
  openvino: 'OpenVINO',
  coreml: 'CoreML',
  tflite: 'TFLite',
  pt: 'PyTorch',
}

export interface FormatRowEntry {
  readonly id: string
  readonly format: ModelFormat
  readonly sizeMB?: number
  readonly driftStatus?: string
}

export interface FormatImportRowProps {
  readonly entries: readonly FormatRowEntry[]
  readonly registeredIds: ReadonlySet<string> | null
  /**
   * When set, overrides the default `registeredIds.has(entry.id)` check —
   * plus catalog uses one registry id for several formats.
   */
  readonly isImported?: (entry: FormatRowEntry) => boolean
  readonly presence?: readonly ModelNodePresence[]
  readonly busyId: string | null
  readonly onImport: (id: string) => void
  readonly onDistributeAll?: () => void
  readonly distributeBusy?: boolean
}

export function FormatImportRow({
  entries,
  registeredIds,
  isImported: isImportedFn,
  presence = [],
  busyId,
  onImport,
  onDistributeAll,
  distributeBusy = false,
}: FormatImportRowProps) {
  const { t } = useT()
  const resolveImported = (entry: FormatRowEntry): boolean => {
    if (isImportedFn !== undefined) return isImportedFn(entry)
    return registeredIds !== null ? isPluginCatalogImported(registeredIds, entry.id) : false
  }

  const anyImported = registeredIds !== null && entries.some((e) => resolveImported(e))

  return (
    <div className="space-y-2 pt-1">
      <div className="flex flex-wrap gap-2">
        {entries.map((entry) => {
          const imported = resolveImported(entry)
          const blocked = pluginCatalogImportBlockedReason({
            driftStatus: entry.driftStatus ?? 'ok',
            imported,
            registryKnown: registeredIds !== null,
          })
          return (
            <div
              key={entry.format}
              className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[11px]"
            >
              <span className="font-mono text-foreground">
                {FORMAT_LABEL[entry.format] ?? entry.format}
              </span>
              {typeof entry.sizeMB === 'number' && (
                <span className="text-foreground-subtle">{formatMB(entry.sizeMB)}</span>
              )}
              {imported ? (
                <span className="text-success">{t('formatRow.imported')}</span>
              ) : blocked !== undefined ? (
                <span className="text-warning" title={blocked}>
                  {entry.driftStatus !== undefined &&
                  entry.driftStatus !== 'ok' &&
                  entry.driftStatus.length > 0
                    ? entry.driftStatus
                    : t('formatRow.blocked')}
                </span>
              ) : (
                <Button
                  variant="unstyled"
                  type="button"
                  disabled={busyId === entry.id}
                  onClick={() => onImport(entry.id)}
                  className="px-2 py-0.5 text-[10px] font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {busyId === entry.id ? t('common.importing') : t('common.import')}
                </Button>
              )}
            </div>
          )
        })}
      </div>

      {presence.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          <span className="uppercase tracking-wide text-foreground-subtle mr-1">
            {t('formatRow.onCluster')}
          </span>
          {presence.map((n) => (
            <span
              key={`${n.nodeId}-${n.format}`}
              className="px-1.5 py-0.5 rounded bg-surface-hover text-foreground"
              title={t('formatRow.presenceTitle', { format: n.format, nodeId: n.nodeId })}
            >
              {n.nodeId} · {n.format}
            </span>
          ))}
        </div>
      )}

      {anyImported && onDistributeAll !== undefined && (
        <Button
          variant="unstyled"
          type="button"
          disabled={distributeBusy}
          onClick={onDistributeAll}
          className="px-3 py-1.5 text-[10px] font-medium rounded-md border border-primary/40 text-primary hover:bg-primary/10 disabled:opacity-50"
        >
          {distributeBusy ? t('formatRow.distributing') : t('formatRow.distributeAll')}
        </Button>
      )}
    </div>
  )
}

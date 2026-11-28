/** Baseline vs candidate (vs INT8) per class, and the per-camera recall changes. */
import type { TrainingEvalClass, TrainingResult } from '@dominevo/types'
import { type DataColumn, DataTable, useIsPhone } from '@dominevo/ui-library'
import { useT } from '../i18n/index.js'
import { type ComparisonRow, comparisonRows, formatPct, recallDeltaRows } from './view-model.js'

const TONE = {
  better: 'text-success',
  worse: 'text-danger',
  same: 'text-foreground-muted',
} as const

/** On a phone the header is gone, so a detail cell names its column itself. */
function PhoneLabelled({
  label,
  c,
}: {
  readonly label: string
  readonly c: TrainingEvalClass | null
}) {
  const phone = useIsPhone()
  return (
    <span className="block">
      {phone && <span className="mr-1 font-medium text-foreground-muted">{label}</span>}
      <CellContent c={c} />
    </span>
  )
}

function CellContent({ c }: { readonly c: TrainingEvalClass | null }) {
  const { t } = useT()
  if (c === null) return <span className="text-foreground-subtle">—</span>
  const night = c.recallByLight?.['night']
  const small =
    c.smallTotal !== undefined && c.smallTotal > 0
      ? ` · ${t('comparison.small', { found: c.smallFound ?? 0, total: c.smallTotal })}`
      : ''
  return (
    <span className="text-foreground">
      {t('comparison.metrics', {
        precision: formatPct(c.precision),
        recall: formatPct(c.recall),
        ap50: formatPct(c.ap50),
      })}
      <span className="block text-xs text-foreground-subtle max-sm:ml-1 max-sm:inline">
        {t('comparison.floorNight', {
          floor: c.floor === null ? '—' : c.floor.toFixed(2),
          night: formatPct(night),
        })}
        {small}
      </span>
    </span>
  )
}

export function ComparisonTable({
  result,
  cameraName,
}: {
  readonly result: TrainingResult
  readonly cameraName: (id: number) => string
}) {
  const { t } = useT()
  const rows = comparisonRows(result)
  const deltas = recallDeltaRows(result)
  const hasInt8 = rows.some((r) => r.int8 !== null)
  if (rows.length === 0)
    return <p className="text-sm text-foreground-muted">{t('comparison.noEvaluation')}</p>
  const int8Columns: readonly DataColumn<ComparisonRow>[] = hasInt8
    ? [
        {
          mobile: 'detail',
          key: 'int8',
          header: t('comparison.fineTunedInt8'),
          nowrap: false,
          render: (r) => <PhoneLabelled label={t('comparison.fineTunedInt8')} c={r.int8} />,
        },
      ]
    : []
  return (
    <div className="space-y-2">
      <div data-testid="comparison-table">
        <DataTable
          rows={rows}
          rowKey={(r) => r.cls}
          minWidthPx={560}
          columns={[
            {
              mobile: 'primary',
              key: 'class',
              header: t('comparison.classColumn'),
              render: (r) => (
                <span className="font-medium text-foreground">
                  {r.cls} ({r.candidate?.positives ?? r.baseline?.positives ?? 0})
                </span>
              ),
            },
            {
              mobile: 'detail',
              key: 'baseline',
              header: t('comparison.current'),
              nowrap: false,
              render: (r) => <PhoneLabelled label={t('comparison.current')} c={r.baseline} />,
            },
            {
              mobile: 'detail',
              key: 'candidate',
              header: t('comparison.fineTuned'),
              nowrap: false,
              render: (r) => <PhoneLabelled label={t('comparison.fineTuned')} c={r.candidate} />,
            },
            ...int8Columns,
          ]}
        />
      </div>
      {deltas.length > 0 && (
        <ul
          className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
          aria-label={t('comparison.recallChange')}
        >
          {deltas.map((d) => (
            <li key={`${d.cls}-${String(d.deviceId)}`} className={TONE[d.tone]}>
              {t('comparison.delta', {
                camera: cameraName(d.deviceId),
                cls: d.cls,
                value: `${d.delta >= 0 ? '+' : ''}${(d.delta * 100).toFixed(1)}`,
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

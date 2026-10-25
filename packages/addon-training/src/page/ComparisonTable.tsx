/** Baseline vs candidate (vs INT8) per class, and the per-camera recall changes. */
import type { TrainingEvalClass, TrainingResult } from '@camstack/types'
import { useT } from '../i18n/index.js'
import { comparisonRows, formatPct, recallDeltaRows } from './view-model.js'

const TONE = {
  better: 'text-success',
  worse: 'text-danger',
  same: 'text-foreground-muted',
} as const

function Cell({ c }: { readonly c: TrainingEvalClass | null }) {
  const { t } = useT()
  if (c === null) return <td className="px-2 py-1 text-foreground-subtle">—</td>
  const night = c.recallByLight?.['night']
  const small =
    c.smallTotal !== undefined && c.smallTotal > 0
      ? ` · ${t('comparison.small', { found: c.smallFound ?? 0, total: c.smallTotal })}`
      : ''
  return (
    <td className="px-2 py-1 text-foreground">
      {t('comparison.metrics', {
        precision: formatPct(c.precision),
        recall: formatPct(c.recall),
        ap50: formatPct(c.ap50),
      })}
      <span className="block text-xs text-foreground-subtle">
        {t('comparison.floorNight', {
          floor: c.floor === null ? '—' : c.floor.toFixed(2),
          night: formatPct(night),
        })}
        {small}
      </span>
    </td>
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
  return (
    <div className="space-y-2 overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid="comparison-table">
        <thead className="text-xs text-foreground-subtle">
          <tr>
            <th className="px-2 py-1">{t('comparison.classColumn')}</th>
            <th className="px-2 py-1">{t('comparison.current')}</th>
            <th className="px-2 py-1">{t('comparison.fineTuned')}</th>
            {hasInt8 && <th className="px-2 py-1">{t('comparison.fineTunedInt8')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.cls} className="border-t border-border">
              <td className="px-2 py-1 font-medium text-foreground">
                {r.cls} ({r.candidate?.positives ?? r.baseline?.positives ?? 0})
              </td>
              <Cell c={r.baseline} />
              <Cell c={r.candidate} />
              {hasInt8 && <Cell c={r.int8} />}
            </tr>
          ))}
        </tbody>
      </table>
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

/**
 * A read-only model section: what each accelerator runs. On the node step view
 * a model is changed from that accelerator's cell; on a camera it is not
 * changed at all — a model is chosen by the accelerator that runs it (D927) —
 * so the caller may name where it is changed (`hint`) and link each row to
 * that accelerator's cell (`href`).
 */
import { Link } from 'react-router-dom'
import { LIST_ROW, TEXT_HINT } from '@camstack/ui-library'
import { useTranslation } from 'react-i18next'

export interface EffectiveModelRow {
  readonly id: string
  readonly label: string
  readonly modelId: string | undefined
  readonly sourceLabel: string
  /** Where this accelerator's model is set — rendered as a link on the row. */
  readonly href?: string
}

export interface EffectiveModelSummaryProps {
  readonly rows: readonly EffectiveModelRow[]
  /** Where a model is changed; absent = "open that accelerator's cell". */
  readonly hint?: string
}

export function EffectiveModelSummary({ rows, hint }: EffectiveModelSummaryProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1.5" data-testid="effective-models">
      <ul className="divide-y divide-border rounded-md border border-border">
        {rows.map((row) => (
          <li key={row.id} className={`${LIST_ROW} flex flex-wrap items-baseline gap-x-2 text-xs`}>
            {/* A linked row names its accelerator in full — it is the point of the row. */}
            <span
              className={
                row.href !== undefined
                  ? 'basis-full text-foreground-muted'
                  : 'min-w-0 flex-1 truncate text-foreground-muted'
              }
            >
              {row.label}
            </span>
            <span className="font-mono text-foreground">{row.modelId ?? '—'}</span>
            <span className="text-[10px] text-foreground-subtle">{row.sourceLabel}</span>
            {row.href !== undefined && (
              <Link to={row.href} className="ml-auto text-[11px] text-primary hover:underline">
                {t('stepInspector.effectiveModelSummary.changeOnAccelerator')}
              </Link>
            )}
          </li>
        ))}
      </ul>
      <p className={TEXT_HINT}>
        {hint ??
          t(
            'stepInspector.effectiveModelSummary.toChangeAModelOpen',
            "To change a model, open that accelerator's cell in the table.",
          )}
      </p>
    </div>
  )
}

import { type JSX } from 'react'
import { useUiText } from '../contexts/ui-text'
/**
 * StepTimings — displays pipeline execution timings per step.
 */

export interface StepTimingsProps {
  readonly timings: Readonly<Record<string, number>>
  readonly totalMs?: number
  readonly className?: string
}

export function StepTimings({ timings, totalMs, className }: StepTimingsProps): JSX.Element | null {
  const t = useUiText()
  const entries = Object.entries(timings)
  if (entries.length === 0 && totalMs === undefined) return null

  return (
    <div className={`rounded-lg border border-border bg-surface p-3 space-y-2 ${className ?? ''}`}>
      <div className="text-xs font-medium text-foreground-subtle uppercase tracking-wide">
        {t('uiLibrary.stepTimings.timings', 'Timings')}
      </div>
      <div className="space-y-1 text-xs">
        {entries.map(([step, ms]) => (
          <div key={step} className="flex justify-between">
            <span className="text-foreground-subtle">{step}</span>
            <span className="font-mono text-foreground">{ms.toFixed(1)}ms</span>
          </div>
        ))}
        {totalMs !== undefined && (
          <div className="flex justify-between pt-1 border-t border-border font-medium text-foreground">
            <span>{t('uiLibrary.stepTimings.total', 'Total')}</span>
            <span className="font-mono">{totalMs.toFixed(1)}ms</span>
          </div>
        )}
      </div>
    </div>
  )
}

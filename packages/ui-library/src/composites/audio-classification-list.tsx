import { useUiText } from '../contexts/ui-text'
import { type JSX } from 'react'
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioClassification {
  readonly className: string
  readonly score: number
}

export interface AudioClassificationListProps {
  /** Sorted classifications (highest score first) */
  readonly classifications: readonly AudioClassification[]
  /** Processing state indicator */
  readonly processing?: boolean
  /** Inference time in ms */
  readonly inferenceMs?: number
  /** Max items to show (default: 10) */
  readonly maxItems?: number
  /** Optional className */
  readonly className?: string
}

// ---------------------------------------------------------------------------
// Score bar colors
// ---------------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score >= 0.8) return 'bg-emerald-500'
  if (score >= 0.5) return 'bg-amber-500'
  if (score >= 0.3) return 'bg-orange-500'
  return 'bg-zinc-500'
}

function scoreTextColor(score: number): string {
  if (score >= 0.8) return 'text-emerald-400'
  if (score >= 0.5) return 'text-amber-400'
  if (score >= 0.3) return 'text-orange-400'
  return 'text-zinc-400'
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Displays audio classification results as a ranked list with score bars.
 */
export function AudioClassificationList({
  classifications,
  processing = false,
  inferenceMs,
  maxItems = 10,
  className = '',
}: AudioClassificationListProps): JSX.Element {
  const t = useUiText()
  const items = classifications.slice(0, maxItems)
  const maxScore = items.length > 0 ? items[0]!.score : 1

  if (processing) {
    return (
      <div className={`rounded-xl border border-border bg-surface p-4 text-center ${className}`}>
        <div className="text-sm text-foreground-subtle animate-pulse">
          {t('uiLibrary.audioClassificationList.processing', 'Classifying audio...')}
        </div>
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className={`rounded-xl border border-border bg-surface p-4 text-center ${className}`}>
        <div className="text-xs text-foreground-subtle">
          {t('uiLibrary.audioClassificationList.empty', 'No classifications yet')}
        </div>
      </div>
    )
  }

  return (
    <div className={`rounded-xl border border-border bg-surface overflow-hidden ${className}`}>
      <div className="px-3 py-2 border-b border-border flex items-center justify-between">
        <h3 className="text-xs font-medium text-foreground">
          {t('uiLibrary.audioClassificationList.title', 'Audio Classifications')}
        </h3>
        <div className="flex items-center gap-3 text-[10px] text-foreground-subtle">
          {items.length < classifications.length && (
            <span>
              {t('uiLibrary.audioClassificationList.showing', 'showing {{shown}} of {{total}}', {
                shown: items.length,
                total: classifications.length,
              })}
            </span>
          )}
          {inferenceMs !== undefined && (
            <span className="font-mono">{inferenceMs.toFixed(1)}ms</span>
          )}
        </div>
      </div>
      <div className="divide-y divide-border/50">
        {items.map((item, i) => {
          const barWidth = maxScore > 0 ? (item.score / maxScore) * 100 : 0
          return (
            <div
              key={`${item.className}-${i}`}
              className="px-3 py-1.5 flex items-center gap-3 hover:bg-surface-hover/30"
            >
              <span className="text-[10px] text-foreground-subtle w-5 text-right font-mono">
                {i + 1}
              </span>
              <span className="text-xs font-medium text-foreground min-w-[120px]">
                {item.className}
              </span>
              <div className="flex-1 h-2 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${scoreColor(item.score)}`}
                  style={{ width: `${barWidth}%` }}
                />
              </div>
              <span
                className={`text-xs font-mono font-semibold w-14 text-right ${scoreTextColor(item.score)}`}
              >
                {(item.score * 100).toFixed(1)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

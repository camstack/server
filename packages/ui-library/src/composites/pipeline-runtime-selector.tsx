import { Cpu, Star } from 'lucide-react'
import { type JSX } from 'react'
import { useUiText } from '../contexts/ui-text'

export interface PipelineRuntimeOption {
  readonly id: string
  readonly label: string
  readonly available: boolean
  /** Platform score for this backend (higher = better) */
  readonly platformScore?: number
  /** Whether this is the best-scored backend */
  readonly isBest?: boolean
}

interface PipelineRuntimeSelectorProps {
  readonly options: readonly PipelineRuntimeOption[]
  readonly value: string
  readonly onChange: (value: string) => void
}

export function PipelineRuntimeSelector({
  options,
  value,
  onChange,
}: PipelineRuntimeSelectorProps): JSX.Element {
  const t = useUiText()
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const active = opt.id === value
        return (
          <button
            key={opt.id}
            onClick={() => opt.available && onChange(opt.id)}
            disabled={!opt.available}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-all ${
              active
                ? 'border-primary/40 bg-primary/10 text-primary'
                : opt.available
                  ? 'border-border bg-surface text-foreground-subtle hover:bg-surface-hover hover:text-foreground'
                  : 'border-border/40 bg-surface/40 text-foreground-subtle/40 cursor-not-allowed'
            }`}
          >
            <Cpu className="h-3.5 w-3.5 shrink-0" />
            {opt.label}
            {opt.isBest && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400">
                <Star className="h-2.5 w-2.5" />
                {t('uiLibrary.pipelineRuntimeSelector.best', 'Best')}
              </span>
            )}
            {opt.platformScore != null && (
              <span className="text-[10px] text-foreground-subtle/60">({opt.platformScore})</span>
            )}
            <span
              className={`h-1.5 w-1.5 rounded-full ${opt.available ? 'bg-success' : 'bg-danger'}`}
            />
          </button>
        )
      })}
    </div>
  )
}

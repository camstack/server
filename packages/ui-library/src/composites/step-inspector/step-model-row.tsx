/**
 * StepModelRow — the model ONE accelerator runs for a step, where that answer
 * comes from (this camera / the node / the hardware default), and a picker
 * that opens in place. A model is per accelerator by nature: formats differ.
 */
import { type ReactNode, type JSX } from 'react'
import type { PipelineAddonSchema } from '@camstack/types'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import { BTN_COMPACT, LIST_ROW } from '../../lib/responsive'
import { ModelPicker } from '../model-picker'

/** Where the row's model is decided. */
export type ModelRowSource = 'camera' | 'node' | 'default' | 'cluster'

export interface StepModelRowProps {
  readonly label: string
  readonly format: string
  /** The model this accelerator runs (`undefined` = nothing runs here). */
  readonly modelId: string | undefined
  readonly source: ModelRowSource
  readonly sourceLabel: string
  readonly models: PipelineAddonSchema['models']
  readonly defaultModelId?: string
  readonly expanded: boolean
  readonly onToggle: () => void
  readonly onChangeModel: (modelId: string) => void
  /** Present only when the edited layer pins a model here. */
  readonly onReset?: () => void
  readonly resetLabel?: string
  /** Why the step does not run its own model here (no build, root-supplied, jump). */
  readonly note?: ReactNode
  /** Extra control shown with the picker ("Run on"). */
  readonly extra?: ReactNode
  readonly changed?: boolean
  readonly disabled?: boolean
}

const SOURCE_TONE: Record<ModelRowSource, string> = {
  camera: 'border-primary/40 bg-primary/10 text-primary',
  node: 'border-border bg-muted/40 text-foreground',
  default: 'border-border/60 text-foreground-subtle',
  cluster: 'border-primary/40 bg-primary/5 text-primary',
}

export function StepModelRow({
  label,
  format,
  modelId,
  source,
  sourceLabel,
  models,
  defaultModelId,
  expanded,
  onToggle,
  onChangeModel,
  onReset,
  resetLabel,
  note,
  extra,
  changed = false,
  disabled = false,
}: StepModelRowProps): JSX.Element {
  const t = useUiText()
  const pickable = models.length > 0 && note === undefined
  const canExpand = pickable || extra !== undefined
  return (
    <div className={cn('rounded-md border border-border', expanded && 'bg-muted/10')}>
      <div className={cn(LIST_ROW, 'space-y-1')}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="font-medium text-foreground">{label}</span>
          <span className="text-[10px] text-foreground-subtle">{format}</span>
          <span
            className={cn(
              'ml-auto rounded border px-1.5 py-px text-[10px] font-medium',
              SOURCE_TONE[source],
            )}
          >
            {sourceLabel}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
            {modelId ?? '—'}
            {changed && <span className="ml-1 text-amber-500">•</span>}
          </span>
          {onReset !== undefined && (
            <button type="button" className={BTN_COMPACT} disabled={disabled} onClick={onReset}>
              {resetLabel ?? t('uiLibrary.stepModelRow.reset', 'Reset')}
            </button>
          )}
          {canExpand && (
            <button
              type="button"
              className={cn(BTN_COMPACT, 'min-h-9 md:min-h-0')}
              aria-expanded={expanded}
              aria-label={t('uiLibrary.stepModelRow.changeModelFor', 'Change model for {{label}}', {
                label,
              })}
              disabled={disabled}
              onClick={onToggle}
            >
              {expanded
                ? t('uiLibrary.stepModelRow.done', 'Done')
                : pickable
                  ? t('uiLibrary.stepModelRow.change', 'Change')
                  : t('uiLibrary.stepModelRow.route', 'Route')}
            </button>
          )}
        </div>
      </div>
      {note !== undefined && (
        <div className="border-t border-border/60 px-3 py-1.5 text-[10px] leading-snug text-foreground-subtle">
          {note}
        </div>
      )}
      {expanded && canExpand && (
        <div className="space-y-3 border-t border-border/60 px-3 py-3">
          {pickable && (
            <ModelPicker
              models={models}
              value={modelId ?? ''}
              defaultModelId={defaultModelId}
              disabled={disabled}
              onChange={onChangeModel}
            />
          )}
          {extra}
        </div>
      )}
    </div>
  )
}

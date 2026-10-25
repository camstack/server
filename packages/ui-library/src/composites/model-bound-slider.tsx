/**
 * The editor of a MODEL-BOUND numeric step setting (D738) — the per-class
 * confidence floors.
 *
 * Its default belongs to the model that runs (`modelApplicability.defaultByModel`,
 * else the field's global `default`), and an operator value is stored together
 * with the model it was made for (`<key>ModelId`). This control therefore:
 *
 *   - shows the value IN FORCE for the selected model — an override made for
 *     another model is not that value, and is named as inapplicable;
 *   - says where the value comes from (override / model default / untuned
 *     global default);
 *   - writes every change bound to the selected model;
 *   - offers "Reset to model default", which removes the override and its
 *     binding.
 *
 * The rule itself is `resolveModelBoundSetting` in `@camstack/types` — the same
 * one the runner applies — never re-derived here.
 */
import type { ConfigField, ConfigNumberField, ConfigSliderField } from '@camstack/types'
import { useUiText, type UiTextFn } from '../contexts/ui-text'
import type { JSX } from 'react'
import {
  clearModelBoundOverrides,
  clearModelBoundSetting,
  hasModelBoundOverrides,
  resolveModelBoundSetting,
  writeModelBoundSetting,
} from '@camstack/types'

/** A numeric field this control can render. */
export type ModelBoundNumericField = ConfigSliderField | ConfigNumberField

export interface ModelBoundSliderProps {
  readonly field: ModelBoundNumericField
  /** The model the edited row runs — pinned, or its effective default. */
  readonly modelId: string
  readonly settings: Readonly<Record<string, unknown>> | undefined
  readonly disabled: boolean
  readonly onChangeSettings: (next: Record<string, unknown>) => void
  /**
   * Hide the source label + "Reset to model default" row. A layered editor
   * (the step inspector, D754) draws its own provenance line naming every
   * layer — this row could only name the model's, and its reset would remove
   * the value from the merged view, not from the layer being edited.
   */
  readonly hideSourceRow?: boolean
}

type ModelBoundSource = 'override' | 'model-default' | 'global-default'

function sourceLabel(source: ModelBoundSource, t: UiTextFn): string {
  switch (source) {
    case 'override':
      return t('uiLibrary.modelBoundSlider.sourceOverride', 'Override for this model')
    case 'model-default':
      return t('uiLibrary.modelBoundSlider.sourceModelDefault', 'Model default')
    case 'global-default':
      return t(
        'uiLibrary.modelBoundSlider.sourceGlobalDefault',
        'Default — not tuned for this model',
      )
  }
}

function formatNumber(value: number, scale: number | undefined): string {
  const display = scale !== undefined ? value / scale : value
  return display.toFixed(2).replace(/\.?0+$/, '')
}

export function ModelBoundSlider({
  field,
  modelId,
  settings,
  disabled,
  onChangeSettings,
  hideSourceRow = false,
}: ModelBoundSliderProps): JSX.Element | null {
  const t = useUiText()
  const modelDefault = field.modelApplicability?.defaultByModel?.[modelId]
  const state = resolveModelBoundSetting(
    settings,
    field.key,
    modelId.length > 0 ? modelId : undefined,
    modelDefault,
    field.default,
  )
  const fallback = typeof field.default === 'number' ? field.default : (field.min ?? 0)
  const current = typeof state.value === 'number' ? state.value : fallback
  const scale = field.type === 'slider' ? field.displayScale : undefined
  const unit = 'unit' in field ? field.unit : undefined
  const stale = state.inapplicableOverride
  const hasStoredValue = settings?.[field.key] !== undefined

  const handleChange = (value: number): void => {
    // No model known (an editor without one) ⇒ an unbound value, which the
    // runner applies to whatever runs — the pre-D738 behaviour.
    onChangeSettings(
      modelId.length > 0
        ? writeModelBoundSetting(settings, field.key, value, modelId)
        : { ...settings, [field.key]: value },
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] font-medium text-foreground-subtle uppercase tracking-wide">
          {field.label}
        </span>
        <span className="text-xs font-medium text-foreground tabular-nums">
          {formatNumber(current, scale)}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      {field.description && (
        <p className="text-[10px] text-foreground-subtle/60 mb-1.5">{field.description}</p>
      )}
      <input
        type="range"
        min={field.min ?? 0}
        max={field.max ?? 1}
        step={field.step ?? 0.01}
        value={current}
        disabled={disabled || field.disabled}
        onChange={(e) => handleChange(Number(e.target.value))}
        className="w-full accent-primary h-1.5"
      />
      {!hideSourceRow && (
        <div className="mt-1 flex items-center justify-between gap-2 text-[10px]">
          <span
            data-testid="model-bound-source"
            className={
              state.source === 'override' ? 'text-primary font-medium' : 'text-foreground-subtle'
            }
          >
            {sourceLabel(state.source, t)}
          </span>
          {hasStoredValue && (
            <button
              type="button"
              disabled={disabled}
              className="text-foreground-subtle hover:text-foreground disabled:opacity-50"
              onClick={() => onChangeSettings(clearModelBoundSetting(settings, field.key))}
            >
              {t('uiLibrary.modelBoundSlider.resetToDefault', 'Reset to model default')}
            </button>
          )}
        </div>
      )}
      {stale !== undefined && typeof stale.value === 'number' && (
        <p className="mt-1 text-[10px] text-amber-400/90">
          {t(
            'uiLibrary.modelBoundSlider.staleOverride',
            'The override {{value}} was set for {{modelId}} and does not apply to this model.',
            { value: formatNumber(stale.value, scale), modelId: stale.modelId },
          )}
        </p>
      )}
    </div>
  )
}

/** The keys of the model-bound fields of a schema, groups flattened. */
export function modelBoundKeysOf(fields: readonly ConfigField[]): string[] {
  return fields.flatMap((field): string[] => {
    if (field.type === 'group') return modelBoundKeysOf(field.fields)
    return 'key' in field && 'bindsToModel' in field && field.bindsToModel === true
      ? [field.key]
      : []
  })
}

export interface ResetModelDefaultsButtonProps {
  readonly fields: readonly ConfigField[]
  /** The model the edited row runs — pinned, or its effective default. */
  readonly modelId: string
  readonly settings: Readonly<Record<string, unknown>> | undefined
  readonly disabled?: boolean
  readonly onReset: (next: Record<string, unknown>) => void
}

/**
 * "Reset thresholds to model defaults" — every model-bound override in force
 * for `modelId`, cleared in ONE settings change (one save). Rendered only when
 * there is something to reset. An override stored for another model is kept.
 */
export function ResetModelDefaultsButton({
  fields,
  modelId,
  settings,
  disabled,
  onReset,
}: ResetModelDefaultsButtonProps): JSX.Element | null {
  const t = useUiText()
  const keys = modelBoundKeysOf(fields)
  const model = modelId.length > 0 ? modelId : undefined
  if (keys.length === 0 || !hasModelBoundOverrides(settings, keys, model)) return null
  return (
    <button
      type="button"
      disabled={disabled}
      className="text-[10px] text-primary hover:underline disabled:opacity-50"
      onClick={() => onReset(clearModelBoundOverrides(settings, keys, model))}
    >
      {t('uiLibrary.modelBoundSlider.resetThresholds', 'Reset thresholds to model defaults')}
    </button>
  )
}

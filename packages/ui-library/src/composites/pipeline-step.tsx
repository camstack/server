/**
 * PipelineStep — single step card in the pipeline builder.
 *
 * Driven entirely by PipelineAddonSchema. No hardcoded addon names or models.
 * Renders: colored left border, header with I/O class tags, expandable config
 * (Model → Confidence), children recursively.
 */
import { useState, type JSX } from 'react'
import type { PipelineSlot, PipelineAddonSchema, ConfigField, ConfigOption } from '@camstack/types'
import { cn } from '../lib/cn'
import { useUiText } from '../contexts/ui-text'
import { CollapsibleCard } from '../primitives/collapsible-card'
import { EventKindGlyph } from './event-kind-visuals'
import { ModelPicker } from './model-picker'
import { ModelBoundSlider } from './model-bound-slider'

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

// Phase 7 (settings redesign): the generic `confidence: number` field was
// removed. Each step now declares its own threshold (if any) via its
// `configSchema`, surfaced through the dynamic `ConfigSchemaField`
// renderer below. Steps that don't need a user-tunable threshold use the
// hardcoded `StepDefinition.defaultConfidence` read by the runtime
// executor directly.
export interface PipelineStepDisplayConfig {
  readonly addonId: string
  readonly addonName: string
  readonly slot: PipelineSlot
  readonly inputClasses: readonly string[]
  readonly outputClasses: readonly string[]
  readonly enabled: boolean
  readonly modelId: string
  readonly children: readonly PipelineStepDisplayConfig[]
  /** UI grouping — steps with the same group are displayed under one heading */
  readonly group?: string
  /** Current values for the step's configSchema fields */
  readonly settings?: Record<string, unknown>
}

export interface PipelineStepProps {
  readonly step: PipelineStepDisplayConfig
  readonly schema: PipelineAddonSchema | null
  /** Full schema map so children can look up their own schema */
  readonly allSchemas: ReadonlyMap<string, PipelineAddonSchema>
  readonly depth?: number
  readonly onChange: (updated: PipelineStepDisplayConfig) => void
  readonly onDelete?: (addonId: string) => void
  readonly readOnly?: boolean
}

// ---------------------------------------------------------------------------
// Helpers — compute available models for a specific step
// ---------------------------------------------------------------------------

// Return the FULL model options (id + name + `group` + `formats`) so the shared
// `ModelPicker` can render the grouped Family→Tier→Variant selector — the flat
// `{id,name}` projection was what forced the legacy flat `<select>`.
function modelsForStep(schema: PipelineAddonSchema | null): PipelineAddonSchema['models'] {
  return schema?.models ?? []
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PipelineStep({
  step,
  schema,
  allSchemas: _allSchemas,
  depth: _depth = 0,
  onChange,
  onDelete: _onDelete,
  readOnly = false,
}: PipelineStepProps): JSX.Element | null {
  const t = useUiText()
  const [expanded, setExpanded] = useState(false)

  const models = modelsForStep(schema)

  // Auto-correct: if the selected model is not in the list, switch to default or first.
  if (models.length > 0 && !models.some((m) => m.id === step.modelId) && !readOnly) {
    const defaultModel = schema?.defaultModelId
      ? models.find((m) => m.id === schema.defaultModelId)
      : null
    const fallback = defaultModel ?? models[0]
    if (fallback && fallback.id !== step.modelId) {
      queueMicrotask(() => onChange({ ...step, modelId: fallback.id }))
    }
  }

  const header = (
    <>
      <div className="flex-1 min-w-0">
        <span className="text-[10px] uppercase tracking-wider font-medium text-foreground-subtle/60 block leading-none">
          {step.slot}
        </span>
        <span className="text-sm font-semibold text-foreground truncate block leading-tight">
          {step.addonName}
        </span>
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          {step.inputClasses.map((c) => (
            <span
              key={c}
              className="text-[9px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-blue-500/12 text-blue-400"
            >
              {c}
            </span>
          ))}
          {step.inputClasses.length > 0 && step.outputClasses.length > 0 && (
            <span className="text-foreground-subtle/40 text-[10px]">→</span>
          )}
          {step.outputClasses.map((c) => (
            <span
              key={c}
              className="text-[9px] uppercase font-semibold tracking-wide px-1.5 py-0.5 rounded bg-green-500/12 text-green-400"
            >
              {c}
            </span>
          ))}
        </div>
      </div>

      {!readOnly && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onChange({ ...step, enabled: !step.enabled })
          }}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
            step.enabled ? 'bg-success' : 'bg-foreground-subtle/30',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
              step.enabled ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      )}
    </>
  )

  return (
    <CollapsibleCard
      expanded={expanded}
      onExpandedChange={setExpanded}
      dimmed={!step.enabled}
      header={header}
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <label className="block text-[10px] font-medium text-foreground-subtle uppercase tracking-wide">
            {t('uiLibrary.pipelineStep.model', 'Model')}
          </label>
          <ModelPicker
            models={models}
            value={step.modelId}
            disabled={readOnly}
            onChange={(id) => onChange({ ...step, modelId: id })}
          />
        </div>

        {/* ── Dynamic configSchema fields ─────────────────────── */}
        {schema?.configSchema?.map((field) => (
          <ConfigSchemaField
            key={field.key}
            field={field}
            allFields={schema.configSchema ?? []}
            step={step}
            disabled={readOnly}
            onChange={onChange}
          />
        ))}
      </div>
    </CollapsibleCard>
  )
}

// ---------------------------------------------------------------------------
// Small config select — reusable for Model and other dropdowns
// ---------------------------------------------------------------------------

function ConfigSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: string
  options: readonly { value: string; label: string; disabled?: boolean }[]
  disabled?: boolean
  onChange: (value: string) => void
}) {
  const t = useUiText()
  return (
    <div>
      <label className="block text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-1.5">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary/50"
      >
        {options.length === 0 && (
          <option value={value}>{value || t('uiLibrary.pipelineStep.default', 'default')}</option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ConfigMultiSelect — chip-style toggle for multiselect fields
// ---------------------------------------------------------------------------

function ConfigMultiSelect({
  label,
  description,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  description?: string
  value: readonly string[]
  options: readonly ConfigOption[]
  disabled?: boolean
  onChange: (selected: string[]) => void
}) {
  function toggle(opt: string) {
    if (disabled) return
    const next = value.includes(opt) ? value.filter((v) => v !== opt) : [...value, opt]
    onChange(next)
  }

  return (
    <div>
      <label className="block text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-1">
        {label}
      </label>
      {description && <p className="text-[10px] text-foreground-subtle/60 mb-1.5">{description}</p>}
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const selected = value.includes(o.value)
          return (
            <button
              key={o.value}
              type="button"
              disabled={disabled}
              onClick={() => toggle(o.value)}
              className={cn(
                'inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md border transition-colors',
                selected
                  ? 'bg-primary/20 text-primary border-primary/40'
                  : 'bg-surface text-foreground-subtle border-border hover:border-primary/30',
                disabled && 'opacity-50 cursor-not-allowed',
              )}
            >
              {/* The SHARED glyph for the class, when the option names one —
                  the same icon the timeline, the events tree and the viewer
                  draw. Options with no `iconId` render as plain text. */}
              {o.iconId !== undefined && <EventKindGlyph iconId={o.iconId} size={12} />}
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ConfigSchemaField — resolves a single ConfigField to the right control
// ---------------------------------------------------------------------------

function resolveSettingValue(
  key: string,
  step: PipelineStepDisplayConfig,
  allFields: readonly ConfigField[],
): unknown {
  const explicit = step.settings?.[key]
  if (explicit !== undefined) return explicit
  const sibling = allFields.find((f) => 'key' in f && f.key === key)
  return sibling && 'default' in sibling ? sibling.default : undefined
}

export function ConfigSchemaField({
  field,
  allFields,
  step,
  disabled,
  onChange,
  hideModelBoundSourceRow,
}: {
  field: ConfigField
  allFields: readonly ConfigField[]
  step: PipelineStepDisplayConfig
  disabled: boolean
  onChange: (updated: PipelineStepDisplayConfig) => void
  /** A layered editor draws its own provenance (D754) — see `ModelBoundSlider.hideSourceRow`. */
  hideModelBoundSourceRow?: boolean
}): JSX.Element | null {
  const t = useUiText()
  // D214 — per-model applicability: a knob that has no effect with the
  // step's SELECTED model renders disabled WITH its reason (never a live
  // control that silently does nothing), and a labelmap-derived multiselect
  // offers the model's own labels.
  const applicability = 'modelApplicability' in field ? field.modelApplicability : undefined
  const inapplicableReason = applicability?.inapplicable?.[step.modelId]
  const control = (
    <ConfigSchemaFieldControl
      field={field}
      allFields={allFields}
      step={step}
      disabled={disabled || inapplicableReason !== undefined}
      modelScopedOptions={applicability?.optionsByModel?.[step.modelId]}
      onChange={onChange}
      hideModelBoundSourceRow={hideModelBoundSourceRow === true}
    />
  )
  if (inapplicableReason === undefined) return control
  return (
    <div className="space-y-1">
      {control}
      <div className="text-[10px] text-amber-400/90">
        {t('uiLibrary.pipelineStep.noEffect', 'No effect with the selected model — {{reason}}', {
          reason: inapplicableReason,
        })}
      </div>
    </div>
  )
}

function ConfigSchemaFieldControl({
  field,
  allFields,
  step,
  disabled,
  modelScopedOptions,
  onChange,
  hideModelBoundSourceRow,
}: {
  field: ConfigField
  allFields: readonly ConfigField[]
  step: PipelineStepDisplayConfig
  disabled: boolean
  modelScopedOptions?: readonly import('@camstack/types').ConfigOption[]
  onChange: (updated: PipelineStepDisplayConfig) => void
  hideModelBoundSourceRow: boolean
}) {
  // Evaluate showWhen condition — resolve value with default fallback
  const showWhen =
    field.type !== 'separator' && field.type !== 'info'
      ? (field as { showWhen?: import('@camstack/types').ConfigCondition }).showWhen
      : undefined
  if (showWhen) {
    const { field: condField, equals, notEquals, in: inList, notIn } = showWhen
    const current = resolveSettingValue(condField, step, allFields)
    if (equals !== undefined && current !== equals) return null
    if (notEquals !== undefined && current === notEquals) return null
    if (inList !== undefined && !inList.includes(current)) return null
    if (notIn !== undefined && notIn.includes(current)) return null
  }

  function handleChange(newValue: unknown) {
    onChange({
      ...step,
      settings: { ...step.settings, [field.key]: newValue },
    })
  }

  if (field.type === 'select') {
    const raw = step.settings?.[field.key]
    const current = typeof raw === 'string' ? raw : ((field.default as string | undefined) ?? '')
    return (
      <ConfigSelect
        label={field.label}
        value={current}
        disabled={disabled || field.disabled}
        options={modelScopedOptions ?? field.options}
        onChange={handleChange}
      />
    )
  }

  if (field.type === 'multiselect') {
    const raw = step.settings?.[field.key]
    const current: readonly string[] = Array.isArray(raw)
      ? (raw as string[])
      : Array.isArray(field.default)
        ? (field.default as string[])
        : []
    return (
      <ConfigMultiSelect
        label={field.label}
        description={field.description}
        value={current}
        options={modelScopedOptions ?? field.options}
        disabled={disabled || field.disabled}
        onChange={handleChange}
      />
    )
  }

  // D738 — a field whose default belongs to the model (the per-class floors):
  // shown as the value in force for the selected model, written bound to it.
  if ((field.type === 'slider' || field.type === 'number') && field.bindsToModel === true) {
    return (
      <ModelBoundSlider
        field={field}
        modelId={step.modelId}
        settings={step.settings}
        disabled={disabled}
        onChangeSettings={(settings) => onChange({ ...step, settings })}
        hideSourceRow={hideModelBoundSourceRow}
      />
    )
  }

  if (field.type === 'slider' || field.type === 'number') {
    const raw = step.settings?.[field.key]
    const fallback = typeof field.default === 'number' ? field.default : (field.min ?? 0)
    const current = typeof raw === 'number' ? raw : fallback
    const min = field.min ?? 0
    const max = field.max ?? 1
    const step_ = field.step ?? 0.01
    const showValue = field.type === 'slider' ? field.showValue : true
    const unit = 'unit' in field ? field.unit : undefined
    const displayScale = field.type === 'slider' ? field.displayScale : undefined
    const display = displayScale ? current / displayScale : current
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-medium text-foreground-subtle uppercase tracking-wide">
            {field.label}
          </span>
          {showValue && (
            <span className="text-xs font-medium text-foreground tabular-nums">
              {typeof display === 'number' ? display.toFixed(2).replace(/\.?0+$/, '') : display}
              {unit ? ` ${unit}` : ''}
            </span>
          )}
        </div>
        {field.description && (
          <p className="text-[10px] text-foreground-subtle/60 mb-1.5">{field.description}</p>
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step_}
          value={current}
          disabled={disabled || field.disabled}
          onChange={(e) => handleChange(Number(e.target.value))}
          className="w-full accent-primary h-1.5"
        />
      </div>
    )
  }

  if (field.type === 'boolean') {
    const raw = step.settings?.[field.key]
    const current = typeof raw === 'boolean' ? raw : field.default === true
    return (
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={current}
          disabled={disabled || field.disabled}
          onChange={(e) => handleChange(e.target.checked)}
          className="h-3.5 w-3.5 accent-primary"
        />
        <span className="text-[10px] font-medium text-foreground-subtle uppercase tracking-wide">
          {field.label}
        </span>
      </label>
    )
  }

  if (field.type === 'text' || field.type === 'password' || field.type === 'textarea') {
    const raw = step.settings?.[field.key]
    const current = typeof raw === 'string' ? raw : ((field.default as string | undefined) ?? '')
    const inputType = field.type === 'password' ? 'password' : 'text'
    return (
      <div>
        <label className="block text-[10px] font-medium text-foreground-subtle uppercase tracking-wide mb-1.5">
          {field.label}
        </label>
        {field.type === 'textarea' ? (
          <textarea
            value={current}
            disabled={disabled || field.disabled}
            placeholder={field.placeholder}
            onChange={(e) => handleChange(e.target.value)}
            rows={3}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary/50 resize-y"
          />
        ) : (
          <input
            type={inputType}
            value={current}
            disabled={disabled || field.disabled}
            placeholder={field.placeholder}
            onChange={(e) => handleChange(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary/50"
          />
        )}
      </div>
    )
  }

  if (field.type === 'separator') {
    return <div className="border-t border-border my-2" />
  }

  if (field.type === 'info') {
    return (
      <div className="rounded-md border border-border bg-surface px-2 py-1.5 text-[10px] text-foreground-subtle">
        {field.content}
      </div>
    )
  }

  // Unsupported field type — render nothing rather than crash.
  // This branch should be unreachable for the field kinds used by pipeline
  // steps; if a new kind is introduced, add a case above.
  return null
}

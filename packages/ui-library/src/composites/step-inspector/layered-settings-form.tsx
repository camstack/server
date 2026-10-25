/**
 * LayeredSettingsForm — a detection step's settings, edited on ONE layer
 * (D754, D927): the node base or the camera (every accelerator).
 *
 * Every field shows the value that runs on the viewed accelerator, which layer
 * supplies it, the values of the other levels (so "node vs camera" is read, not
 * clicked for), and a reset that removes the field from the edited layer only.
 * A change writes the touched field alone — a model-bound field (D738) as its
 * value + binding pair — so the edited layer stays field-level and never
 * freezes the levels below it.
 */
import { useUiText } from '../../contexts/ui-text'
import { type ReactNode, type JSX } from 'react'
import {
  collectModelBoundKeys,
  type ConfigField,
  effectiveStepSettings,
  type PipelineAddonSchema,
  resolveModelBoundSetting,
  type StepSettingSource,
  type StepSettingsLayers,
  stepSettingSource,
  modelBindingKey,
  USE_ROOT_MODEL_SETTING_KEY,
  withFieldFrom,
  withoutField,
} from '@camstack/types'
import { cn } from '../../lib/cn'
import { TEXT_HINT, TEXT_SECTION_LABEL } from '../../lib/responsive'
import { ResetModelDefaultsButton } from '../model-bound-slider'
import { ConfigSchemaField, type PipelineStepDisplayConfig } from '../pipeline-step'
import {
  type RootModelInfo,
  RootModelSourceControl,
  rootSourceState,
  withUseRootModel,
} from '../root-model-source'
import {
  bindsToModel,
  defaultOfField,
  formatSettingValue,
  isValueField,
  type ValueField,
  withoutModelScopedFields,
} from './setting-values'

/** The layer an inspector edits. */
export type SettingsTarget = Exclude<StepSettingSource, 'default'>

/** How each stored layer is named on screen. A layer without a label is not shown. */
export interface LayerLabels {
  readonly camera?: string
  readonly node: string
}

export interface LayeredSettingsFormProps {
  readonly addon: PipelineAddonSchema
  /** The step's node-local fields (cluster-owned knobs already removed). */
  readonly fields: readonly ConfigField[]
  /** The stored layers as they apply on the viewed accelerator. */
  readonly layers: StepSettingsLayers
  readonly target: SettingsTarget
  readonly labels: LayerLabels
  /** The model a model-bound value is judged against and bound to (D738/D741). */
  readonly modelId: string
  /** The edited layer's next bag. */
  readonly onChangeLayer: (next: Record<string, unknown>) => void
  /** The root model of the viewed accelerator — offers "Use the root model" (D730). */
  readonly rootModel?: RootModelInfo
  /** Fields the edited layer stores at exactly the value below it (a legacy full copy). */
  readonly pinnedKeys?: readonly string[]
  /** An extra control under one field. */
  readonly fieldActions?: (key: string, source: StepSettingSource) => ReactNode
  /** Controls on the section header ("Follow the node", a scope switch). */
  readonly headerActions?: ReactNode
  /** A field to bring into view and highlight (a search hit). */
  readonly highlightKey?: string | null
  readonly disabled?: boolean
}

const SOURCE_TONE: Record<StepSettingSource, string> = {
  camera: 'border-primary/40 bg-primary/10 text-primary',
  node: 'border-border bg-muted/40 text-foreground',
  default: 'border-border/60 text-foreground-subtle',
}

/** DOM id of a field's box — the target of a search hit. */
export function stepFieldDomId(key: string): string {
  return `step-field-${key}`
}

function displayStep(
  addon: PipelineAddonSchema,
  modelId: string,
  settings: Readonly<Record<string, unknown>>,
): PipelineStepDisplayConfig {
  return {
    addonId: addon.id,
    addonName: addon.name,
    slot: addon.slot,
    inputClasses: [...addon.inputClasses],
    outputClasses: [...addon.outputClasses],
    enabled: true,
    modelId,
    children: [],
    settings: { ...settings },
  }
}

const LAYER_IDS: readonly SettingsTarget[] = ['camera', 'node']

interface ProvenanceProps {
  readonly field: ValueField
  readonly layers: StepSettingsLayers
  readonly target: SettingsTarget
  readonly labels: LayerLabels
  readonly boundKeys: readonly string[]
  readonly modelId: string
  readonly pinned: boolean
  readonly disabled: boolean
  readonly onReset: () => void
  readonly action: ReactNode
}

/** "Camera · node 0.65 · model default 0.78 · [Reset to node]" under one field. */
function SettingProvenance({
  field,
  layers,
  target,
  labels,
  boundKeys,
  modelId,
  pinned,
  disabled,
  onReset,
  action,
}: ProvenanceProps) {
  const t = useUiText()
  const effective = effectiveStepSettings(layers)
  const fallback = defaultOfField(field, modelId)
  const defaultLabel = fallback.fromModel
    ? t('uiLibrary.layeredSettings.modelDefault', 'model default')
    : t('uiLibrary.layeredSettings.default', 'default')
  const stored = stepSettingSource(layers, field.key, boundKeys)
  // A model-bound value stored for ANOTHER model is not what runs (D738): the
  // running model's default is, whatever layer the stale value sits in.
  const bound = bindsToModel(field)
  const state = bound
    ? resolveModelBoundSetting(effective, field.key, modelId, fallback.value, fallback.value)
    : null
  const inForce = state === null || state.source === 'override'
  const source: StepSettingSource = inForce ? stored : 'default'
  const sourceText = source === 'default' ? defaultLabel : (labels[source] ?? source)

  const levels = LAYER_IDS.filter((id) => id !== source && labels[id] !== undefined)
    .filter((id) => layers[id]?.[field.key] !== undefined)
    .map((id) => {
      const binding = bound ? layers[id]?.[modelBindingKey(field.key)] : undefined
      const forOther =
        typeof binding === 'string' && binding !== modelId
          ? t('uiLibrary.layeredSettings.forModel', ' (for {{model}})', { model: binding })
          : ''
      return `${labels[id]} ${formatSettingValue(field, layers[id]?.[field.key])}${forOther}`
    })
  const withDefault =
    source === 'default'
      ? levels
      : [...levels, `${defaultLabel} ${formatSettingValue(field, fallback.value)}`]

  const targetStores =
    stepSettingSource({ [target]: layers[target] }, field.key, boundKeys) !== 'default'
  const below = LAYER_IDS.slice(LAYER_IDS.indexOf(target) + 1).find(
    (id) => labels[id] !== undefined && layers[id]?.[field.key] !== undefined,
  )
  const resetTo = below !== undefined ? (labels[below] ?? below) : defaultLabel
  // A pinned field is pinned in the layer that stores it — compare with what
  // lies under THAT layer.
  const belowSource =
    stored === 'default'
      ? 'default'
      : stepSettingSource({ ...layers, [stored]: undefined }, field.key, boundKeys)
  const pinnedAt = belowSource === 'default' ? defaultLabel : (labels[belowSource] ?? belowSource)

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px]">
      <span
        data-testid="setting-source"
        className={cn('rounded border px-1.5 py-px font-medium', SOURCE_TONE[source])}
      >
        {sourceText}
      </span>
      {withDefault.length > 0 && (
        <span data-testid="setting-levels" className="text-foreground-subtle">
          {withDefault.join(' · ')}
        </span>
      )}
      {pinned && (
        <span
          className="rounded border border-warning/40 px-1.5 py-px text-warning"
          title={t(
            'uiLibrary.layeredSettings.pinnedHint',
            'Stored by an older editor as a copy of the value below. It changes nothing today, but it stops later changes below from reaching this camera.',
          )}
        >
          {t('uiLibrary.layeredSettings.pinned', 'pinned at the {{source}} value', {
            source: pinnedAt.toLowerCase(),
          })}
        </span>
      )}
      <span className="ml-auto flex items-center gap-2">
        {action}
        {targetStores && (
          <button
            type="button"
            disabled={disabled}
            onClick={onReset}
            className="rounded px-1 text-foreground-subtle hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            {t('uiLibrary.layeredSettings.resetTo', 'Reset to {{target}}', {
              target: resetTo.toLowerCase(),
            })}
          </button>
        )}
      </span>
    </div>
  )
}

export function LayeredSettingsForm({
  addon,
  fields: givenFields,
  layers,
  target,
  labels,
  modelId,
  onChangeLayer,
  rootModel,
  pinnedKeys = [],
  fieldActions,
  headerActions,
  highlightKey = null,
  disabled = false,
}: LayeredSettingsFormProps): JSX.Element {
  const t = useUiText()
  // A camera only turns steps on or off (D927): whatever the caller hands in, a
  // model-scoped field is never a camera input.
  const fields = target === 'camera' ? withoutModelScopedFields(givenFields) : givenFields
  const boundKeys = collectModelBoundKeys(fields)
  const effective = effectiveStepSettings(layers)
  const targetLayer = layers[target]
  const step = displayStep(addon, modelId, effective)
  const rootState = rootSourceState(addon.id, effective, rootModel)

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className={TEXT_SECTION_LABEL}>{t('uiLibrary.layeredSettings.title', 'Settings')}</h3>
        <span className={TEXT_HINT}>
          {t('uiLibrary.layeredSettings.editing', 'editing: {{target}}', {
            target: labels[target] ?? target,
          })}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-3">
          {headerActions}
          <ResetModelDefaultsButton
            fields={fields}
            modelId={modelId}
            settings={targetLayer}
            disabled={disabled}
            onReset={(next) => onChangeLayer(next)}
          />
        </span>
      </div>

      {rootState !== null && (
        <RootModelSourceControl
          stepId={addon.id}
          settings={effective}
          rootModel={rootModel}
          disabled={disabled}
          onChange={(v) =>
            onChangeLayer(
              withFieldFrom(
                targetLayer,
                USE_ROOT_MODEL_SETTING_KEY,
                withUseRootModel(effective, v),
                [],
              ),
            )
          }
        />
      )}

      {fields.map((field) => {
        if (!isValueField(field)) {
          return (
            <ConfigSchemaField
              key={field.key}
              field={field}
              allFields={fields}
              step={step}
              disabled={disabled}
              onChange={() => {}}
            />
          )
        }
        const highlighted = highlightKey === field.key
        return (
          <div
            key={field.key}
            id={stepFieldDomId(field.key)}
            data-field-key={field.key}
            className={cn(
              'rounded-md border border-transparent px-2 py-1 -mx-2',
              highlighted && 'border-primary/50 bg-primary/5',
            )}
          >
            <ConfigSchemaField
              field={field}
              allFields={fields}
              step={step}
              disabled={disabled}
              hideModelBoundSourceRow
              onChange={(next) =>
                onChangeLayer(withFieldFrom(targetLayer, field.key, next.settings ?? {}, boundKeys))
              }
            />
            <SettingProvenance
              field={field}
              layers={layers}
              target={target}
              labels={labels}
              boundKeys={boundKeys}
              modelId={modelId}
              pinned={pinnedKeys.includes(field.key)}
              disabled={disabled}
              onReset={() => onChangeLayer(withoutField(targetLayer, field.key, boundKeys))}
              action={fieldActions?.(field.key, stepSettingSource(layers, field.key, boundKeys))}
            />
          </div>
        )
      })}
    </div>
  )
}

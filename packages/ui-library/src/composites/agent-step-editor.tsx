import { useUiText, UiTrans } from '../contexts/ui-text'
import { useMemo, type JSX } from 'react'
import {
  type ConfigField,
  clusterStepSettingFieldsFor,
  type DeviceStepConfig,
  type PipelineAddonSchema,
} from '@camstack/types'
import { ModelPicker } from './model-picker'
import { stepModelOptions } from './resolve-step-default-model'
import { type RootModelInfo, rootSourceState } from './root-model-source'
import { LayeredSettingsForm } from './step-inspector/layered-settings-form'

/**
 * A step's node-local fields: the catalog schema minus the knobs the CLUSTER
 * owns (`clusterStepSettingFieldsFor`). Those still exist on the schema so the
 * runner can hydrate `child.settings`, but writing them per node or per camera
 * would be a second store the overlay silently ignores.
 */
export function stepLocalFields(addon: PipelineAddonSchema): readonly ConfigField[] {
  const clusterKeys = new Set(clusterStepSettingFieldsFor(addon.id).map((field) => field.key))
  return (addon.configSchema ?? []).filter((field) => !clusterKeys.has(field.key))
}

/**
 * The model a step's settings are read and written for — what a model-bound
 * field (D738) binds to. While the ROOT supplies the step's fine label (D741),
 * that is the root model: the step's threshold then gates the root's label, on
 * the root's score scale. Otherwise the step's own model: its pin, else the
 * model the row really runs (`effectiveModelId` — the device's hardware-aware
 * default when unpinned), else the step's flat catalog default.
 */
export function settingsModelIdFor(
  addon: PipelineAddonSchema,
  modelId: string | undefined,
  settings: Readonly<Record<string, unknown>> | undefined,
  rootModel: RootModelInfo | undefined,
): string {
  if (rootModel !== undefined && rootSourceState(addon.id, settings, rootModel)?.effective) {
    return rootModel.modelId
  }
  return modelId ?? addon.defaultModelId
}

function ClusterSettingsHint({ addonId }: { readonly addonId: string }) {
  const t = useUiText()
  if (clusterStepSettingFieldsFor(addonId).length === 0) return null
  return (
    <p className="text-[10px] leading-snug text-foreground-subtle">
      {t(
        'uiLibrary.agentStepEditor.clusterHint',
        'Admission knobs for this step live in Pipeline → Cluster → Settings → Enrichment models. They apply to every camera — a per-device copy would fill the shared index from two policies.',
      )}
    </p>
  )
}

/**
 * Shown in place of the model picker while the root model supplies the step:
 * the step's own model is kept, not changed, for when the root cannot.
 */
export function RootSuppliedModelNote({
  rootModel,
  stepModelId,
}: {
  readonly rootModel: RootModelInfo
  readonly stepModelId: string | undefined
}): JSX.Element | null {
  return (
    <div
      className="rounded bg-primary/10 px-3 py-2 text-[11px] text-foreground-subtle"
      data-testid="root-supplied-model"
    >
      <UiTrans
        uiKey="uiLibrary.agentStepEditor.rootSupplied"
        fallback="<0>Model: {{name}}</0> (the root model). This step's own model{{stepModel}} is kept and runs again whenever the root model cannot supply the step."
        components={[<span key="m" className="font-semibold text-foreground" />]}
        values={{
          name: rootModel.name,
          stepModel: stepModelId !== undefined ? ` (${stepModelId})` : '',
        }}
      />
    </div>
  )
}

export interface AgentStepEditorProps {
  readonly addon: PipelineAddonSchema
  /** The accelerator's step config — the controlled value (D927: the model's own place). */
  readonly agentDefault: DeviceStepConfig
  readonly onChangeAgentConfig?: (next: DeviceStepConfig) => void
  readonly engineFormat: string
  /**
   * The model this step would ACTUALLY run when nothing is explicitly pinned —
   * the tail of the effective-model chain (detector row: device.defaultModelId;
   * else the step's catalog format-default). Used ONLY as the picker's DISPLAY
   * seed so an un-pinned row pre-selects the model it runs — it is NEVER
   * written into the draft, so opening + saving an un-pinned row still leaves
   * it inheriting.
   */
  readonly effectiveModelId?: string
  /**
   * The ROOT detection model this accelerator runs (D730). When it can supply
   * the edited step, the editor offers "Use the root model"; absent ⇒ no offer.
   */
  readonly rootModel?: RootModelInfo
}

/**
 * AgentStepEditor — one step on ONE accelerator: its model and its settings,
 * as a single node-level layer. Model Studio's "settings for this installed
 * model" dialog uses it. The pipeline pages use the step matrix's panel, which lays
 * the same parts out across accelerators and layers (D754/D757); the settings
 * form here is that panel's `LayeredSettingsForm` with one layer.
 */
export function AgentStepEditor({
  addon,
  agentDefault,
  onChangeAgentConfig,
  engineFormat,
  effectiveModelId,
  rootModel,
}: AgentStepEditorProps): JSX.Element | null {
  const t = useUiText()
  // The OPTIONS come from the shared primitive — the same derivation the
  // matrix uses to decide whether an accelerator can run the step at all.
  const modelsForFormat = useMemo(
    () => stepModelOptions(addon.models, engineFormat),
    [addon.models, engineFormat],
  )
  const update = (patch: Partial<DeviceStepConfig>): void => {
    onChangeAgentConfig?.({ ...agentDefault, ...patch })
  }
  const fields = stepLocalFields(addon)
  const formatDefault = addon.defaultModelIdByFormat?.[engineFormat] ?? addon.defaultModelId
  const settings = agentDefault.settings ?? {}
  const rootSupplied = rootSourceState(addon.id, settings, rootModel)?.effective === true
  const runningModel = agentDefault.modelId ?? effectiveModelId
  return (
    <div className="space-y-4 text-xs">
      {rootSupplied && rootModel !== undefined ? (
        <RootSuppliedModelNote rootModel={rootModel} stepModelId={runningModel} />
      ) : (
        <div>
          <div className="text-[10px] uppercase tracking-widest text-foreground-subtle mb-1">
            {t('uiLibrary.agentStepEditor.model', 'Model')}
          </div>
          <ModelPicker
            models={modelsForFormat}
            value={runningModel ?? ''}
            defaultModelId={formatDefault}
            onChange={(modelId) => update({ modelId })}
          />
        </div>
      )}

      {(fields.length > 0 || rootSourceState(addon.id, settings, rootModel)) && (
        <div className="pt-2 border-t border-border/50">
          <LayeredSettingsForm
            addon={addon}
            fields={fields}
            layers={{ node: settings }}
            target="node"
            labels={{ node: 'This node' }}
            modelId={settingsModelIdFor(addon, runningModel, settings, rootModel)}
            {...(rootModel !== undefined ? { rootModel } : {})}
            onChangeLayer={(settings) => update({ settings })}
          />
        </div>
      )}
      <ClusterSettingsHint addonId={addon.id} />
    </div>
  )
}

/**
 * Provider-drawn parts of the profile editor, by GENERIC widget id (D893).
 *
 * A kind descriptor names a widget (`providerWidgets: [{ id, placement }]`)
 * when a field cannot be a `ConfigUISchema` field — a node picker that reads
 * each node's Apple state, a model source that resolves and installs a
 * Hugging Face file. The editor looks the id up HERE and never branches on a
 * kind: a descriptor naming an id this build does not know renders a notice,
 * not a guess.
 *
 * Every widget gets the same props: the draft `providerConfig` (read and
 * replace) and the model selection (read and replace — a `model` placement
 * owns the model choice).
 */
import type { LlmProfileKindDescriptor } from '@camstack/types'
import { ManagedModelRefSchema } from '@camstack/types'
import type { ComponentType } from 'react'
import { AiModelPicker, type ModelChoice } from './AiModelPicker'
import { AppleNodePicker } from './AppleNodePicker'

export interface ModelSelection {
  readonly id: string
  readonly supportsVision: boolean
}

export interface ProviderWidgetProps {
  readonly descriptor: LlmProfileKindDescriptor
  readonly providerConfig: Record<string, unknown>
  readonly onProviderConfigChange: (next: Record<string, unknown>) => void
  readonly model: ModelSelection
  readonly onModelChange: (next: ModelSelection) => void
}

function stringField(config: Record<string, unknown>, key: string): string | null {
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** `ai/apple-node` — the Mac an Apple Foundation Models profile runs on. */
function AppleNodeWidget({ providerConfig, onProviderConfigChange }: ProviderWidgetProps) {
  return (
    <AppleNodePicker
      value={stringField(providerConfig, 'nodeId')}
      onChange={(nodeId) => onProviderConfigChange({ ...providerConfig, nodeId })}
    />
  )
}

/**
 * `ai/managed-model` — which GGUF a managed llama.cpp runtime loads: the
 * curated catalogue, a file already on the node, or a Hugging Face reference
 * resolved and installed in place. Writes the pinned `ManagedModelRef` into
 * `providerConfig.model` and the display id + vision into the selection.
 */
function ManagedModelWidget({
  providerConfig,
  onProviderConfigChange,
  model,
  onModelChange,
}: ProviderWidgetProps) {
  const ref = ManagedModelRefSchema.safeParse(providerConfig.model)
  // The stored ref is the source of truth on edit, so reopening a profile that
  // runs a custom Hugging Face model shows THAT model rather than an empty
  // picker that silently rewrites it to nothing on save.
  const value: ModelChoice | null = ref.success
    ? { model: ref.data, modelId: model.id, supportsVision: model.supportsVision }
    : null
  const onChange = (choice: ModelChoice | null): void => {
    if (choice === null) {
      const { model: _dropped, ...rest } = providerConfig
      onProviderConfigChange(rest)
      onModelChange({ id: '', supportsVision: false })
      return
    }
    onProviderConfigChange({ ...providerConfig, model: choice.model })
    onModelChange({ id: choice.modelId, supportsVision: choice.supportsVision })
  }
  return (
    <AiModelPicker
      nodeId={stringField(providerConfig, 'nodeId') ?? 'hub'}
      value={value}
      onChange={onChange}
    />
  )
}

const PROVIDER_WIDGETS: ReadonlyMap<string, ComponentType<ProviderWidgetProps>> = new Map<
  string,
  ComponentType<ProviderWidgetProps>
>([
  ['ai/apple-node', AppleNodeWidget],
  ['ai/managed-model', ManagedModelWidget],
])

/** `null` = this build ships no widget with that id. */
export function providerWidget(id: string): ComponentType<ProviderWidgetProps> | null {
  return PROVIDER_WIDGETS.get(id) ?? null
}

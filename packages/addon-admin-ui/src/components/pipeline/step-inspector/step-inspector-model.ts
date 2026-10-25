/**
 * The step matrix's view model (D757) — pure functions for the node Pipeline
 * tab: which accelerators a page shows, what each runs for a step, and the
 * list rows. A camera does not use this matrix (D927); its Steps tree is
 * `camera-step-tree-model`.
 *
 * Everything that decides a MODEL goes through the shared primitives
 * (`resolveEffectiveStepModel`, `stepHasModelForFormat`), and everything that
 * decides a step's SETTINGS through `@camstack/types` `step-settings-layers`,
 * so the inspector, its Compare matrix and the runtime give one answer.
 */
import type {
  ConfigField,
  NodeInferenceDevice,
  PipelineAddonSchema,
  PipelineSchema,
} from '@camstack/types'
import {
  clusterStepSettingFieldsFor,
  isRootSuppliableStepId,
  resolveRootSupply,
} from '@camstack/types'
import {
  acceleratorLabel,
  acceleratorShortLabel,
  type CellState,
  isModelScopedField,
  type RootModelInfo,
  resolveEffectiveStepModel,
  type StepTreeNode,
  stepHasModelForFormat,
  withoutModelScopedFields,
} from '@camstack/ui-library'
import { acceleratorId } from '../../../lib/step-url-selection'

export function findAddonInSchema(
  schema: PipelineSchema | null | undefined,
  addonId: string,
): PipelineAddonSchema | null {
  for (const slot of schema?.slots ?? []) {
    for (const addon of slot.addons) {
      if (addon.id === addonId) return addon
    }
  }
  return null
}

/** One accelerator column of the inspector. */
export interface InspectorAccelerator {
  /** `${nodeId}/${deviceKey}` — the `?acc=` value. */
  readonly id: string
  readonly nodeId: string
  readonly deviceKey: string
  readonly device: NodeInferenceDevice
  /** "hub · Intel NPU (AI Boost)". */
  readonly label: string
  /** "hub · NPU" — tabs and chips. */
  readonly shortLabel: string
  /** The node's display name ("MacMiniAgent"). */
  readonly nodeLabel: string
  /** Switched off — shown only when the operator asks for disabled accelerators. */
  readonly disabled: boolean
}

/** `MacMiniAgent.localdomain` → `MacMiniAgent`. */
export function shortNodeName(name: string): string {
  return name.split('.')[0] ?? name
}

function toAccelerator(
  nodeId: string,
  nodeName: string,
  device: NodeInferenceDevice,
): InspectorAccelerator {
  return {
    id: acceleratorId(nodeId, device.key),
    nodeId,
    deviceKey: device.key,
    device,
    label: `${shortNodeName(nodeName)} · ${acceleratorLabel(device)}`,
    shortLabel: `${shortNodeName(nodeName)} · ${acceleratorShortLabel(device)}`,
    nodeLabel: shortNodeName(nodeName),
    disabled: !device.enabled,
  }
}

/**
 * The node page's accelerators: the ENABLED ones, unless the operator asked to
 * see the disabled ones too. A disabled accelerator runs nothing — the matrix
 * once spent two of the hub's four columns on the CPU and the Coral, both off.
 */
export function nodeAccelerators(
  nodeId: string,
  nodeName: string,
  devices: readonly NodeInferenceDevice[],
  includeDisabled = false,
): readonly InspectorAccelerator[] {
  return devices
    .filter((d) => includeDisabled || d.enabled)
    .map((d) => toAccelerator(nodeId, nodeName, d))
}

/**
 * The model a step runs on one accelerator, and which layer decided it — the
 * accelerator's pin or its hardware default. A camera has no model layer
 * (D927).
 */
export interface StepModelOnAccelerator {
  readonly modelId: string | undefined
  readonly source: 'node' | 'default'
}

export function stepModelOn(
  addon: PipelineAddonSchema,
  acc: InspectorAccelerator,
  layers: { readonly nodePin?: string },
): StepModelOnAccelerator {
  const modelId = resolveEffectiveStepModel({
    catalog: addon,
    device: acc.device,
    base: layers.nodePin,
  })
  return { modelId, source: layers.nodePin !== undefined ? 'node' : 'default' }
}

/** The ROOT model an accelerator runs by default, and what it can supply (D730). */
export function rootModelOn(
  schema: PipelineSchema | null | undefined,
  acc: InspectorAccelerator,
): RootModelInfo | undefined {
  const root = findAddonInSchema(schema, 'object-detection')
  if (root === null) return undefined
  const modelId = resolveEffectiveStepModel({
    catalog: root,
    device: acc.device,
    base: acc.device.steps?.['object-detection']?.modelId,
  })
  if (modelId === undefined) return undefined
  const entry = root.models.find((m) => m.id === modelId)
  return { modelId, name: entry?.name ?? modelId, supplies: entry?.suppliesSteps ?? [] }
}

/** True when the step takes its result from the root model on this accelerator. */
export function suppliedByRoot(
  addonId: string,
  settings: Readonly<Record<string, unknown>>,
  root: RootModelInfo | undefined,
): boolean {
  if (!isRootSuppliableStepId(addonId) || root === undefined) return false
  return resolveRootSupply(addonId, settings, root.supplies).effective
}

/** Whether an accelerator's format has any build of the step's models. */
export function runsOn(addon: PipelineAddonSchema | null, acc: InspectorAccelerator): boolean {
  return addon !== null && stepHasModelForFormat(addon.models, acc.device.format)
}

/** One cell / chip state (the Compare matrix and the list chips share it). */
export function cellStateFor(input: {
  readonly addon: PipelineAddonSchema | null
  readonly acc: InspectorAccelerator
  readonly gatedOn: boolean
  readonly model: StepModelOnAccelerator
  readonly rootName?: string
  readonly clusterModelId?: string
  readonly jumpTo?: string
}): CellState {
  if (!runsOn(input.addon, input.acc)) {
    if (!input.gatedOn) return { kind: 'na' }
    return input.jumpTo !== undefined ? { kind: 'skip', jumpTo: input.jumpTo } : { kind: 'skip' }
  }
  if (input.clusterModelId !== undefined) {
    return { kind: 'enabled', modelId: input.clusterModelId, clusterWide: true }
  }
  return {
    kind: 'enabled',
    modelId: input.model.modelId ?? 'Auto',
    ...(input.rootName !== undefined ? { suppliedByRoot: input.rootName } : {}),
    ...(input.jumpTo !== undefined ? { jumpTo: input.jumpTo } : {}),
  }
}

/** Every label the search should find a step by: its own fields and the cluster-owned ones. */
export function stepFieldLabels(addon: PipelineAddonSchema | null): readonly string[] {
  if (addon === null) return []
  const own = (addon.configSchema ?? []).flatMap((f) =>
    'label' in f && typeof f.label === 'string' ? [f.label] : [],
  )
  const cluster = clusterStepSettingFieldsFor(addon.id).map((f) => f.label)
  return [...new Set([...own, ...cluster])]
}

/** The tree, flattened in display order with depth. */
export function flattenStepTree(
  tree: readonly StepTreeNode[],
): readonly { readonly node: StepTreeNode; readonly depth: number }[] {
  return tree.flatMap((node) => [
    { node, depth: 0 },
    ...flattenStepTree(node.children).map((r) => ({ node: r.node, depth: r.depth + 1 })),
  ])
}

/**
 * The fields a CAMERA may set for a step: every field but a model-scoped one —
 * a model-bound threshold (`bindsToModel`) or a `minConfidence*` floor belongs
 * to the accelerator that runs the model (D927). Groups are filtered
 * recursively and dropped when empty.
 */
export function cameraScopedFields(fields: readonly ConfigField[]): readonly ConfigField[] {
  return withoutModelScopedFields(fields)
}

/**
 * A step's fields split by owner (D927): `nodeFields` hold on every
 * accelerator of a node (and may be set per camera); `acceleratorFields` —
 * the model-bound floors — belong to one accelerator's model. Groups are
 * split recursively.
 */
export function splitStepFields(fields: readonly ConfigField[]): {
  readonly nodeFields: readonly ConfigField[]
  readonly acceleratorFields: readonly ConfigField[]
} {
  return { nodeFields: cameraScopedFields(fields), acceleratorFields: modelScopedFields(fields) }
}

function modelScopedFields(fields: readonly ConfigField[]): readonly ConfigField[] {
  return fields.flatMap((field): ConfigField[] => {
    if (field.type === 'group') {
      const inner = modelScopedFields(field.fields)
      return inner.length > 0 ? [{ ...field, fields: [...inner] }] : []
    }
    return isModelScopedField(field) ? [field] : []
  })
}

/** Does the step carry a field only the accelerator may set (see {@link cameraScopedFields})? */
export function hasModelScopedField(fields: readonly ConfigField[]): boolean {
  return fields.some((field) =>
    field.type === 'group' ? hasModelScopedField(field.fields) : isModelScopedField(field),
  )
}

/** The tree with only the steps in `keep` and their ancestors (the matrix's `/` filter). */
export function filterStepTree(
  tree: readonly StepTreeNode[],
  keep: ReadonlySet<string>,
): readonly StepTreeNode[] {
  return tree.flatMap((node) => {
    const children = filterStepTree(node.children, keep)
    return keep.has(node.addonId) || children.length > 0 ? [{ ...node, children }] : []
  })
}

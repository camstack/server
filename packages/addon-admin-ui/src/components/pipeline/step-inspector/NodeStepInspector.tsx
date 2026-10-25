/**
 * NodeStepInspector — Pipeline → node → Pipeline: the node's BASE for every
 * detection step (D757) — the steps × accelerators matrix, and the clicked
 * cell's settings in the docked panel.
 *
 *   - Columns: the node's ENABLED accelerators ("Show disabled accelerators"
 *     adds the others).
 *   - The panel is about what was clicked: a cell = that step on THAT
 *     accelerator ("Object Detection · Hub · Intel NPU"), with that
 *     accelerator's model only; a step's header = the step on the whole node,
 *     its models listed read-only.
 *   - Model: per accelerator (formats differ), written to
 *     `inferenceDevices[node][deviceKey].steps[step].modelId`; with two or more
 *     accelerators, "Run on" routes the step to another one (`jumpDeviceKey`).
 *   - Settings (D927): NODE-WIDE content (`agentSettings[node].stepSettings`,
 *     `setNodeStepSettings`) holds on every accelerator; a model-bound field
 *     (a `minConfidence*` floor) belongs to the model, so it is set on the
 *     clicked accelerator's own entry. A sibling's entry is never read.
 *   - Cluster-owned models and knobs (face / CLIP encoders) show the cluster
 *     row and link to where it is edited.
 *
 * Enablement is per camera (its Steps tab); a node has no gate.
 */
import { type ReactNode, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { DeviceStepConfig, NodeInferenceDevice, PipelineAddonSchema } from '@camstack/types'
import { pickClusterStepModels, settingValuesEqual } from '@camstack/types'
import {
  acceleratorShortLabel,
  buildStepTreeFromSchema,
  LayeredSettingsForm,
  RootSuppliedModelNote,
  settingsModelIdFor,
  stepFieldDomId,
  Select,
  StepInspectorPanel,
  StepModelRow,
  type StepModelRowProps,
  stepLocalFields,
  stepModelOptions,
  TEXT_HINT,
  TEXT_SECTION_LABEL,
  useAddonSettingsGetGlobalSettings,
  usePipelineExecutorGetSchema,
  usePipelineOrchestratorGetAgentSettings,
  usePipelineOrchestratorGetNodeInferenceDevices,
  usePipelineOrchestratorSetAgentInferenceDevices,
  usePipelineOrchestratorSetNodeStepSettings,
} from '@camstack/ui-library'
import { Link } from 'react-router-dom'
import {
  buildInferenceDevicesWrite,
  effectiveStepSettingsForDevice,
  type InferenceDeviceWriteSource,
} from '../inference-devices-write'
import { ClusterStepModel, clusterScopedStep } from '../ClusterStepModel'
import { loadBalancingHref } from '../pipeline-links'
import { ClusterOwnedSettings } from './ClusterOwnedSettings'
import { EffectiveModelSummary } from './EffectiveModelSummary'
import { StepMatrixFrame } from './StepMatrixFrame'
import {
  cellStateFor,
  findAddonInSchema,
  flattenStepTree,
  type InspectorAccelerator,
  nodeAccelerators,
  rootModelOn,
  runsOn,
  splitStepFields,
  stepFieldLabels,
  stepModelOn,
  suppliedByRoot,
} from './step-inspector-model'
import { useScrollToField } from './use-scroll-to-field'
import { Trans, useTranslation } from 'react-i18next'

interface NodeStepInspectorProps {
  readonly nodeId: string
  readonly nodeName: string
  /** The tab's own actions, on the inspector's toolbar row. */
  readonly toolbar?: ReactNode
}

/**
 * The unsaved edits on ONE step. `null` model / `''` jump = clear that pin.
 * `nodeSettings` = the node-wide bag; `accelerator` = the model-bound fields
 * of ONE accelerator's own entry (D927).
 */
interface NodeDraft {
  readonly stepId: string
  readonly models: Readonly<Record<string, string | null>>
  readonly jumps: Readonly<Record<string, string>>
  readonly nodeSettings?: Readonly<Record<string, unknown>>
  readonly accelerator?: {
    readonly deviceKey: string
    readonly settings: Readonly<Record<string, unknown>>
  }
}

/**
 * Apply one step's device-level draft (models, jumps, one accelerator's
 * model-bound fields) to the node's device map — the whole map is written back.
 * Node-wide settings are NOT here: they go to `setNodeStepSettings`.
 */
export function applyNodeDraft(
  devices: readonly NodeInferenceDevice[],
  draft: NodeDraft,
  isAcceleratorKey: (key: string) => boolean,
): readonly InferenceDeviceWriteSource[] {
  return devices.map((d): InferenceDeviceWriteSource => {
    const steps: Record<string, DeviceStepConfig> = { ...d.steps }
    const current = steps[draft.stepId] ?? {}
    const model = draft.models[d.key]
    const jump = draft.jumps[d.key]
    const own =
      draft.accelerator?.deviceKey === d.key
        ? {
            ...Object.fromEntries(
              Object.entries(current.settings ?? {}).filter(([k]) => !isAcceleratorKey(k)),
            ),
            ...draft.accelerator.settings,
          }
        : current.settings
    const settings = own !== undefined && Object.keys(own).length > 0 ? own : undefined
    const modelId = model === undefined ? current.modelId : (model ?? undefined)
    const jumpDeviceKey = jump === undefined ? current.jumpDeviceKey : jump || undefined
    const next: DeviceStepConfig = {
      ...(modelId !== undefined ? { modelId } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(jumpDeviceKey !== undefined ? { jumpDeviceKey } : {}),
    }
    if (Object.keys(next).length > 0) steps[draft.stepId] = next
    else delete steps[draft.stepId]
    return { key: d.key, enabled: d.enabled, weight: d.weight, maxSessions: d.maxSessions, steps }
  })
}

function bagChanges(
  stored: Readonly<Record<string, unknown>>,
  next: Readonly<Record<string, unknown>> | undefined,
): number {
  if (next === undefined) return 0
  const keys = new Set([...Object.keys(stored), ...Object.keys(next)])
  return [...keys].filter((k) => !settingValuesEqual(stored[k], next[k])).length
}

function countChanges(
  devices: readonly NodeInferenceDevice[],
  draft: NodeDraft | null,
  nodeSettings: Readonly<Record<string, unknown>>,
  acceleratorSettings: (deviceKey: string) => Readonly<Record<string, unknown>>,
): number {
  if (draft === null) return 0
  const models = Object.entries(draft.models).filter(
    ([key, m]) =>
      (m ?? undefined) !== devices.find((d) => d.key === key)?.steps?.[draft.stepId]?.modelId,
  ).length
  const jumps = Object.entries(draft.jumps).filter(
    ([key, j]) =>
      (j || undefined) !== devices.find((d) => d.key === key)?.steps?.[draft.stepId]?.jumpDeviceKey,
  ).length
  const node = bagChanges(nodeSettings, draft.nodeSettings)
  const acc =
    draft.accelerator === undefined
      ? 0
      : bagChanges(acceleratorSettings(draft.accelerator.deviceKey), draft.accelerator.settings)
  return models + jumps + node + acc
}

export function NodeStepInspector({ nodeId, nodeName, toolbar }: NodeStepInspectorProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const devicesQuery = usePipelineOrchestratorGetNodeInferenceDevices(
    { nodeId },
    { refetchOnMount: 'always' },
  )
  const schemaQuery = usePipelineExecutorGetSchema({ nodeId }, { refetchOnMount: 'always' })
  const agentQuery = usePipelineOrchestratorGetAgentSettings(
    { agentNodeId: nodeId },
    { refetchOnMount: 'always' },
  )
  const nodeStepSettings = agentQuery.data?.stepSettings
  const clusterSettingsQuery = useAddonSettingsGetGlobalSettings({
    addonId: 'pipeline-orchestrator',
  })
  const clusterModels = pickClusterStepModels(clusterSettingsQuery.data ?? null)
  const devices: readonly NodeInferenceDevice[] = devicesQuery.data?.devices ?? []
  const schema = schemaQuery.data ?? null

  const [draft, setDraft] = useState<NodeDraft | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; error?: string } | null>(null)

  const setDevices = usePipelineOrchestratorSetAgentInferenceDevices({
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getNodeInferenceDevices']],
      })
    },
  })
  const setNodeSettings = usePipelineOrchestratorSetNodeStepSettings({
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [['pipelineOrchestrator', 'getAgentSettings']],
      })
    },
  })
  const [saving, setSaving] = useState(false)

  const tree = useMemo(() => (schema ? buildStepTreeFromSchema(schema) : []), [schema])
  const flat = useMemo(() => flattenStepTree(tree), [tree])
  const [showDisabled, setShowDisabled] = useState(false)
  // Columns: the enabled accelerators, plus the switched-off ones on request.
  const accelerators = useMemo(
    () => nodeAccelerators(nodeId, nodeName, devices, showDisabled),
    [nodeId, nodeName, devices, showDisabled],
  )
  // Routing ("Run on", the auto-jump) only ever targets an ENABLED accelerator.
  const enabledAccelerators = useMemo(
    () => nodeAccelerators(nodeId, nodeName, devices),
    [nodeId, nodeName, devices],
  )
  const multi = enabledAccelerators.length >= 2

  /** What a step runs with on `acc`: the node-wide bag under that accelerator's own entry. */
  const nodeSettingsFor = (stepId: string, acc: InspectorAccelerator | undefined) =>
    effectiveStepSettingsForDevice(devices, acc?.deviceKey, stepId, nodeStepSettings) ?? {}
  const nodeLayerFor = (stepId: string): Readonly<Record<string, unknown>> =>
    nodeStepSettings?.[stepId] ?? {}
  const ownSettingsFor = (stepId: string, deviceKey: string): Readonly<Record<string, unknown>> =>
    devices.find((d) => d.key === deviceKey)?.steps?.[stepId]?.settings ?? {}

  /** The other enabled accelerator a step runs on from `acc`: a manual pin, else the auto-jump. */
  const jumpTarget = (
    addon: PipelineAddonSchema | null,
    acc: InspectorAccelerator,
    pin?: string,
  ) => {
    const manual = pin ?? acc.device.steps?.[addon?.id ?? '']?.jumpDeviceKey
    if (manual !== undefined && manual !== '') {
      return enabledAccelerators.find((a) => a.deviceKey === manual)
    }
    if (runsOn(addon, acc)) return undefined
    return enabledAccelerators
      .filter((a) => a.id !== acc.id && runsOn(addon, a))
      .toSorted((a, b) => a.deviceKey.localeCompare(b.deviceKey))[0]
  }

  const cellState = (addonId: string, acc: InspectorAccelerator) => {
    const addon = findAddonInSchema(schema, addonId)
    const cluster = clusterScopedStep(addonId)
    const root = rootModelOn(schema, acc)
    const settings = nodeSettingsFor(addonId, acc)
    const target = jumpTarget(addon, acc)
    return cellStateFor({
      addon,
      acc,
      gatedOn: addon?.enabledByDefault ?? true,
      model: addon
        ? stepModelOn(addon, acc, { nodePin: acc.device.steps?.[addonId]?.modelId })
        : { modelId: undefined, source: 'default' },
      ...(suppliedByRoot(addonId, settings, root) && root ? { rootName: root.name } : {}),
      ...(cluster ? { clusterModelId: clusterModels[addonId] ?? cluster.defaultModelId } : {}),
      ...(target ? { jumpTo: acceleratorShortLabel(target.device) } : {}),
    })
  }

  const searchRows = flat.map(({ node }) => ({
    addonId: node.addonId,
    name: node.addonName,
    fieldLabels: stepFieldLabels(findAddonInSchema(schema, node.addonId)),
  }))

  if (devicesQuery.isLoading || schemaQuery.isLoading || agentQuery.isLoading) {
    return (
      <div className="animate-pulse p-4 text-xs text-foreground-subtle">
        {t('stepInspector.nodeStepInspector.loadingPipeline', 'Loading pipeline…')}
      </div>
    )
  }
  if (schema === null) {
    return (
      <div className="p-4 text-xs text-foreground-subtle">
        {t('stepInspector.nodeStepInspector.catalogUnavailable', 'Catalog unavailable.')}
      </div>
    )
  }

  const summary = (
    <span className={TEXT_HINT}>
      {t('stepInspector.nodeStepInspector.accelerators', 'Accelerators:')}{' '}
      <span className="text-foreground">
        {enabledAccelerators.length > 0
          ? enabledAccelerators.map((a) => acceleratorShortLabel(a.device)).join(' · ')
          : t('stepInspector.nodeStepInspector.noneEnabled', 'none enabled')}
      </span>
      {devices.some((d) => !d.enabled) && (
        <>
          {' '}
          {t('stepInspector.nodeStepInspector.off', '— off:')}{' '}
          {devices
            .filter((d) => !d.enabled)
            .map(acceleratorShortLabel)
            .join(', ')}
        </>
      )}{' '}
      ·{' '}
      <Link to={loadBalancingHref()} className="text-primary hover:underline">
        {t('stepInspector.nodeStepInspector.clusterLoadBalancing', 'Cluster → Load balancing ›')}
      </Link>
    </span>
  )

  return (
    <StepMatrixFrame
      tree={tree}
      searchRows={searchRows}
      accelerators={accelerators}
      cellState={cellState}
      disabledCount={devices.filter((d) => !d.enabled).length}
      showDisabled={showDisabled}
      onShowDisabledChange={setShowDisabled}
      dirty={
        draft !== null &&
        countChanges(devices, draft, nodeLayerFor(draft.stepId), (key) =>
          ownSettingsFor(draft.stepId, key),
        ) > 0
      }
      onDiscard={() => setDraft(null)}
      summary={summary}
      {...(toolbar !== undefined ? { toolbar } : {})}
      label={t('stepInspector.nodeStepInspector.detectionSteps', 'Detection steps')}
      renderDetail={({ stepId, accelerator, matchedField, closeButton, onEscape, headingRef }) => {
        const addon = findAddonInSchema(schema, stepId)
        if (addon === null) {
          return (
            <div className="p-4 text-xs text-foreground-subtle">
              {t('stepInspector.nodeStepInspector.noStepSelected', 'No step selected.')}
            </div>
          )
        }
        const stepDraft = draft?.stepId === stepId ? draft : null
        // Node-wide settings hold on every accelerator; a model-bound field is
        // the clicked accelerator's own (D927). The step view edits the
        // node-wide part only.
        const basis = accelerator ?? enabledAccelerators[0] ?? accelerators[0]
        const nodeSettings = stepDraft?.nodeSettings ?? nodeLayerFor(stepId)
        const accSettings =
          accelerator !== null
            ? stepDraft?.accelerator?.deviceKey === accelerator.deviceKey
              ? stepDraft.accelerator.settings
              : ownSettingsFor(stepId, accelerator.deviceKey)
            : {}
        const settings = { ...nodeSettings, ...accSettings }
        const changes = countChanges(devices, stepDraft, nodeLayerFor(stepId), (key) =>
          ownSettingsFor(stepId, key),
        )
        const edit = (patch: Partial<Omit<NodeDraft, 'stepId'>>): void => {
          setStatus(null)
          setDraft((prev) => {
            const base: NodeDraft =
              prev?.stepId === stepId ? prev : { stepId, models: {}, jumps: {} }
            return { ...base, ...patch }
          })
        }
        const cluster = clusterScopedStep(stepId)
        const fields = stepLocalFields(addon)
        const { nodeFields, acceleratorFields } = splitStepFields(fields)
        const acceleratorKeys = new Set(
          acceleratorFields.flatMap((f) => ('key' in f ? [f.key, `${f.key}ModelId`] : [])),
        )
        const root = basis !== undefined ? rootModelOn(schema, basis) : undefined
        const nodePinOn = (acc: InspectorAccelerator): string | undefined => {
          const drafted = stepDraft?.models[acc.deviceKey]
          return drafted === undefined
            ? acc.device.steps?.[stepId]?.modelId
            : (drafted ?? undefined)
        }
        const basisModel =
          basis !== undefined
            ? stepModelOn(addon, basis, { nodePin: nodePinOn(basis) }).modelId
            : undefined

        /** The one model row of the clicked accelerator: its model, change, reset, "Run on". */
        const modelRow = (acc: InspectorAccelerator): StepModelRowProps => {
          const nodePin = nodePinOn(acc)
          const model = stepModelOn(addon, acc, { nodePin })
          const accRoot = rootModelOn(schema, acc)
          const rootSupplies = suppliedByRoot(
            stepId,
            accelerator?.id === acc.id ? settings : nodeSettingsFor(stepId, acc),
            accRoot,
          )
          const jumpPin = stepDraft?.jumps[acc.deviceKey]
          const target = jumpTarget(addon, acc, jumpPin)
          const note = !runsOn(addon, acc) ? (
            <>
              {t('stepInspector.nodeStepInspector.noBuild', { format: acc.device.format })}{' '}
              {target
                ? t(
                    'stepInspector.nodeStepInspector.itRunsOnInstead',
                    'It runs on {{shortLabel}} instead.',
                    { shortLabel: target.shortLabel },
                  )
                : t('stepInspector.nodeStepInspector.itDoesNotRunHere', 'It does not run here.')}
            </>
          ) : rootSupplies && accRoot ? (
            <RootSuppliedModelNote rootModel={accRoot} stepModelId={model.modelId} />
          ) : undefined
          const runOn = multi ? (
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-foreground">
                {t('stepInspector.nodeStepInspector.runOn', 'Run on')}
              </span>
              <Select
                aria-label={t('stepInspector.nodeStepInspector.runOn', 'Run on')}
                value={jumpPin ?? acc.device.steps?.[stepId]?.jumpDeviceKey ?? ''}
                options={[
                  {
                    value: '',
                    label: t(
                      'stepInspector.nodeStepInspector.autoThisAcceleratorOrThe',
                      'Auto (this accelerator, or the next one that can run it)',
                    ),
                  },
                  ...enabledAccelerators
                    .filter((a) => a.id !== acc.id)
                    .map((a) => ({ value: a.deviceKey, label: `${a.label} · ${a.device.format}` })),
                ]}
                onChange={(e) =>
                  edit({ jumps: { ...stepDraft?.jumps, [acc.deviceKey]: e.target.value } })
                }
              />
              <span className={TEXT_HINT}>
                {t(
                  'stepInspector.nodeStepInspector.routesThisStepAndIts',
                  'Routes this step (and its child steps) to another accelerator of this node.',
                )}
              </span>
            </label>
          ) : undefined
          return {
            label: acc.label,
            format: acc.device.format,
            modelId: model.modelId,
            source: model.source === 'node' ? 'node' : 'default',
            sourceLabel: model.source === 'node' ? 'node pin' : 'hardware default',
            models: stepModelOptions(addon.models ?? [], acc.device.format),
            defaultModelId:
              addon.defaultModelIdByFormat?.[acc.device.format] ?? addon.defaultModelId,
            expanded: expanded === acc.id,
            onToggle: () => setExpanded((e) => (e === acc.id ? null : acc.id)),
            onChangeModel: (modelId) =>
              edit({ models: { ...stepDraft?.models, [acc.deviceKey]: modelId } }),
            ...(nodePin !== undefined
              ? {
                  onReset: () => edit({ models: { ...stepDraft?.models, [acc.deviceKey]: null } }),
                  resetLabel: 'Reset to hardware default',
                }
              : {}),
            ...(note !== undefined ? { note } : {}),
            ...(runOn !== undefined ? { extra: runOn } : {}),
            changed: stepDraft?.models[acc.deviceKey] !== undefined || jumpPin !== undefined,
          }
        }

        const save = async (): Promise<void> => {
          if (stepDraft === null) return
          setSaving(true)
          try {
            const deviceEdits =
              Object.keys(stepDraft.models).length > 0 ||
              Object.keys(stepDraft.jumps).length > 0 ||
              stepDraft.accelerator !== undefined
            if (deviceEdits) {
              await setDevices.mutateAsync({
                agentNodeId: nodeId,
                inferenceDevices: buildInferenceDevicesWrite(
                  applyNodeDraft(devices, stepDraft, (k) => acceleratorKeys.has(k)),
                ),
              })
            }
            if (
              stepDraft.nodeSettings !== undefined &&
              bagChanges(nodeLayerFor(stepId), stepDraft.nodeSettings) > 0
            ) {
              await setNodeSettings.mutateAsync({
                agentNodeId: nodeId,
                addonId: stepId,
                settings:
                  Object.keys(stepDraft.nodeSettings).length > 0
                    ? { ...stepDraft.nodeSettings }
                    : null,
              })
            }
            setDraft(null)
            setStatus({ kind: 'saved' })
          } catch (err) {
            setStatus({ kind: 'error', error: err instanceof Error ? err.message : String(err) })
          } finally {
            setSaving(false)
          }
        }

        return (
          <StepInspectorPanel
            ref={headingRef}
            title={
              accelerator !== null
                ? `${addon.name} · ${accelerator.label}`
                : `${addon.name} · ${nodeName}`
            }
            subtitle={
              accelerator !== null
                ? t(
                    'stepInspector.nodeStepInspector.baseForEveryCameraThat',
                    '{{slot}} · {{format}} · base for every camera that lands here',
                    { slot: addon.slot, format: accelerator.device.format },
                  )
                : t(
                    'stepInspector.nodeStepInspector.everyAcceleratorOf',
                    '{{slot}} · every accelerator of {{nodeName}}',
                    { slot: addon.slot, nodeName },
                  )
            }
            leading={closeButton}
            onEscape={onEscape}
            saveBar={{
              dirtyCount: changes,
              saving,
              status: status?.kind ?? null,
              ...(status?.error !== undefined ? { error: status.error } : {}),
              onSave: () => void save(),
              onDiscard: () => setDraft(null),
            }}
          >
            <div className="space-y-3">
              <section
                className="space-y-2"
                aria-label={t('stepInspector.nodeStepInspector.model', 'Model')}
              >
                <h3 className={TEXT_SECTION_LABEL}>
                  {t('stepInspector.nodeStepInspector.model', 'Model')}
                </h3>
                {cluster !== null && basis !== undefined ? (
                  <ClusterStepModel
                    step={cluster}
                    engineFormat={basis.device.format}
                    runnableModelIds={stepModelOptions(addon.models ?? [], basis.device.format).map(
                      (m) => m.id,
                    )}
                  />
                ) : accelerators.length === 0 ? (
                  <p className={TEXT_HINT}>
                    <Trans
                      i18nKey="stepInspector.nodeStepInspector.noAcceleratorEnabled"
                      components={{
                        link: (
                          <Link to={loadBalancingHref()} className="text-primary hover:underline" />
                        ),
                      }}
                    />
                  </p>
                ) : accelerator !== null ? (
                  <StepModelRow key={accelerator.id} {...modelRow(accelerator)} />
                ) : (
                  <EffectiveModelSummary
                    rows={accelerators.map((acc) => {
                      const model = stepModelOn(addon, acc, { nodePin: nodePinOn(acc) })
                      return {
                        id: acc.id,
                        label: acc.label,
                        modelId: model.modelId,
                        sourceLabel: model.source === 'node' ? 'node pin' : 'hardware default',
                      }
                    })}
                  />
                )}
              </section>

              {(fields.length > 0 || root !== undefined) && cluster === null && (
                <section
                  aria-label={t('stepInspector.nodeStepInspector.settings', 'Settings')}
                  className="space-y-2 border-t border-border/60 pt-2"
                >
                  <p className={TEXT_HINT} data-testid="settings-scope">
                    {t('stepInspector.nodeStepInspector.nodeWideSettings', { node: nodeName })}
                  </p>
                  {(nodeFields.length > 0 || root !== undefined) && (
                    <NodeSettings
                      addon={addon}
                      fields={nodeFields}
                      settings={nodeSettings}
                      layerLabel={t('stepInspector.nodeStepInspector.nodeLayer', 'Node')}
                      modelId={settingsModelIdFor(addon, basisModel, settings, root)}
                      root={root}
                      highlight={matchedField}
                      onChange={(next) => edit({ nodeSettings: next })}
                    />
                  )}
                  {acceleratorFields.length > 0 &&
                    (accelerator !== null ? (
                      <div className="space-y-1 border-t border-border/60 pt-2">
                        <p className={TEXT_HINT} data-testid="accelerator-settings-scope">
                          {t('stepInspector.nodeStepInspector.acceleratorSettings', {
                            accelerator: accelerator.label,
                          })}
                        </p>
                        <NodeSettings
                          addon={addon}
                          fields={acceleratorFields}
                          settings={accSettings}
                          layerLabel={t(
                            'stepInspector.nodeStepInspector.acceleratorLayer',
                            'This accelerator',
                          )}
                          modelId={settingsModelIdFor(addon, basisModel, settings, root)}
                          root={undefined}
                          highlight={matchedField}
                          onChange={(next) =>
                            edit({
                              accelerator: { deviceKey: accelerator.deviceKey, settings: next },
                            })
                          }
                        />
                      </div>
                    ) : (
                      <p className={TEXT_HINT} data-testid="accelerator-settings-hint">
                        {t(
                          'stepInspector.nodeStepInspector.thresholdsPerAccelerator',
                          "Confidence thresholds belong to the model, so they are set per accelerator: open that accelerator's cell.",
                        )}
                      </p>
                    ))}
                </section>
              )}
              <ClusterOwnedSettings addonId={stepId} highlightLabel={matchedField} />
            </div>
          </StepInspectorPanel>
        )
      }}
    />
  )
}

function NodeSettings({
  addon,
  fields,
  settings,
  layerLabel,
  modelId,
  root,
  highlight,
  onChange,
}: {
  readonly addon: PipelineAddonSchema
  readonly fields: ReturnType<typeof stepLocalFields>
  readonly settings: Readonly<Record<string, unknown>>
  readonly layerLabel: string
  readonly modelId: string
  readonly root: ReturnType<typeof rootModelOn>
  readonly highlight: string | null
  readonly onChange: (next: Record<string, unknown>) => void
}) {
  const highlightKey = fields.find((f) => 'label' in f && f.label === highlight)?.key ?? null
  useScrollToField(highlightKey === null ? null : stepFieldDomId(highlightKey))
  return (
    <LayeredSettingsForm
      addon={addon}
      fields={fields}
      layers={{ node: settings }}
      target="node"
      labels={{ node: layerLabel }}
      modelId={modelId}
      {...(root !== undefined ? { rootModel: root } : {})}
      highlightKey={highlightKey}
      onChangeLayer={onChange}
    />
  )
}

/**
 * CameraStepInspector — Device → Detection pipeline → Steps (D927).
 *
 * A camera only turns steps on or off. The view is the catalog's step tree
 * (detector → croppers → classifiers): each row is On / Off / Auto, where
 * Auto follows the catalog default (`stepToggles` absent). An ancestor that
 * is off idles its descendants. The root-detector pick stays above the tree.
 *
 * Models are not on this page. One line links to Pipeline › Nodes, where the
 * accelerator that runs the camera chooses them. The side panel edits only
 * camera-semantic settings (`stepSettings`); a step with none says so.
 */
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import type { PipelineAddonSchema, PipelineSchema } from '@camstack/types'
import { settingValuesEqual, type StepSettingsBag } from '@camstack/types'
import {
  BackToStepsButton,
  buildStepTreeFromSchema,
  IconButton,
  LayeredSettingsForm,
  StepDetailDock,
  StepInspectorPanel,
  TEXT_HINT,
  stepLocalFields,
  useClusterNodes,
  useConfirm,
  useIsMobile,
  usePipelineOrchestratorGetCameraSettings,
  usePipelineOrchestratorListAgentSettings,
  usePipelineOrchestratorSetCameraStepSettings,
  usePipelineOrchestratorSetCameraStepToggle,
  useSystem,
} from '@camstack/ui-library'
import { useCameraDetectionSource } from '../../../hooks/useCameraDetectionSource'
import { useEventInvalidation } from '../../../hooks/useEventInvalidation'
import { useStepUrlSelection } from '../../../hooks/useStepUrlSelection'
import { suppressedStepNotice } from '../../pipeline/step-inspector/detection-source-model'
import {
  cameraScopedFields,
  findAddonInSchema,
  hasModelScopedField,
} from '../../pipeline/step-inspector/step-inspector-model'
import { Trans, useTranslation } from 'react-i18next'
import { CameraStepTree } from './CameraStepTree'
import { cameraStepRows } from './camera-step-tree-model'
import { DetectionSourceControl } from './DetectionSourceControl'

/** package-detection runs where the camera has package zones — a badge, not a gate. */
const ZONE_DRIVEN_ADDON_IDS: ReadonlySet<string> = new Set(['package-detection'])

const NODES_PIPELINE_HREF = '/system/pipeline?view=nodes'

interface CameraStepInspectorProps {
  readonly deviceId: number
}

/** Unsaved edits on ONE step's camera-wide layer. */
interface CameraDraft {
  readonly stepId: string
  readonly camera: Readonly<Record<string, unknown>>
}

interface SaveStatus {
  readonly kind: 'saved' | 'error'
  readonly error?: string
}

function catalogDefaults(schema: PipelineSchema): Readonly<Record<string, boolean>> {
  return Object.fromEntries(
    schema.slots.flatMap((slot) =>
      slot.addons.map((addon) => [addon.id, addon.enabledByDefault ?? true] as const),
    ),
  )
}

export function CameraStepInspector({ deviceId }: CameraStepInspectorProps) {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const isMobile = useIsMobile()
  const queryClient = useQueryClient()
  const trpcClient = useSystem().trpcClient
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const headingEl = useRef<HTMLHeadingElement | null>(null)
  const camSettingsQuery = usePipelineOrchestratorGetCameraSettings(
    { deviceId },
    { refetchOnMount: 'always' },
  )
  const agentsQuery = usePipelineOrchestratorListAgentSettings(undefined, {
    refetchOnMount: 'always',
  })
  useEventInvalidation(
    ['nodes', 'topology'],
    ['agent.online', 'agent.offline', 'agent.unregistered', 'addon.installed', 'addon.uninstalled'],
  )
  const { nodes: clusterNodes } = useClusterNodes()
  const onlineNodes = useMemo(() => {
    const agentIds = new Set((agentsQuery.data ?? []).map((a) => a.nodeId))
    return clusterNodes
      .filter((n) => n.isOnline && agentIds.has(n.id))
      .map((n) => ({ id: n.id, name: n.name }))
  }, [agentsQuery.data, clusterNodes])
  const onlineKey = onlineNodes.map((n) => n.id).join(',')
  const schemasQuery = useQuery({
    enabled: onlineNodes.length > 0,
    queryKey: [['pipelineExecutor', 'getSchema'], 'camera-step-schemas', onlineKey],
    queryFn: async (): Promise<Readonly<Record<string, PipelineSchema>>> => {
      const out: Record<string, PipelineSchema> = {}
      for (const node of onlineNodes) {
        try {
          out[node.id] = await trpcClient.pipelineExecutor.getSchema.query({ nodeId: node.id })
        } catch {
          // omit — another online node may still have the catalog
        }
      }
      return out
    },
  })
  const invalidate = useCallback((): void => {
    void queryClient.invalidateQueries({
      queryKey: [['pipelineOrchestrator', 'getCameraSettings']],
    })
  }, [queryClient])
  const setToggle = usePipelineOrchestratorSetCameraStepToggle({ onSuccess: invalidate })
  const setStepSettings = usePipelineOrchestratorSetCameraStepSettings()
  const [draft, setDraft] = useState<CameraDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<SaveStatus | null>(null)
  const detectionSource = useCameraDetectionSource(deviceId)

  const schemas = schemasQuery.data ?? {}
  const camera = camSettingsQuery.data ?? null
  const treeSchema = onlineNodes.map((n) => schemas[n.id]).find((s) => s !== undefined) ?? null
  const tree = useMemo(() => (treeSchema ? buildStepTreeFromSchema(treeSchema) : []), [treeSchema])
  const rows = useMemo(
    () =>
      treeSchema === null
        ? []
        : cameraStepRows({
            tree,
            toggles: camera?.stepToggles,
            defaults: catalogDefaults(treeSchema),
            source: detectionSource.source,
            zoneDrivenIds: ZONE_DRIVEN_ADDON_IDS,
          }),
    [tree, treeSchema, camera?.stepToggles, detectionSource.source],
  )
  const stepIds = useMemo(() => rows.map((row) => row.stepId), [rows])
  const { selection, open, close } = useStepUrlSelection(stepIds, [])
  const firstNodeId = onlineNodes[0]?.id

  const leaveDraft = useCallback(
    async (go: () => void): Promise<void> => {
      if (draft !== null) {
        const ok = await confirm({
          title: t(
            'stepInspector.stepMatrixFrame.discardUnsavedChanges',
            'Discard unsaved changes?',
          ),
          message: t(
            'stepInspector.stepMatrixFrame.thisStepHasChangesThat',
            'This step has changes that are not saved yet.',
          ),
          confirmLabel: t('stepInspector.stepMatrixFrame.discard', 'Discard'),
          variant: 'danger',
        })
        if (!ok) return
        setDraft(null)
      }
      go()
    },
    [confirm, draft, t],
  )

  const openStep = (stepId: string): void => {
    if (stepId === selection.stepId) return
    void leaveDraft(() => open({ stepId }))
  }
  const closePanel = (): void => {
    void leaveDraft(() => close())
  }

  if (agentsQuery.isLoading || (onlineNodes.length > 0 && schemasQuery.isLoading)) {
    return (
      <div className="animate-pulse p-4 text-xs text-foreground-subtle">
        {t('device.cameraStepInspector.loadingPipeline', 'Loading pipeline…')}
      </div>
    )
  }
  if (onlineNodes.length === 0) {
    return (
      <div className="p-4 text-xs text-foreground-subtle">
        {t('device.cameraStepInspector.noPipelineNodeIsOnline', 'No pipeline node is online.')}
      </div>
    )
  }
  if (treeSchema === null) {
    return (
      <div className="p-4 text-xs text-foreground-subtle">
        {t('device.cameraStepInspector.catalogUnavailable', 'Catalog unavailable.')}
      </div>
    )
  }

  const nodeBag = (stepId: string): StepSettingsBag =>
    agentsQuery.data?.find((agent) => agent.nodeId === firstNodeId)?.settings.stepSettings?.[
      stepId
    ] ?? {}
  const openRow = rows.find((row) => row.stepId === selection.stepId) ?? null
  const addon = openRow === null ? null : findAddonInSchema(treeSchema, openRow.stepId)
  const closeButton = isMobile ? (
    <BackToStepsButton onClick={closePanel} />
  ) : (
    <IconButton
      icon={X}
      variant="ghost"
      size="sm"
      aria-label={t('common.close', 'Close')}
      onClick={closePanel}
    />
  )

  return (
    <div ref={anchorRef} className="space-y-2">
      {detectionSource.view?.onboard.available === true && detectionSource.source !== null && (
        <DetectionSourceControl
          source={detectionSource.source}
          geometry={detectionSource.view.onboard.geometry}
          saving={detectionSource.saving}
          error={detectionSource.error}
          onPick={(next) => void detectionSource.pick(next)}
        />
      )}
      <p className={TEXT_HINT}>
        <Trans
          i18nKey="device.cameraStepInspector.modelsChosenByAccelerators"
          components={{
            nodes: (
              <Link to={NODES_PIPELINE_HREF} className="font-medium text-primary hover:underline" />
            ),
          }}
        />
      </p>
      {selection.staleStepId !== null && (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning">
          {t('stepInspector.stepMatrixFrame.staleStep', { id: selection.staleStepId })}
        </p>
      )}
      <CameraStepTree
        rows={rows}
        label={t(
          'device.cameraStepInspector.detectionStepsOfThisCamera',
          'Detection steps of this camera',
        )}
        selectedId={selection.stepId}
        busy={setToggle.isPending}
        onOpen={openStep}
        onSet={(stepId, enabled) => setToggle.mutate({ deviceId, addonId: stepId, enabled })}
      />
      <StepDetailDock
        open={openRow !== null && addon !== null}
        anchor={anchorRef}
        onClose={closePanel}
        label={t('stepInspector.stepMatrixFrame.stepSettings', 'Step settings')}
      >
        {openRow !== null && addon !== null && (
          <CameraStepDetail
            addon={addon}
            nodeBag={nodeBag(openRow.stepId)}
            storedCamera={camera?.stepSettings?.[openRow.stepId]}
            draft={draft?.stepId === openRow.stepId ? draft : null}
            saving={saving}
            status={status}
            notice={
              openRow.blocked?.kind === 'source'
                ? suppressedStepNotice(openRow.blocked.source, openRow.stepId)
                : null
            }
            closeButton={closeButton}
            onEscape={closePanel}
            headingRef={(el) => {
              headingEl.current = el
            }}
            onDraft={(next) => {
              setStatus(null)
              setDraft({ stepId: openRow.stepId, camera: next })
            }}
            onDiscard={() => setDraft(null)}
            onSave={async (next) => {
              setSaving(true)
              try {
                await setStepSettings.mutateAsync({
                  deviceId,
                  addonId: openRow.stepId,
                  settings: Object.keys(next).length > 0 ? { ...next } : null,
                })
                setDraft(null)
                setStatus({ kind: 'saved' })
              } catch (err) {
                setStatus({
                  kind: 'error',
                  error:
                    err instanceof Error ? err.message : t('device.cameraStepInspector.saveFailed'),
                })
              } finally {
                setSaving(false)
                invalidate()
              }
            }}
          />
        )}
      </StepDetailDock>
    </div>
  )
}

interface CameraStepDetailProps {
  readonly addon: PipelineAddonSchema
  readonly nodeBag: StepSettingsBag
  readonly storedCamera: StepSettingsBag | undefined
  readonly draft: CameraDraft | null
  readonly saving: boolean
  readonly status: SaveStatus | null
  readonly notice: string | null
  readonly closeButton: ReactNode
  readonly onEscape: () => void
  readonly headingRef: (el: HTMLHeadingElement | null) => void
  readonly onDraft: (next: Record<string, unknown>) => void
  readonly onDiscard: () => void
  readonly onSave: (next: Readonly<Record<string, unknown>>) => Promise<void>
}

function CameraStepDetail({
  addon,
  nodeBag,
  storedCamera,
  draft,
  saving,
  status,
  notice,
  closeButton,
  onEscape,
  headingRef,
  onDraft,
  onDiscard,
  onSave,
}: CameraStepDetailProps) {
  const { t } = useTranslation()
  const allFields = stepLocalFields(addon)
  const fields = cameraScopedFields(allFields)
  const acceleratorOnly = hasModelScopedField(allFields)
  const cameraBag = draft?.camera ?? storedCamera
  const dirty = draft !== null && !settingValuesEqual(draft.camera, storedCamera ?? {})
  return (
    <StepInspectorPanel
      ref={headingRef}
      title={t('device.cameraStepInspector.thisCamera', '{{name}} · this camera', {
        name: addon.name,
      })}
      subtitle={addon.slot}
      leading={closeButton}
      onEscape={onEscape}
      {...(fields.length > 0
        ? {
            saveBar: {
              dirtyCount: dirty ? 1 : 0,
              saving,
              status: status?.kind ?? null,
              ...(status?.error !== undefined ? { error: status.error } : {}),
              onSave: () => void onSave(draft?.camera ?? storedCamera ?? {}),
              onDiscard,
              scope: (
                <p className={TEXT_HINT}>
                  {t(
                    'device.cameraStepInspector.appliesToAllAcceleratorsOf',
                    'Applies to: all accelerators of this camera.',
                  )}
                </p>
              ),
            },
          }
        : {})}
    >
      <div className="space-y-3">
        {notice !== null && (
          <p
            role="note"
            className="rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] text-warning"
          >
            {notice}
          </p>
        )}
        {fields.length > 0 ? (
          <CameraSettings
            addon={addon}
            fields={fields}
            nodeBag={nodeBag}
            cameraBag={cameraBag}
            onChange={onDraft}
          />
        ) : (
          <p className={TEXT_HINT}>
            {t(
              'device.cameraStepInspector.noCameraSettings',
              'This step has no settings on this camera.',
            )}
          </p>
        )}
        {acceleratorOnly && (
          <p className={TEXT_HINT} data-testid="accelerator-only-thresholds">
            {t(
              'device.cameraStepInspector.thresholdsAreTheAccelerators',
              'Confidence thresholds belong to the model, so they are set on the accelerator that runs it (Pipeline → Nodes), not per camera.',
            )}
          </p>
        )}
      </div>
    </StepInspectorPanel>
  )
}

interface CameraSettingsProps {
  readonly addon: PipelineAddonSchema
  readonly fields: ReturnType<typeof stepLocalFields>
  readonly nodeBag: StepSettingsBag
  readonly cameraBag: StepSettingsBag | undefined
  readonly onChange: (next: Record<string, unknown>) => void
}

function CameraSettings({ addon, fields, nodeBag, cameraBag, onChange }: CameraSettingsProps) {
  const { t } = useTranslation()
  return (
    <LayeredSettingsForm
      addon={addon}
      fields={fields}
      layers={{
        node: nodeBag,
        ...(cameraBag !== undefined ? { camera: cameraBag } : {}),
      }}
      target="camera"
      labels={{
        camera: t('device.cameraStepInspector.layerCamera', 'This camera'),
        node: t('device.cameraStepInspector.layerNode', 'Node'),
      }}
      modelId={addon.defaultModelId}
      onChangeLayer={onChange}
    />
  )
}

/**
 * CameraPipelineCard — one camera, everything the pipeline is doing for it.
 *
 * Composition (no charts, no graph — an operational readout):
 *
 *   header   name · #id · health dot · detection-mode chip · REC chip
 *   banner   loud problem strip (errors red, warnings amber) — the
 *            cross-node black-hole signature can never look healthy
 *   grid     six hairline-divided blocks:
 *            Where it runs · Detection runtime · Pipeline steps
 *            Streams & motion · Stream broker · Decoder
 *
 * Data:
 *   - `CameraStatus` (batched, polled upstream) + 1 Hz live overlay
 *   - `addonSettings.getDeviceSettings(pipeline-orchestrator)` — per-camera
 *     detection mode, FPS knobs, motion sources, persisted node pins
 *   - `pipelineOrchestrator.resolvePipeline` — effective step tree
 *   - pin/unpin reuses the existing `assignPipeline` / `unassignPipeline`
 *     mutations (same as the cluster assignments table)
 */
import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import {
  useAddonSettingsGetDeviceSettings,
  usePipelineOrchestratorAssignPipeline,
  usePipelineOrchestratorResolvePipeline,
  usePipelineOrchestratorUnassignPipeline,
} from '@camstack/ui-library'
import type { CameraStatus } from '@camstack/types'
import {
  deriveCameraProblems,
  extractOrchestratorCameraSettings,
  flattenPipelineSteps,
} from './camera-card-model'
import type { CameraProblem } from './camera-card-model'
import { cameraHealth } from './camera-health'
import type { CameraHealth } from './camera-health'
import { Chip } from './card-primitives'
import { PlacementBlock, StepsBlock, StreamsMotionBlock } from './config-blocks'
import { BrokerBlock, DecoderBlock, DetectionBlock } from './runtime-blocks'
import type { ClusterNodeOption, LiveDetectionMetrics } from './use-cameras-overview'
import { useTranslation } from 'react-i18next'

const ORCHESTRATOR_ADDON_ID = 'pipeline-orchestrator'

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

const HEALTH_DOT_CLASS: Record<CameraHealth, string> = {
  healthy: 'bg-success',
  idle: 'bg-warning',
  error: 'bg-danger',
}

const HEALTH_LABEL_KEY: Record<CameraHealth, string> = {
  healthy: 'pipeline.cameraPipelineCard.healthHealthy',
  idle: 'pipeline.cameraPipelineCard.healthIdle',
  error: 'pipeline.cameraPipelineCard.healthError', // i18n-ignore: catalogue key
}

interface ProblemBannerProps {
  readonly problems: readonly CameraProblem[]
}

function ProblemBanner({ problems }: ProblemBannerProps) {
  return (
    <div role="alert" className="flex flex-col border-b border-border">
      {problems.map((problem) => (
        <div
          key={problem.code}
          className={`flex items-start gap-2 px-4 py-1.5 text-[11px] font-medium ${
            problem.severity === 'error' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span className="min-w-0">{problem.message}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export interface CameraPipelineCardProps {
  readonly deviceId: number
  readonly name: string
  readonly online: boolean
  readonly status: CameraStatus | undefined
  readonly live: LiveDetectionMetrics | undefined
  readonly onlineNodes: readonly ClusterNodeOption[]
}

export function CameraPipelineCard({
  deviceId,
  name,
  online,
  status,
  live,
  onlineNodes,
}: CameraPipelineCardProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: settingsSchema } = useAddonSettingsGetDeviceSettings(
    { addonId: ORCHESTRATOR_ADDON_ID, deviceId, nodeId: 'hub' },
    { staleTime: 30_000 },
  )
  const { data: resolvedPipeline } = usePipelineOrchestratorResolvePipeline(
    { deviceId },
    { staleTime: 30_000 },
  )

  const settings = useMemo(
    () => extractOrchestratorCameraSettings(settingsSchema),
    [settingsSchema],
  )
  const steps = useMemo(
    () =>
      resolvedPipeline !== undefined ? flattenPipelineSteps(resolvedPipeline.steps) : undefined,
    [resolvedPipeline],
  )
  const problems = useMemo(
    () => (status !== undefined ? deriveCameraProblems(status) : []),
    [status],
  )

  const invalidatePlacement = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [['pipelineOrchestrator', 'getCameraStatuses']],
    })
    void queryClient.invalidateQueries({
      queryKey: [['pipelineOrchestrator', 'getPipelineAssignments']],
    })
  }
  const assignPipeline = usePipelineOrchestratorAssignPipeline({ onSuccess: invalidatePlacement })
  const unassignPipeline = usePipelineOrchestratorUnassignPipeline({
    onSuccess: invalidatePlacement,
  })

  const handleDetectionPinChange = (target: string): void => {
    if (target === 'auto') unassignPipeline.mutate({ deviceId })
    else assignPipeline.mutate({ deviceId, agentNodeId: target })
  }

  const health: CameraHealth = status !== undefined ? cameraHealth(status) : 'idle'
  const hasError = problems.some((problem) => problem.severity === 'error')
  const hasWarning = problems.length > 0
  const borderClass = hasError
    ? 'border-danger/50'
    : hasWarning
      ? 'border-warning/40'
      : 'border-border'

  return (
    <article
      aria-label={t('cameras.cameraPipelineCard.pipelineStatus', '{{name}} pipeline status', {
        name,
      })}
      className={`rounded-lg border ${borderClass} bg-background overflow-hidden`}
    >
      {/* Header */}
      <header className="flex items-center gap-2.5 px-4 py-2.5 border-b border-border bg-surface/50 min-w-0">
        <span
          className={`inline-block h-2 w-2 rounded-full shrink-0 ${
            hasError ? 'bg-danger' : HEALTH_DOT_CLASS[health]
          }`}
          title={hasError ? t('common.error', 'Error') : t(HEALTH_LABEL_KEY[health])}
          aria-label={hasError ? t('common.error', 'Error') : t(HEALTH_LABEL_KEY[health])}
          role="img"
        />
        <h3 className="text-[13px] font-semibold text-foreground truncate" title={name}>
          {name}
        </h3>
        <span className="text-[10px] text-foreground-subtle shrink-0">#{deviceId}</span>
        {!online && <Chip tone="danger">{t('common.offline')}</Chip>}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {settings.detectionMode !== null && (
            <Chip
              tone={
                settings.detectionMode === 'disabled'
                  ? 'warning'
                  : settings.detectionMode === 'always-on'
                    ? 'info'
                    : 'neutral'
              }
              title={t('cameras.cameraPipelineCard.objectDetectionMode', 'Object detection mode')}
            >
              {settings.detectionMode === 'disabled'
                ? t('cameras.cameraPipelineCard.detectionOff', 'detection off')
                : settings.detectionMode}
            </Chip>
          )}
          {status?.recording != null &&
            (status.recording.active ? (
              <Chip
                tone="danger"
                title={t('cameras.cameraPipelineCard.recording', 'Recording ({{mode}})', {
                  mode: status.recording.mode,
                })}
              >
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />
                REC
              </Chip>
            ) : (
              status.recording.mode !== 'off' && (
                <Chip
                  tone="neutral"
                  title={t('cameras.cameraPipelineCard.recordingMode', 'Recording mode')}
                >
                  {t('pipeline.cameraPipelineCard.recMode', { mode: status.recording.mode })}
                </Chip>
              )
            ))}
        </span>
      </header>

      {/* Problems — loud, never hidden */}
      {problems.length > 0 && <ProblemBanner problems={problems} />}

      {/* Body */}
      {status === undefined ? (
        <div className="px-4 py-5 text-[11px] text-foreground-subtle italic">
          {t(
            'cameras.cameraPipelineCard.noPipelineStatusYetThe',
            'No pipeline status yet — the orchestrator has not composed a snapshot for this camera.',
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-border">
          <PlacementBlock
            assignment={status.assignment}
            settings={settings}
            onlineNodes={onlineNodes}
            pinPending={assignPipeline.isPending || unassignPipeline.isPending}
            onDetectionPinChange={handleDetectionPinChange}
          />
          <DetectionBlock
            detection={status.detection}
            live={live}
            detectionMode={settings.detectionMode}
            modeOverridden={settings.overriddenKeys.has('detectionMode')}
          />
          <StepsBlock
            steps={steps}
            audioModelId={resolvedPipeline?.audio?.modelId ?? null}
            audioEnabled={status.audio?.enabled ?? resolvedPipeline?.audio?.enabled ?? null}
            audioMode={settings.audioMode}
          />
          <StreamsMotionBlock
            streams={status.source.streams}
            brokerProfiles={status.broker?.profiles}
            settings={settings}
            motionEnabled={status.motion?.enabled ?? null}
            motionFpsLive={status.motion?.fps ?? null}
            cameraSensors={status.cameraSensors}
          />
          <BrokerBlock broker={status.broker} />
          <DecoderBlock decoder={status.decoder} />
        </div>
      )}
    </article>
  )
}

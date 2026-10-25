/**
 * PipelineQuickStats — `pipeline-quick-stats` widget.
 *
 * Owned by the pipeline-orchestrator addon (the cap surface that tracks
 * per-camera detection state). Renders the four KPI tiles previously
 * inlined in admin-ui's `OverviewTab.tsx`:
 *   - Phase (current pipeline phase + detection mode subtext)
 *   - Detection FPS (actual / configured)
 *   - Inference (avg ms + queue depth)
 *   - Active Tracks (count + dropped frame count)
 *
 * Mounted via `<WidgetSlot widgetId="pipeline-orchestrator/pipeline-quick-stats"
 * deviceId={…}/>` from a form contribution or dashboard layout entry.
 *
 * Skips render when the device isn't a camera (Switch / Light / Sensor
 * have no pipeline-runner state to report) — same gate the original
 * admin-ui used.
 */
import { useQuery } from '@tanstack/react-query'
import { resolveHydratedFieldValue } from '@camstack/types'
import { Activity, Cpu, Eye, Gauge, Video, Volume2 } from 'lucide-react'
import {
  GRID_QUICK_STATS,
  StatCard,
  getPhaseVisual,
  useDeviceProxy,
  useEventInvalidation,
  usePipelineOrchestratorGetPipelineAssignment,
  usePipelineRunnerGetCameraMetrics,
  useSystem,
  type WidgetProps,
  useUiText,
} from '@camstack/ui-library'
import { useT } from '../i18n/index.js'

export function PipelineQuickStats(props: WidgetProps) {
  const { t } = useT()
  if (props.deviceId === undefined) {
    return (
      <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
        {t('quickStats.requiresDevice')}
      </div>
    )
  }
  return <PipelineQuickStatsInner deviceId={props.deviceId} />
}

interface InnerProps {
  readonly deviceId: number
}

/** Boundary view of `recording.getStatus` output (tRPC inference defeated). */
interface RecordingStatusView {
  readonly enabled: boolean
  readonly activeMode: string
  readonly storageBytes?: number
}
/** Boundary view of `recording.getDeviceConfig` output. */
interface RecordingConfigView {
  readonly profiles?: readonly string[]
}

function PipelineQuickStatsInner({ deviceId }: InnerProps) {
  const { t } = useT()
  const uiText = useUiText()
  // Pipeline assignment (orchestrator state) drives which runner the
  // metrics query routes to. The route resolver can fall back to the
  // local runner when no real cluster node is assigned (legacy single-
  // node setups, fresh installs).
  useEventInvalidation(
    ['pipelineOrchestrator', 'getPipelineAssignment'],
    ['pipeline.camera-assigned', 'pipeline.camera-unassigned', 'pipeline.camera-updated'],
  )
  useEventInvalidation(['pipelineRunner', 'getCameraMetrics'], ['pipeline.camera-metrics-snapshot'])

  const { data: assignment } = usePipelineOrchestratorGetPipelineAssignment(
    { deviceId },
    { staleTime: 30_000 },
  )

  // Filter out phantom node ids (cap-provider ids like
  // `addon:pipeline-runner` left over from single-node dev state).
  // Routing through one of those returns PRECONDITION_FAILED on every
  // poll. Only a real cluster-node id (`hub` or `dev-agent-*`) gets
  // forwarded; otherwise let the cap router fall back to the local
  // runner.
  const assignedNodeId = assignment?.agentNodeId ?? null
  const isRealNodeId =
    typeof assignedNodeId === 'string' &&
    assignedNodeId.length > 0 &&
    !assignedNodeId.startsWith('addon:')
  const routingNodeId = isRealNodeId ? assignedNodeId : undefined

  const { data: cameraMetrics } = usePipelineRunnerGetCameraMetrics(
    {
      deviceId,
      ...(routingNodeId ? { nodeId: routingNodeId } : {}),
    },
    { staleTime: 2_000, retry: false },
  )

  // Active tracks live on the pipeline-analytics cap (device-scoped) —
  // routed through the DeviceProxy so deviceId/nodeId auto-inject.
  const system = useSystem()
  const dev = useDeviceProxy(system.trpcClient, deviceId)
  const { data: activeTracksList } = useQuery({
    queryKey: ['device', deviceId, 'pipelineAnalytics.getActiveTracks'],
    queryFn: () => dev?.pipelineAnalytics?.getActiveTracks({}) ?? [],
    enabled: !!dev,
    refetchInterval: 5_000,
    retry: false,
  })

  // Live audio level — the `audio-metrics` cap's current snapshot carries
  // `level.dbfs`. Routed through the DeviceProxy so deviceId/nodeId
  // auto-inject; null when the device has no audio source (or the
  // analyzer hasn't produced a first window yet).
  const { data: audioSnapshot } = useQuery({
    queryKey: ['device', deviceId, 'audioMetrics.getCurrentSnapshot'],
    queryFn: () => dev?.audioMetrics?.getCurrentSnapshot({}) ?? null,
    enabled: !!dev,
    refetchInterval: 2_000,
    retry: false,
  })

  // Recording status — `recording-archive` is a SINGLETON cap (not
  // device-native), so it's called directly off the trpc client with an
  // explicit deviceId rather than through the DeviceProxy. The singleton cap surface defeats tRPC client
  // inference (returns `{}`), so the result is narrowed at this boundary — the
  // same pattern the storage widgets use. Shapes mirror the `recording-archive.cap`
  // `getStatus` / `getDeviceConfig` outputs.
  const { data: recStatus } = useQuery({
    queryKey: ['recordingArchive.getStatus', deviceId],
    queryFn: async (): Promise<RecordingStatusView> =>
      (await system.trpcClient.recordingArchive.getStatus.query({
        deviceId,
      })) as RecordingStatusView,
    refetchInterval: 5_000,
    retry: false,
  })
  const { data: recConfig } = useQuery({
    queryKey: ['recordingArchive.getDeviceConfig', deviceId],
    queryFn: async (): Promise<RecordingConfigView> =>
      (await system.trpcClient.recordingArchive.getDeviceConfig.query({
        deviceId,
      })) as RecordingConfigView,
    staleTime: 30_000,
    retry: false,
  })

  // Operator-CONFIGURED detection mode — read from the per-camera settings
  // aggregate (`addonSettings.getDeviceSettings`), NOT `cameraMetrics`.
  // The runner's `detectionMode` is its RUNTIME scheduling mode, which a
  // session-time dispatch deliberately reports as `always-on` while an
  // on-motion camera runs a dispatched session — so the tile would show
  // "always-on" for an on-motion camera. Mirrors the pipeline camera card's
  // `resolve('detectionMode')` seam (a cap query, addon-agnostic).
  const { data: deviceSettings } = useQuery({
    queryKey: ['device', deviceId, 'addonSettings.getDeviceSettings.detectionMode'],
    queryFn: () =>
      system.trpcClient.addonSettings.getDeviceSettings.query({
        addonId: 'pipeline-orchestrator',
        deviceId,
      }),
    staleTime: 30_000,
    retry: false,
  })
  const rawMode = resolveHydratedFieldValue(deviceSettings, 'detectionMode')
  const configuredDetectionMode = typeof rawMode === 'string' ? rawMode : null

  const phase = cameraMetrics?.phase ?? null
  const detectionMode = configuredDetectionMode
  const actualFps = Number(cameraMetrics?.actualFps ?? 0)
  const configuredFps = Number(cameraMetrics?.configuredFps ?? 0)
  const avgInferenceMs = Number(cameraMetrics?.avgInferenceTimeMs ?? 0)
  const queueDepth = Number(cameraMetrics?.queueDepth ?? 0)
  const droppedFrames = Number(cameraMetrics?.droppedFrames ?? 0)
  const phaseCfg = getPhaseVisual(phase ?? 'watching', uiText)
  const activeTracks = activeTracksList?.length ?? 0

  // `level.dbfs` is a negative-going dBFS reading (0 = full scale). Show
  // one decimal; em-dash when the device reports no audio level.
  const dbfs = audioSnapshot?.level.dbfs ?? null
  const dbfsValue = typeof dbfs === 'number' ? `${dbfs.toFixed(1)} dBFS` : '—'

  // Recording card: state (label + color), space used + recorded profiles.
  const recEnabled = recStatus?.enabled ?? false
  const recMode = recStatus?.activeMode ?? 'off'
  const recActive = recEnabled && recMode !== 'off'
  const recLabel = !recEnabled
    ? t('quickStats.rec.disabled')
    : recMode === 'off'
      ? t('quickStats.rec.idle')
      : recMode === 'continuous'
        ? t('quickStats.rec.continuous')
        : recMode === 'onMotion'
          ? t('quickStats.rec.onMotion')
          : recMode === 'onAudioThreshold'
            ? t('quickStats.rec.onAudio')
            : recMode
  const recProfiles = (recConfig?.profiles ?? []).join(', ')
  const recSubtext = recStatus
    ? `${formatBytes(recStatus.storageBytes ?? 0)}${recProfiles ? ` · ${recProfiles}` : ''}`
    : undefined

  return (
    <div className={GRID_QUICK_STATS}>
      <StatCard
        icon={Activity}
        label={t('quickStats.phase')}
        value={phaseCfg.label}
        valueClassName={phaseCfg.textColor}
        subtext={detectionMode ?? undefined}
      />
      <StatCard
        icon={Gauge}
        label={t('quickStats.detectionFps')}
        value={`${actualFps.toFixed(1)}`}
        subtext={configuredFps > 0 ? t('quickStats.target', { value: configuredFps }) : undefined}
      />
      <StatCard
        icon={Cpu}
        label={t('quickStats.inference')}
        value={`${avgInferenceMs.toFixed(1)} ms`}
        subtext={queueDepth > 0 ? t('quickStats.queue', { value: queueDepth }) : undefined}
      />
      <StatCard
        icon={Eye}
        label={t('quickStats.activeTracks')}
        value={String(activeTracks)}
        subtext={droppedFrames > 0 ? t('quickStats.dropped', { value: droppedFrames }) : undefined}
      />
      <StatCard icon={Volume2} label={t('quickStats.currentDb')} value={dbfsValue} />
      <StatCard
        icon={Video}
        label={t('quickStats.recording')}
        value={recLabel}
        valueClassName={recActive ? 'text-success' : undefined}
        subtext={recSubtext}
      />
    </div>
  )
}

/** Human-readable byte size (binary units, 1 decimal above KB). */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

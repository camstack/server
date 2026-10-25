/**
 * config-blocks — the configuration-side blocks of a camera pipeline card:
 *
 *   PlacementBlock     — where each role (detection / decoder / audio /
 *                        source) runs, pinned-vs-auto badges, and the
 *                        detection pin control (assign/unassign).
 *   StreamsMotionBlock — streams used by detection & motion, FPS knobs,
 *                        motion sources, cooldown, source stream catalog.
 *   StepsBlock         — the resolved per-camera pipeline step tree
 *                        (object-detection model, face, plate, …) + audio
 *                        classification.
 */
import { Cpu, Film, Mic, Pin, Radio } from 'lucide-react'
import { motionSourceLabel } from '@camstack/types'
import type {
  CameraAssignmentStatus,
  CameraBrokerProfile,
  CameraSensorsStatus,
  CameraSourceStream,
} from '@camstack/types'
import { cameraSensorsSummary } from './camera-card-model'
import type { FlatPipelineStep, OrchestratorCameraSettings } from './camera-card-model'
import type { ClusterNodeOption } from './use-cameras-overview'
import { CardBlock, Chip, KVRow, StageInactive } from './card-primitives'
import { useTranslation } from 'react-i18next'
import i18n from '../../../i18n/index'

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

interface PlacementRoleRowProps {
  readonly icon: typeof Cpu
  readonly label: string
  readonly nodeId: string | null
  readonly pinned: boolean
  readonly reason: string | undefined
  readonly overridden: boolean
}

function PlacementRoleRow({
  icon: Icon,
  label,
  nodeId,
  pinned,
  reason,
  overridden,
}: PlacementRoleRowProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2 text-[11px] leading-snug min-w-0">
      <Icon className="h-3 w-3 text-foreground-subtle shrink-0" />
      <span className="text-foreground-subtle w-[4.5rem] shrink-0">{label}</span>
      {nodeId === null ? (
        <span className="text-foreground-subtle italic">
          {t('cameras.configBlocks.unassigned')}
        </span>
      ) : (
        <>
          <span className="font-mono text-foreground truncate" title={nodeId}>
            {nodeId}
          </span>
          {pinned ? (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] text-warning shrink-0"
              title={t('cameras.configBlocks.manuallyPinned', 'Manually pinned')}
            >
              <Pin className="h-2.5 w-2.5" /> {t('cameras.configBlocks.manual')}
            </span>
          ) : (
            <span className="text-[10px] text-foreground-subtle shrink-0 truncate">
              {t('cameras.configBlocks.autoReason', {
                reason:
                  reason !== undefined && reason.length > 0
                    ? reason
                    : t('cameras.configBlocks.capacity'),
              })}
            </span>
          )}
          {overridden && (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-warning shrink-0"
              title={t(
                'cameras.configBlocks.persistedSettingsPinForThis',
                'Persisted settings pin for this role',
              )}
            />
          )}
        </>
      )}
    </div>
  )
}

export interface PlacementBlockProps {
  readonly assignment: CameraAssignmentStatus
  readonly settings: OrchestratorCameraSettings
  readonly onlineNodes: readonly ClusterNodeOption[]
  readonly pinPending: boolean
  /** `'auto'` unpins (back to load-balanced); a node id pins detection there. */
  readonly onDetectionPinChange: (target: string) => void
}

export function PlacementBlock({
  assignment,
  settings,
  onlineNodes,
  pinPending,
  onDetectionPinChange,
}: PlacementBlockProps) {
  const { t } = useTranslation()
  const pinValue =
    assignment.pinned.detection && assignment.detectionNodeId !== null
      ? assignment.detectionNodeId
      : 'auto'
  const pinOptions = [
    ...new Set([
      ...(assignment.detectionNodeId !== null ? [assignment.detectionNodeId] : []),
      ...onlineNodes.map((node) => node.id),
    ]),
  ]

  return (
    <CardBlock title={t('cameras.configBlocks.whereItRuns', 'Where it runs')}>
      <PlacementRoleRow
        icon={Cpu}
        label={t('cameras.configBlocks.detection', 'Detection')}
        nodeId={assignment.detectionNodeId}
        pinned={assignment.pinned.detection}
        reason={assignment.reasons.detection}
        overridden={settings.overriddenKeys.has('pipelineNodeId')}
      />
      <PlacementRoleRow
        icon={Film}
        label={t('cameras.configBlocks.decoder', 'Decoder')}
        nodeId={assignment.decoderNodeId}
        pinned={assignment.pinned.decoder}
        reason={assignment.reasons.decoder}
        overridden={settings.overriddenKeys.has('decoderNodeId')}
      />
      <PlacementRoleRow
        icon={Mic}
        label={t('cameras.configBlocks.audio', 'Audio')}
        nodeId={assignment.audioNodeId}
        pinned={assignment.pinned.audio}
        reason={assignment.reasons.audio}
        overridden={settings.overriddenKeys.has('audioNodeId')}
      />
      <PlacementRoleRow
        icon={Radio}
        label={t('cameras.configBlocks.source', 'Source')}
        nodeId={assignment.sourceNodeId}
        pinned={false}
        reason="ingest owner"
        overridden={false}
      />
      <div className="mt-1.5">
        <select
          value={pinValue}
          disabled={pinPending}
          aria-label={t('cameras.configBlocks.detectionPlacementPin', 'Detection placement pin')}
          onChange={(event) => onDetectionPinChange(event.target.value)}
          className="w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground disabled:opacity-50"
        >
          <option value="auto">
            {t('cameras.configBlocks.autoLoadBalanced', 'Auto (load balanced)')}
          </option>
          {pinOptions.map((nodeId) => (
            <option key={nodeId} value={nodeId}>
              {t('cameras.configBlocks.pinDetection', {
                node: onlineNodes.find((node) => node.id === nodeId)?.name ?? nodeId,
              })}
            </option>
          ))}
        </select>
      </div>
    </CardBlock>
  )
}

// ---------------------------------------------------------------------------
// Streams & motion
// ---------------------------------------------------------------------------

function formatStream(stream: CameraSourceStream): string {
  // i18n-ignore: technical stream descriptor
  return `${stream.width}×${stream.height} ${stream.codec} @${stream.fps}fps`
}

function findProfile(
  profiles: readonly CameraBrokerProfile[] | undefined,
  profile: string | null,
): CameraBrokerProfile | undefined {
  if (profile === null || profiles === undefined) return undefined
  return profiles.find((entry) => entry.profile === profile)
}

function formatFpsSetting(fps: number | null): string {
  if (fps === null) return i18n.t('pipeline.configBlocks.fpsDefault')
  if (fps === 0) return i18n.t('pipeline.configBlocks.fpsNative')
  return `${fps} fps` // i18n-ignore: unit symbol
}

export interface StreamsMotionBlockProps {
  readonly streams: readonly CameraSourceStream[]
  readonly brokerProfiles: readonly CameraBrokerProfile[] | undefined
  readonly settings: OrchestratorCameraSettings
  readonly motionEnabled: boolean | null
  readonly motionFpsLive: number | null
  /** The camera's attached sensors (D672); `undefined` = an older orchestrator sent none. */
  readonly cameraSensors: CameraSensorsStatus | undefined
}

export function StreamsMotionBlock({
  streams,
  brokerProfiles,
  settings,
  motionEnabled,
  motionFpsLive,
  cameraSensors,
}: StreamsMotionBlockProps) {
  const { t } = useTranslation()
  const detectionProfile = findProfile(brokerProfiles, settings.detectionStreamProfile)
  const motionProfile = findProfile(brokerProfiles, settings.motionStreamProfile)
  const analyzerActive = settings.motionSources.includes('analyzer')

  return (
    <CardBlock title={t('cameras.configBlocks.streamsMotion', 'Streams & motion')}>
      <KVRow
        label={t('cameras.configBlocks.detectStream', 'Detect stream')}
        overridden={settings.overriddenKeys.has('detectionStreamProfile')}
      >
        {settings.detectionStreamProfile ?? '—'}
        {detectionProfile !== undefined &&
          ` · ${detectionProfile.width}×${detectionProfile.height} ${detectionProfile.codec}`}
      </KVRow>
      <KVRow
        label={t('cameras.configBlocks.detectFps', 'Detect FPS')}
        overridden={settings.overriddenKeys.has('detectionFps')}
      >
        {formatFpsSetting(settings.detectionFps)}
      </KVRow>
      <KVRow
        label={t('cameras.configBlocks.motionSrc', 'Motion src')}
        overridden={settings.overriddenKeys.has('motionSources')}
      >
        {settings.motionSources.length > 0
          ? settings.motionSources.map(motionSourceLabel).join(' + ')
          : t('cameras.configBlocks.none')}
        {motionEnabled === false && ` · ${t('cameras.configBlocks.inactive')}`}
      </KVRow>
      <KVRow label={t('cameras.configBlocks.cameraSensors', 'Camera sensors')}>
        {cameraSensorsSummary(cameraSensors)}
      </KVRow>
      {analyzerActive && (
        <>
          <KVRow
            label={t('cameras.configBlocks.motionStream', 'Motion stream')}
            overridden={settings.overriddenKeys.has('motionStreamProfile')}
          >
            {settings.motionStreamProfile ?? '—'}
            {motionProfile !== undefined &&
              ` · ${motionProfile.width}×${motionProfile.height} ${motionProfile.codec}`}
          </KVRow>
          <KVRow
            label={t('cameras.configBlocks.motionFps', 'Motion FPS')}
            overridden={settings.overriddenKeys.has('motionFps')}
          >
            {formatFpsSetting(settings.motionFps)}
            {motionFpsLive !== null &&
              ` · ${t('cameras.configBlocks.liveFps', { fps: motionFpsLive.toFixed(1) })}`}
          </KVRow>
        </>
      )}
      <KVRow
        label={t('cameras.configBlocks.cooldown', 'Cooldown')}
        overridden={settings.overriddenKeys.has('motionCooldownMs')}
      >
        {settings.motionCooldownMs !== null
          ? `${settings.motionCooldownMs / 1000}s`
          : t('cameras.configBlocks.defaultValue')}
      </KVRow>
      <div className="mt-1.5 flex flex-col gap-0.5">
        {streams.length === 0 ? (
          <StageInactive>
            {t('cameras.configBlocks.noStreamsRegistered', 'No streams registered')}
          </StageInactive>
        ) : (
          streams.map((stream) => (
            <div
              key={stream.camStreamId}
              className="text-[10px] font-mono text-foreground-subtle truncate"
              title={stream.camStreamId}
            >
              <span className="text-foreground-muted">{stream.kind}</span> {formatStream(stream)}
            </div>
          ))
        )}
      </div>
    </CardBlock>
  )
}

// ---------------------------------------------------------------------------
// Pipeline steps
// ---------------------------------------------------------------------------

export interface StepsBlockProps {
  /** Undefined while `resolvePipeline` is in flight. */
  readonly steps: readonly FlatPipelineStep[] | undefined
  readonly audioModelId: string | null
  readonly audioEnabled: boolean | null
  readonly audioMode: string | null
}

export function StepsBlock({ steps, audioModelId, audioEnabled, audioMode }: StepsBlockProps) {
  const { t } = useTranslation()
  return (
    <CardBlock title={t('cameras.configBlocks.pipelineSteps', 'Pipeline steps')}>
      {steps === undefined ? (
        <StageInactive>{t('cameras.configBlocks.resolving', 'Resolving…')}</StageInactive>
      ) : steps.length === 0 ? (
        <StageInactive>
          {t('cameras.configBlocks.noStepsConfigured', 'No steps configured')}
        </StageInactive>
      ) : (
        <div className="flex flex-wrap gap-1">
          {steps.map((step, index) => (
            <Chip
              key={`${step.addonId}-${index}`}
              tone={step.enabled ? (step.depth === 0 ? 'info' : 'neutral') : 'neutral'}
              title={step.modelId ?? step.addonId}
            >
              <span className={step.enabled ? '' : 'line-through opacity-60'}>
                {step.depth > 0 && <span className="opacity-50">↳ </span>}
                {step.addonId}
                {step.modelId !== null && (
                  <span className="font-mono opacity-75"> · {step.modelId}</span>
                )}
              </span>
            </Chip>
          ))}
        </div>
      )}
      <div className="mt-1">
        <KVRow label={t('cameras.configBlocks.audioClass', 'Audio class.')}>
          {audioMode ?? '—'}
          {audioEnabled !== null &&
            ` · ${audioEnabled ? t('cameras.configBlocks.running') : t('cameras.configBlocks.off')}`}
          {audioModelId !== null && ` · ${audioModelId}`}
        </KVRow>
      </div>
    </CardBlock>
  )
}

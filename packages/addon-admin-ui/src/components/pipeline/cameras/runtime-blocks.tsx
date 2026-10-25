/**
 * runtime-blocks — the live-telemetry blocks of a camera pipeline card:
 *
 *   DetectionBlock — phase, actual/configured fps, inference time, queue
 *                    depth, engine, provisioning. Numbers prefer the 1 Hz
 *                    live snapshot over the 5 s polled aggregate.
 *   BrokerBlock    — per-profile stream broker status (streaming/idle,
 *                    received fps — "—" when unknown —, subscribers), WebRTC
 *                    sessions, restream. No output fps: the broker decodes
 *                    nothing (D758).
 *   DecoderBlock   — the node decode runs on.
 *
 * The black-hole signature (active phase, 0 fps / 0 frames written) renders
 * its numbers in the danger color so the stall is visible inside the block
 * as well as in the card-level problem banner.
 */
import { getPhaseVisual, PhaseIcon, useUiText } from '@camstack/ui-library'
import type {
  CameraBrokerStatus,
  CameraDecoderStatus,
  CameraDetectionStatus,
} from '@camstack/types'
import type { LiveDetectionMetrics } from './use-cameras-overview'
import { CardBlock, Chip, KVRow, StageInactive } from './card-primitives'
import type { ChipTone } from './card-primitives'
import { useTranslation } from 'react-i18next'

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const PROVISIONING_TONE: Record<string, ChipTone> = {
  ready: 'success',
  installing: 'info',
  verifying: 'info',
  idle: 'neutral',
  failed: 'danger',
}

export interface DetectionBlockProps {
  readonly detection: CameraDetectionStatus | null
  readonly live: LiveDetectionMetrics | undefined
  readonly detectionMode: string | null
  readonly modeOverridden: boolean
}

export function DetectionBlock({
  detection,
  live,
  detectionMode,
  modeOverridden,
}: DetectionBlockProps) {
  const uiText = useUiText()
  const { t } = useTranslation()
  if (detection === null) {
    return (
      <CardBlock title={t('cameras.runtimeBlocks.detectionRuntime', 'Detection runtime')}>
        <KVRow label={t('cameras.runtimeBlocks.mode', 'Mode')} overridden={modeOverridden}>
          {detectionMode ?? '—'}
        </KVRow>
        <StageInactive>
          {t(
            'cameras.runtimeBlocks.detectionStageInactiveOrUnreachable',
            'Detection stage inactive or unreachable',
          )}
        </StageInactive>
      </CardBlock>
    )
  }

  // Prefer the 1 Hz live snapshot when present — it is fresher than the
  // 5 s polled aggregate and evicted automatically when it goes stale.
  const phase = live?.phase ?? detection.phase
  const actualFps = live?.actualFps ?? detection.actualFps
  const configuredFps = live?.configuredFps ?? detection.configuredFps
  const avgInferenceMs = live?.avgInferenceTimeMs ?? detection.avgInferenceMs
  const queueDepth = live?.queueDepth ?? detection.queueDepth

  const phaseCfg = getPhaseVisual(phase, uiText)
  const blackHole = phase === 'active' && actualFps === 0

  return (
    <CardBlock title={t('cameras.runtimeBlocks.detectionRuntime', 'Detection runtime')}>
      <div className="flex items-center gap-1.5 mb-0.5">
        <span
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider ${phaseCfg.badgeClass}`}
        >
          <PhaseIcon phase={phase} className="h-2.5 w-2.5" />
          {phaseCfg.label}
        </span>
        {live !== undefined && (
          <span className="text-[9px] text-foreground-subtle uppercase tracking-wider">
            {t('common.live')}
          </span>
        )}
      </div>
      <KVRow label={t('cameras.runtimeBlocks.mode', 'Mode')} overridden={modeOverridden}>
        {detectionMode ?? '—'}
      </KVRow>
      <KVRow label="FPS">
        <span className={blackHole ? 'text-danger font-semibold' : ''}>{actualFps.toFixed(1)}</span>
        <span className="ml-1 text-foreground-subtle">
          {t('cameras.runtimeBlocks.configuredFps', { fps: configuredFps.toFixed(0) })}
        </span>
      </KVRow>
      <KVRow label={t('cameras.runtimeBlocks.inference', 'Inference')}>
        {avgInferenceMs.toFixed(0)} ms
        {queueDepth > 0 && (
          <span className="ml-1 text-warning">
            {t('cameras.runtimeBlocks.queue', { depth: queueDepth })}
          </span>
        )}
        {live !== undefined && live.droppedFrames > 0 && (
          <span className="ml-1 text-warning">
            {t('cameras.runtimeBlocks.drops', { count: live.droppedFrames })}
          </span>
        )}
      </KVRow>
      <KVRow label={t('cameras.runtimeBlocks.engine', 'Engine')}>
        {detection.engine.backend} · {detection.engine.device}
      </KVRow>
      <KVRow label={t('cameras.runtimeBlocks.provisioning', 'Provisioning')}>
        <Chip tone={PROVISIONING_TONE[detection.provisioning.state] ?? 'neutral'}>
          {detection.provisioning.state}
        </Chip>
        {detection.provisioning.error !== undefined && (
          <span className="text-danger text-[10px]"> {detection.provisioning.error}</span>
        )}
      </KVRow>
    </CardBlock>
  )
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

export interface BrokerBlockProps {
  readonly broker: CameraBrokerStatus | null
}

export function BrokerBlock({ broker }: BrokerBlockProps) {
  const { t } = useTranslation()
  if (broker === null) {
    return (
      <CardBlock title={t('cameras.runtimeBlocks.streamBroker', 'Stream broker')}>
        <StageInactive>
          {t(
            'cameras.runtimeBlocks.brokerStageInactiveOrUnreachable',
            'Broker stage inactive or unreachable',
          )}
        </StageInactive>
      </CardBlock>
    )
  }

  return (
    <CardBlock title={t('cameras.runtimeBlocks.streamBroker', 'Stream broker')}>
      {broker.profiles.length === 0 ? (
        <StageInactive>
          {t('cameras.runtimeBlocks.noBrokerProfiles', 'No broker profiles')}
        </StageInactive>
      ) : (
        <div className="flex flex-col gap-1">
          {broker.profiles.map((profile) => {
            const streaming = profile.status === 'streaming'
            const stalled = streaming && profile.inFps === 0
            return (
              <div
                key={profile.profile}
                className="flex items-center gap-2 text-[11px] font-mono tabular-nums min-w-0"
              >
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
                    stalled ? 'bg-danger' : streaming ? 'bg-success animate-pulse' : 'bg-border'
                  }`}
                  title={profile.status}
                />
                <span className="text-foreground w-10 shrink-0 truncate" title={profile.profile}>
                  {profile.profile}
                </span>
                <span className="text-foreground-subtle truncate">
                  {profile.width}×{profile.height} {profile.codec}
                </span>
                <span className={`ml-auto shrink-0 ${stalled ? 'text-danger' : 'text-foreground'}`}>
                  {t('cameras.runtimeBlocks.fpsValue', {
                    value: profile.inFps === null ? '—' : profile.inFps.toFixed(0),
                  })}
                </span>
                <span
                  className="text-foreground-subtle shrink-0"
                  title={t('cameras.runtimeBlocks.subscribers', 'Subscribers')}
                >
                  ×{profile.subscribers}
                </span>
              </div>
            )
          })}
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1">
        <Chip tone={broker.webrtcSessions > 0 ? 'info' : 'neutral'}>
          {t('cameras.runtimeBlocks.webrtc', { count: broker.webrtcSessions })}
        </Chip>
        <Chip tone={broker.rtspRestream ? 'success' : 'neutral'}>
          {broker.rtspRestream
            ? t('cameras.runtimeBlocks.restreamOn')
            : t('cameras.runtimeBlocks.restreamOff')}
        </Chip>
      </div>
    </CardBlock>
  )
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

export interface DecoderBlockProps {
  readonly decoder: CameraDecoderStatus | null
}

/**
 * Where decode runs. No frame counter: whether frames flow is the detection
 * block's FPS (frames delivered to the detector) and its black-hole alert.
 */
export function DecoderBlock({ decoder }: DecoderBlockProps) {
  const { t } = useTranslation()
  if (decoder === null) {
    return (
      <CardBlock title={t('cameras.runtimeBlocks.decoder', 'Decoder')}>
        <StageInactive>
          {t(
            'cameras.runtimeBlocks.decoderStageInactiveOrUnreachable',
            'Decoder stage inactive or unreachable',
          )}
        </StageInactive>
      </CardBlock>
    )
  }

  return (
    <CardBlock title={t('cameras.runtimeBlocks.decoder', 'Decoder')}>
      <KVRow label={t('cameras.runtimeBlocks.node', 'Node')}>{decoder.nodeId}</KVRow>
    </CardBlock>
  )
}

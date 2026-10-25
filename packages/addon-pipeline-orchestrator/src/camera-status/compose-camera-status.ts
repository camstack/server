/**
 * Pure composer for the per-camera status aggregator.
 *
 * `composeCameraStatus(input: ComposeInput): CameraStatus`
 *
 * - No side effects (no Date.now(), no randomness).
 * - Caller provides `fetchedAt` (ms timestamp).
 * - Each nullable stage input maps to a nullable output block.
 *   A null stage → that block is null (graceful degradation).
 * - `assignment` and `source` are always present.
 * - Missing nested numbers default to 0; missing arrays to [].
 *
 * See spec: docs/superpowers/specs/2026-06-24-camera-status-aggregator-cap.md
 * See brief: .superpowers/sdd/task-2-brief.md
 */

import type {
  CameraSensorsStatus,
  CameraStatus,
  CameraStatusDegradation,
  CameraSwitchId,
  CameraAssignmentStatus,
  CameraSourceStatus,
  CameraSourceStream,
  CameraBrokerStatus,
  CameraBrokerProfile,
  CameraDecoderStatus,
  CameraMotionStatus,
  CameraDetectionStatus,
  CameraDetectionProvisioning,
  CameraDetectionPhase,
  CameraDetectionProvisioningState,
  CameraAudioStatus,
  CameraRecordingStatus,
  CameraRecordingMode,
} from '@camstack/types'

// ── Stage result types ────────────────────────────────────────────────────────
// Each type mirrors the fields the implementation (Task 3) will collect from
// the relevant source cap. They are intentionally flat — the composer never
// reaches into nested source structures; instead it maps source fields to the
// output contract fields and defaults missing numbers to 0 / arrays to [].

/** Stream entry collected from the stream-catalog for one device. */
export interface SourceStreamEntry {
  readonly camStreamId: string
  readonly codec: string
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly kind: string
}

/** Result from the stream-catalog stage. */
export interface SourceResult {
  readonly streams: readonly SourceStreamEntry[]
}

/** Profile slot entry collected from the broker stage. */
export interface BrokerProfileEntry {
  readonly profile: string
  readonly status: string
  readonly codec: string
  readonly width: number
  readonly height: number
  readonly subscribers: number
  /** null when the broker stats read failed — unknown, never 0. */
  readonly inFps: number | null
}

/** Result from the stream-broker stage. */
export interface BrokerResult {
  readonly profiles: readonly BrokerProfileEntry[]
  readonly webrtcSessions: number
  readonly rtspRestream: boolean
}

/** Result from the decoder stage: the node decode runs on, nothing else. */
export interface DecoderResult {
  readonly nodeId: string
}

/** Result from the motion-detection stage. */
export interface MotionResult {
  readonly enabled: boolean
  readonly fps: number
}

/** Provisioning sub-object from the detection/pipeline-executor stage. */
export interface DetectionProvisioningEntry {
  readonly state: CameraDetectionProvisioningState
  readonly error?: string
}

/** Detection engine backend/device pair collected from the pipeline-executor stage. */
export interface DetectionEngineEntry {
  readonly backend: string
  readonly device: string
}

/** Result from the detection (pipeline-executor) stage. */
export interface DetectionResult {
  readonly nodeId: string
  readonly engine: DetectionEngineEntry
  readonly phase: CameraDetectionPhase
  readonly configuredFps: number
  readonly actualFps: number
  readonly queueDepth: number
  readonly avgInferenceMs: number
  readonly provisioning: DetectionProvisioningEntry
}

/** Result from the audio-analyzer stage. */
export interface AudioResult {
  readonly nodeId: string
  readonly enabled: boolean
}

/** Result from the recording stage. */
export interface RecordingResult {
  readonly mode: CameraRecordingMode
  readonly active: boolean
  readonly storageBytes: number
}

// ── ComposeInput ──────────────────────────────────────────────────────────────

/** Whether each assignment slot (detection/decoder/audio) is manually pinned. */
export interface AssignmentPinFlags {
  readonly detection: boolean
  readonly decoder: boolean
  readonly audio: boolean
}

/** Human-readable reason strings for each assignment slot (all optional). */
export interface AssignmentReasons {
  readonly detection?: string
  readonly decoder?: string
  readonly audio?: string
}

/**
 * All inputs the pure composer needs to produce a `CameraStatus`.
 *
 * Assignment fields are orchestrator-local (no remote call).
 * Stage results are the bounded-parallel fetch outputs from Task 3;
 * null = stage timed-out / errored / inactive.
 */
export interface ComposeInput {
  /** The device being described. */
  readonly deviceId: number
  /** Unix timestamp (ms) when the snapshot composition started — passed in, never Date.now(). */
  readonly fetchedAt: number

  // ── Assignment (orchestrator-local, always available) ──────────────────
  readonly detectionNodeId: string | null
  readonly decoderNodeId: string | null
  readonly audioNodeId: string | null
  /** The camera's source-owner node (cluster ingest owner today). */
  readonly sourceNodeId: string | null
  readonly pinned: AssignmentPinFlags
  readonly reasons: AssignmentReasons

  // ── Per-stage results (null = inactive / unreachable) ──────────────────
  readonly sourceResult: SourceResult | null
  readonly brokerResult: BrokerResult | null
  readonly decoderResult: DecoderResult | null
  readonly motionResult: MotionResult | null
  readonly detectionResult: DetectionResult | null
  readonly audioResult: AudioResult | null
  readonly recordingResult: RecordingResult | null

  /**
   * Function switches an OPERATOR turned off (D61). Empty when nothing is off.
   *
   * This is what separates DISABLED from BROKEN on a status surface: a camera
   * with no detections and `['object-detection']` here was switched off; the
   * same camera with an empty list is failing — UNLESS `degraded` names
   * `'switches'`, in which case the list is empty because the read was cut
   * short and it supports no conclusion at all. Composed by the caller straight
   * from the AUTHORITIES (`readSwitchAuthorities` + the pure
   * `composeSwitchedOff`, D113) — never from the deprecated switch group cap,
   * which is scheduled for deletion and would take this badge with it. An
   * authority that did not answer yields an empty list plus a `'switches'`
   * degradation, never a guess.
   */
  readonly switchedOff: readonly CameraSwitchId[]

  /**
   * The camera's attached sensors (D672), passed through verbatim from the
   * camera-sensors controller's memory. `unreadable` before the first answered
   * settings read — never `not-configured` (D315).
   */
  readonly cameraSensors: CameraSensorsStatus

  /**
   * Stages the caller's bounded fan-out could not read (timeout or rejection).
   * Passed through verbatim: the composer never decides what degraded, it only
   * carries what the bound observed.
   */
  readonly degraded: readonly CameraStatusDegradation[]
}

// ── Internal mappers ──────────────────────────────────────────────────────────

function mapAssignment(input: ComposeInput): CameraAssignmentStatus {
  return {
    detectionNodeId: input.detectionNodeId,
    decoderNodeId: input.decoderNodeId,
    audioNodeId: input.audioNodeId,
    sourceNodeId: input.sourceNodeId,
    pinned: {
      detection: input.pinned.detection,
      decoder: input.pinned.decoder,
      audio: input.pinned.audio,
    },
    reasons: {
      detection: input.reasons.detection,
      decoder: input.reasons.decoder,
      audio: input.reasons.audio,
    },
  }
}

function mapSource(sourceResult: SourceResult | null): CameraSourceStatus {
  if (sourceResult === null) {
    return { streams: [] }
  }
  const streams: CameraSourceStream[] = sourceResult.streams.map(
    (s): CameraSourceStream => ({
      camStreamId: s.camStreamId,
      codec: s.codec,
      width: s.width,
      height: s.height,
      fps: s.fps,
      kind: s.kind,
    }),
  )
  return { streams }
}

function mapBroker(brokerResult: BrokerResult | null): CameraBrokerStatus | null {
  if (brokerResult === null) {
    return null
  }
  const profiles: CameraBrokerProfile[] = brokerResult.profiles.map(
    (p): CameraBrokerProfile => ({
      profile: p.profile,
      status: p.status,
      codec: p.codec,
      width: p.width,
      height: p.height,
      subscribers: p.subscribers,
      inFps: p.inFps,
    }),
  )
  return {
    profiles,
    webrtcSessions: brokerResult.webrtcSessions,
    rtspRestream: brokerResult.rtspRestream,
  }
}

function mapDecoder(decoderResult: DecoderResult | null): CameraDecoderStatus | null {
  if (decoderResult === null) {
    return null
  }
  return { nodeId: decoderResult.nodeId }
}

function mapMotion(motionResult: MotionResult | null): CameraMotionStatus | null {
  if (motionResult === null) {
    return null
  }
  return {
    enabled: motionResult.enabled,
    fps: motionResult.fps,
  }
}

function mapProvisioning(p: DetectionProvisioningEntry): CameraDetectionProvisioning {
  if (p.error !== undefined) {
    return { state: p.state, error: p.error }
  }
  return { state: p.state }
}

function mapDetection(detectionResult: DetectionResult | null): CameraDetectionStatus | null {
  if (detectionResult === null) {
    return null
  }
  const phase: CameraDetectionPhase = detectionResult.phase
  return {
    nodeId: detectionResult.nodeId,
    engine: {
      backend: detectionResult.engine.backend,
      device: detectionResult.engine.device,
    },
    phase,
    configuredFps: detectionResult.configuredFps,
    actualFps: detectionResult.actualFps,
    queueDepth: detectionResult.queueDepth,
    avgInferenceMs: detectionResult.avgInferenceMs,
    provisioning: mapProvisioning(detectionResult.provisioning),
  }
}

function mapAudio(audioResult: AudioResult | null): CameraAudioStatus | null {
  if (audioResult === null) {
    return null
  }
  return {
    nodeId: audioResult.nodeId,
    enabled: audioResult.enabled,
  }
}

function mapRecording(recordingResult: RecordingResult | null): CameraRecordingStatus | null {
  if (recordingResult === null) {
    return null
  }
  const mode: CameraRecordingMode = recordingResult.mode
  return {
    mode,
    active: recordingResult.active,
    storageBytes: recordingResult.storageBytes,
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Pure function that composes a `CameraStatus` from per-stage fetch results.
 *
 * - `assignment` is always built from orchestrator-local data (never null).
 * - `source` always present: defaults to `{ streams: [] }` when sourceResult is null.
 * - Every other block is null when its stage result is null (graceful degradation).
 * - `fetchedAt` is stamped exactly as provided — never calls `Date.now()`.
 * - No mutation of the input.
 */
export function composeCameraStatus(input: ComposeInput): CameraStatus {
  return {
    deviceId: input.deviceId,
    assignment: mapAssignment(input),
    source: mapSource(input.sourceResult),
    broker: mapBroker(input.brokerResult),
    decoder: mapDecoder(input.decoderResult),
    motion: mapMotion(input.motionResult),
    detection: mapDetection(input.detectionResult),
    audio: mapAudio(input.audioResult),
    recording: mapRecording(input.recordingResult),
    switchedOff: input.switchedOff,
    cameraSensors: input.cameraSensors,
    degraded: input.degraded,
    fetchedAt: input.fetchedAt,
  }
}

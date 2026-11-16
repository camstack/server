/**
 * Health digest (planning#572, first slice) — turns state the orchestrator
 * ALREADY holds in memory into findings an operator can act on.
 *
 * Pure: a snapshot goes in, a {@link HealthDigest} comes out. The tick that
 * gathers the snapshot makes no log scan, no database read and no cross-node
 * call (operator direction 2026-11-15: every 5 minutes, and light). A value
 * that could not be read is `null`, never `0` (D393), and a source that failed
 * to read produces no findings rather than invented ones.
 */
import type {
  CameraPhase,
  HealthDigest,
  HealthFinding,
  HealthNodeSummary,
  HealthSourceStatus,
  PlacementNodeStats,
} from '@camstack/types'
import type { BlindCameraSnapshot } from './detection-blind-monitor.js'
import type { UnusableInferenceDevice } from './inference-device-usability-mirror.js'

/** The digest runs this often. */
export const HEALTH_DIGEST_INTERVAL_MS = 5 * 60_000
/** Digests kept in memory (two hours at the tick rate). */
export const HEALTH_DIGEST_KEEP = 24
/** A metrics sample older than this is not judged. */
export const HEALTH_METRICS_FRESH_MS = 10 * 60_000
/** Sessions opened in the window with no detection at all that make motion "many". */
export const HEALTH_MOTION_SESSIONS = 20
/** Below-floor frames since the last detection that make "all under the floor" a finding. */
export const HEALTH_BELOW_FLOOR_FRAMES = 10
/** Fraction of the configured fps below which the latency is critical. */
export const HEALTH_CRITICAL_FPS_FRACTION = 0.5

export interface CameraMetricsSample {
  readonly phase: CameraPhase
  readonly configuredFps: number
  readonly actualFps: number
  readonly avgInferenceTimeMs: number
  readonly queueDepth: number
  readonly droppedFrames: number
  readonly lastSeen: number
  /**
   * Frames dropped since the previous tick. `droppedFrames` on the wire is a
   * monotonic counter since attach (runner frame queues), so only the delta is
   * a signal. `null` = first sample or a counter reset: unknown, not zero.
   */
  readonly droppedSincePreviousTick: number | null
}

export interface CameraHealthState {
  readonly deviceId: number
  /** `null` = the monitor holds nothing for this camera. */
  readonly motion: Omit<BlindCameraSnapshot, 'deviceId'> | null
  /** `null` = no metrics sample was ever received. */
  readonly metrics: CameraMetricsSample | null
}

export interface HealthDigestState {
  readonly now: number
  readonly cameras: readonly CameraHealthState[]
  /** Entries the motion / metrics reads returned; `null` = the read failed (D393). */
  readonly motionEntries: number | null
  readonly metricsEntries: number | null
  /** `null` = the read failed. */
  readonly placement: readonly PlacementNodeStats[] | null
  /** `null` = the read failed. */
  readonly unusableDevices: readonly UnusableInferenceDevice[] | null
}

const NOT_COVERED: readonly string[] = [
  'decode hwaccel fallback on every session start: the counter lives in the stream-broker/decoder process, no orchestrator-side source',
  'births tossed before a track and crop misses (worker-lease-gone): runner-side counters, not mirrored in the orchestrator',
  'stationary registry absorbing most detections: runner-side registry, not mirrored in the orchestrator',
  'which model runs on which inference device: only a cross-node cap call answers it, not allowed on a light tick',
]

function motionFindings(c: CameraHealthState, now: number): readonly HealthFinding[] {
  const m = c.motion
  if (m === null || !m.motionKnown) return []
  const subject = { type: 'camera', deviceId: c.deviceId } as const
  const out: HealthFinding[] = []
  const detectedRecently = m.lastDetectionAt !== null && now - m.lastDetectionAt < 60 * 60_000
  if (m.belowFloorFrames >= HEALTH_BELOW_FLOOR_FRAMES && !detectedRecently) {
    out.push({
      id: `detections-under-floor:${c.deviceId}`,
      kind: 'detections-under-floor',
      severity: 'warning',
      subject,
      what: 'The detector sees candidates on this camera but every one is below its class floor.',
      evidence: { belowFloorFrames: m.belowFloorFrames, sessionsInWindow: m.sessionsInWindow },
      action:
        'Check the class floors for this camera (a lower floor, or a better model); open a track in debug to see the discarded scores.',
    })
  } else if (m.sessionsInWindow >= HEALTH_MOTION_SESSIONS && !detectedRecently) {
    out.push({
      id: `motion-without-detections:${c.deviceId}`,
      kind: 'motion-without-detections',
      severity: 'warning',
      subject,
      what: 'Motion keeps starting detection sessions on this camera and none produced a detection.',
      evidence: {
        sessionsInWindow: m.sessionsInWindow,
        dutyInWindow: m.dutyInWindow,
        framesSinceOutput: m.framesSinceOutput,
      },
      action:
        'Tighten the motion source or its zones (wind, trees, lights), or confirm the camera view is not blocked.',
    })
  }
  return out
}

function metricsFindings(c: CameraHealthState, now: number): readonly HealthFinding[] {
  const m = c.metrics
  if (m === null || m.phase !== 'active' || now - m.lastSeen > HEALTH_METRICS_FRESH_MS) return []
  const subject = { type: 'camera', deviceId: c.deviceId } as const
  const out: HealthFinding[] = []
  if (m.avgInferenceTimeMs > 0 && m.configuredFps > 0) {
    const allowedFps = 1000 / m.avgInferenceTimeMs
    if (allowedFps < m.configuredFps) {
      out.push({
        id: `inference-too-slow:${c.deviceId}`,
        kind: 'inference-too-slow',
        severity:
          allowedFps < m.configuredFps * HEALTH_CRITICAL_FPS_FRACTION ? 'critical' : 'warning',
        subject,
        what: 'Inference takes longer than the frame rate this camera is configured for allows.',
        evidence: {
          allowedFps,
          configuredFps: m.configuredFps,
          actualFps: m.actualFps,
          avgInferenceTimeMs: m.avgInferenceTimeMs,
        },
        action:
          'Lower the camera detection fps, pick a faster model, or move the camera to a faster inference device.',
      })
    }
  }
  if (m.droppedSincePreviousTick !== null && m.droppedSincePreviousTick > 0 && m.queueDepth > 0) {
    out.push({
      id: `frames-shed:${c.deviceId}`,
      kind: 'frames-shed',
      severity: 'warning',
      subject,
      what: 'The worker is saturated: frames are being shed while a backlog waits.',
      evidence: {
        droppedSincePreviousTick: m.droppedSincePreviousTick,
        droppedFramesTotal: m.droppedFrames,
        queueDepth: m.queueDepth,
        actualFps: m.actualFps,
      },
      action: 'Move cameras off this device, add an inference device, or lower detection fps.',
    })
  }
  return out
}

function deviceFindings(unusable: readonly UnusableInferenceDevice[]): readonly HealthFinding[] {
  return unusable.map((d) => ({
    id: `inference-device-unusable:${d.nodeId}:${d.deviceKey}`,
    kind: 'inference-device-unusable' as const,
    severity: 'critical' as const,
    subject: { type: 'inference-device' as const, nodeId: d.nodeId, deviceKey: d.deviceKey },
    what: 'The balancer excludes this inference device: it stopped answering usably.',
    evidence: {},
    action: 'Check the device and driver on the node; sessions run on its other devices meanwhile.',
  }))
}

function nodeSummaries(
  placement: readonly PlacementNodeStats[],
  unusable: readonly UnusableInferenceDevice[] | null,
): readonly HealthNodeSummary[] {
  const bad = unusable ?? []
  return placement.map((n) => ({
    nodeId: n.nodeId,
    sessionsNow: n.sessionsNow,
    unusableDevices: bad.filter((d) => d.nodeId === n.nodeId).map((d) => d.deviceKey),
    devices: n.devices.map((d) => ({
      deviceKey: d.deviceKey,
      sessionsNow: d.sessionsNow,
      usable: !bad.some((b) => b.nodeId === n.nodeId && b.deviceKey === d.deviceKey),
    })),
  }))
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const

export function buildHealthDigest(state: HealthDigestState, tickMs: number): HealthDigest {
  const findings: HealthFinding[] = []
  for (const c of state.cameras) {
    findings.push(...motionFindings(c, state.now), ...metricsFindings(c, state.now))
  }
  if (state.unusableDevices !== null) findings.push(...deviceFindings(state.unusableDevices))
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const sources: HealthSourceStatus[] = [
    { source: 'motion', entries: state.motionEntries },
    { source: 'metrics', entries: state.metricsEntries },
    { source: 'placement', entries: state.placement === null ? null : state.placement.length },
    {
      source: 'inference-device-usability',
      entries: state.unusableDevices === null ? null : state.unusableDevices.length,
    },
  ]
  return {
    generatedAt: state.now,
    tickMs,
    camerasSeen:
      state.motionEntries === null || state.metricsEntries === null ? null : state.cameras.length,
    findings,
    nodes: state.placement === null ? [] : nodeSummaries(state.placement, state.unusableDevices),
    sources,
    notCovered: NOT_COVERED,
  }
}

/** Bounded in-memory history of digests, newest first. */
export class HealthDigestKeeper {
  private digests: readonly HealthDigest[] = []

  constructor(private readonly keep: number = HEALTH_DIGEST_KEEP) {}

  push(digest: HealthDigest): void {
    this.digests = [digest, ...this.digests].slice(0, this.keep)
  }

  latest(): HealthDigest | null {
    return this.digests[0] ?? null
  }

  recent(count: number): readonly HealthDigest[] {
    return this.digests.slice(0, count)
  }
}

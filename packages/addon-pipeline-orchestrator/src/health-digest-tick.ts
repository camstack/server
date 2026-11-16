/**
 * The health digest tick (planning#572): every {@link HEALTH_DIGEST_INTERVAL_MS}
 * read the orchestrator's own in-memory state, build the digest, keep a bounded
 * history, and log what the tick cost and what changed.
 *
 * LIGHT by construction (operator direction 2026-11-15): the only inputs are
 * synchronous reads of maps the process already holds — the blind monitor, the
 * metrics mirror, the placement stats and the inference-device usability
 * mirror. No log scan, no database read, no cross-node call. The tick reports
 * its own cost (`tickMs`) and how many reads it made (`calls`).
 */
import type {
  CameraMetrics,
  HealthDigest,
  IScopedLogger,
  PlacementNodeStats,
} from '@camstack/types'
import type { BlindCameraSnapshot } from './detection-blind-monitor.js'
import {
  buildHealthDigest,
  HealthDigestKeeper,
  type CameraMetricsSample,
  type HealthDigestState,
} from './health-digest.js'
import type { UnusableInferenceDevice } from './inference-device-usability-mirror.js'

/** Latest metrics per camera, stamped on arrival. One entry per camera: bounded. */
export class CameraMetricsMirror {
  private readonly samples = new Map<number, CameraMetricsSample>()

  note(deviceId: number, metrics: CameraMetrics, at: number): void {
    this.samples.set(deviceId, {
      phase: metrics.phase,
      configuredFps: metrics.configuredFps,
      actualFps: metrics.actualFps,
      avgInferenceTimeMs: metrics.avgInferenceTimeMs,
      queueDepth: metrics.queueDepth,
      droppedFrames: metrics.droppedFrames,
      lastSeen: at,
    })
  }

  view(): ReadonlyMap<number, CameraMetricsSample> {
    return this.samples
  }

  forget(deviceId: number): void {
    this.samples.delete(deviceId)
  }

  reset(): void {
    this.samples.clear()
  }
}

export interface HealthTickDeps {
  readonly now: () => number
  readonly readMotion: (now: number) => readonly BlindCameraSnapshot[]
  readonly readMetrics: () => ReadonlyMap<number, CameraMetricsSample>
  readonly readPlacement: () => readonly PlacementNodeStats[]
  readonly readUnusableDevices: () => readonly UnusableInferenceDevice[]
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
}

/** Run one read; a throw is a `null` read (D393), logged, never a zero. */
function attempt<T>(
  deps: HealthTickDeps,
  source: string,
  read: () => T,
): { readonly value: T | null } {
  try {
    return { value: read() }
  } catch (err) {
    deps.logger.warn('health digest: source unreadable', {
      meta: { source, error: err instanceof Error ? err.message : String(err) },
    })
    return { value: null }
  }
}

export class HealthDigestTick {
  private readonly keeper: HealthDigestKeeper
  private previousIds = new Map<string, number | null>()

  constructor(
    private readonly deps: HealthTickDeps,
    keeper: HealthDigestKeeper = new HealthDigestKeeper(),
  ) {
    this.keeper = keeper
  }

  latest(): HealthDigest | null {
    return this.keeper.latest()
  }

  recent(count: number): readonly HealthDigest[] {
    return this.keeper.recent(count)
  }

  run(): HealthDigest {
    const started = this.deps.now()
    const motion = attempt(this.deps, 'motion', () => this.deps.readMotion(started))
    const metrics = attempt(this.deps, 'metrics', () => this.deps.readMetrics())
    const placement = attempt(this.deps, 'placement', () => this.deps.readPlacement())
    const unusable = attempt(this.deps, 'inference-device-usability', () =>
      this.deps.readUnusableDevices(),
    )
    const state: HealthDigestState = {
      now: started,
      cameras: joinCameras(motion.value ?? [], metrics.value ?? new Map()),
      placement: placement.value,
      unusableDevices: unusable.value,
    }
    const digest = buildHealthDigest(state, this.deps.now() - started)
    this.keeper.push(digest)
    this.logChanges(digest)
    this.deps.logger.info('health digest: tick', {
      meta: {
        tickMs: digest.tickMs,
        calls: 4,
        findings: digest.findings.length,
        camerasSeen: digest.camerasSeen,
        unreadableSources: digest.sources.filter((s) => s.entries === null).length,
      },
    })
    return digest
  }

  /** A finding is logged when it appears and when it clears, not on every tick. */
  private logChanges(digest: HealthDigest): void {
    const current = new Map<string, number | null>()
    for (const f of digest.findings) {
      const deviceId = f.subject.type === 'camera' ? f.subject.deviceId : null
      current.set(f.id, deviceId)
      if (this.previousIds.has(f.id)) continue
      this.deps.logger.warn('health digest: finding raised', {
        ...(deviceId !== null ? { tags: { deviceId } } : {}),
        meta: { id: f.id, kind: f.kind, severity: f.severity, evidence: f.evidence },
      })
    }
    for (const [id, deviceId] of this.previousIds) {
      if (current.has(id)) continue
      this.deps.logger.info('health digest: finding cleared', {
        ...(deviceId !== null ? { tags: { deviceId } } : {}),
        meta: { id },
      })
    }
    this.previousIds = current
  }
}

function joinCameras(
  motion: readonly BlindCameraSnapshot[],
  metrics: ReadonlyMap<number, CameraMetricsSample>,
): HealthDigestState['cameras'] {
  const ids = new Set<number>([...motion.map((m) => m.deviceId), ...metrics.keys()])
  const byId = new Map(motion.map((m) => [m.deviceId, m] as const))
  return [...ids].map((deviceId) => {
    const snap = byId.get(deviceId)
    return {
      deviceId,
      motion: snap === undefined ? null : snap,
      metrics: metrics.get(deviceId) ?? null,
    }
  })
}

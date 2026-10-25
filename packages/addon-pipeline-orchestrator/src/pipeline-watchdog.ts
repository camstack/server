/**
 * Per-camera pipeline watchdog. Knows which stages each camera expects to run
 * CONTINUOUSLY (audio always-on, analyzer motion, always-on detection), tracks
 * the freshness of each stage's signal, emits one consolidated heartbeat per
 * camera, and triggers bounded auto-recovery for stalled stages. Pure of IO —
 * the clock, logger, and recovery action are injected.
 */

import type { IScopedLogger } from '@camstack/types'

export type WatchdogStage = 'audio' | 'motion' | 'detection'

export interface WatchdogCamera {
  readonly deviceId: number
  readonly deviceName: string
  /** Raw modes, for the heartbeat labels only. */
  readonly audioMode: string
  readonly detectionMode: string
  readonly motionSources: readonly string[]
  /** Stages expected to flow continuously → the camStreamId feeding each. */
  readonly continuousStages: ReadonlyMap<WatchdogStage, string>
}

export interface WatchdogThresholds {
  readonly audioMs: number
  readonly motionMs: number
  readonly detectionMs: number
  readonly maxRecoveryAttempts: number
  /**
   * After a stage exhausts its FAST recovery budget (`maxRecoveryAttempts`), the
   * watchdog does NOT give up permanently — it keeps re-attempting recovery at
   * this slow cadence so a dependency that comes back (e.g. the decoder /
   * audio-codec provider respawning) is picked up automatically instead of the
   * stage staying dead until a full restart. Without this the only reset is a
   * live signal, which can never arrive because recovery has stopped — a
   * permanent deadlock (observed: cam audio STALLED for the whole decoder
   * outage, cleared only by restarting the stack).
   */
  readonly exhaustedRetryMs: number
}

export const DEFAULT_WATCHDOG_THRESHOLDS: WatchdogThresholds = {
  audioMs: 90_000,
  motionMs: 30_000,
  detectionMs: 60_000,
  maxRecoveryAttempts: 3,
  exhaustedRetryMs: 60_000,
}

export interface WatchdogDeps {
  readonly now: () => number
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  /**
   * `attempt` is the recovery attempt number this call represents, capped at
   * `maxRecoveryAttempts` (a post-exhaustion slow retry keeps reporting the cap).
   */
  readonly recover: (
    deviceId: number,
    stage: WatchdogStage,
    streamId: string,
    attempt: number,
  ) => void
  readonly thresholds: WatchdogThresholds
}

interface StageRuntime {
  lastSeenMs: number
  attempts: number
  /** Wall-clock of the last recovery attempt — gates the post-exhaustion slow retry. */
  lastAttemptMs: number
  /**
   * True once this stage has produced AT LEAST ONE live signal. A stage that
   * has lived can stall recoverably (its dependency may come back), which is
   * what the forever slow-retry above exists for. A stage that has NEVER
   * produced a signal is not stalled — it was never feedable (an audio stage on
   * a source with no audio track, a motion stage on a camera whose source can
   * never reach the analyzer) — so it is disarmed at exhaustion instead of
   * being retried until the process restarts.
   */
  everSeen: boolean
  /** Wall-clock of `register` — reported on the disarm line. */
  registeredAtMs: number
}

/** One stage the watchdog stops tracking, with the evidence for the log line. */
interface StageDisarm {
  readonly stage: WatchdogStage
  readonly streamId: string
  readonly sinceRegisteredMs: number
}

interface StageEvaluation {
  readonly line: string
  readonly stalled: boolean
  readonly recoveries: { stage: WatchdogStage; streamId: string }[]
  readonly disarms: StageDisarm[]
}

const STAGE_THRESHOLD_KEY: Record<WatchdogStage, keyof WatchdogThresholds> = {
  audio: 'audioMs',
  motion: 'motionMs',
  detection: 'detectionMs',
}

export class PipelineWatchdog {
  private readonly cameras = new Map<number, WatchdogCamera>()
  private readonly state = new Map<number, Map<WatchdogStage, StageRuntime>>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: WatchdogDeps) {}

  register(cam: WatchdogCamera): void {
    this.cameras.set(cam.deviceId, cam)
    const now = this.deps.now()
    const stages = new Map<WatchdogStage, StageRuntime>()
    for (const [stage] of cam.continuousStages) {
      // Seed with `now` so the first threshold window is a grace period.
      stages.set(stage, {
        lastSeenMs: now,
        attempts: 0,
        lastAttemptMs: 0,
        everSeen: false,
        registeredAtMs: now,
      })
    }
    this.state.set(cam.deviceId, stages)
  }

  unregister(deviceId: number): void {
    this.cameras.delete(deviceId)
    this.state.delete(deviceId)
  }

  /** Called when a stage's live signal arrives (audio chunk / motion frame / inference). */
  noteSignal(deviceId: number, stage: WatchdogStage): void {
    const rt = this.state.get(deviceId)?.get(stage)
    if (!rt) return
    rt.lastSeenMs = this.deps.now()
    rt.attempts = 0
    rt.everSeen = true
  }

  tick(): void {
    const now = this.deps.now()
    for (const cam of this.cameras.values()) {
      const { line, stalled, recoveries, disarms } = this.evaluate(cam, now)
      if (stalled) this.deps.logger.warn(line, { tags: { deviceId: cam.deviceId } })
      else this.deps.logger.info(line, { tags: { deviceId: cam.deviceId } })
      for (const d of disarms) {
        // Say it ONCE, then stop tracking the stage — the deletion is what makes
        // it once, and what ends the forever-retry for a stage nothing feeds.
        this.deps.logger.warn('watchdog stage never produced a signal — disarming', {
          tags: { deviceId: cam.deviceId },
          meta: { stage: d.stage, streamId: d.streamId, sinceRegisteredMs: d.sinceRegisteredMs },
        })
        this.state.get(cam.deviceId)?.delete(d.stage)
      }
      for (const r of recoveries) {
        const rt = this.state.get(cam.deviceId)?.get(r.stage)
        let attempt = this.deps.thresholds.maxRecoveryAttempts
        if (rt) {
          // Cap the counter so post-exhaustion slow retries keep the "exhausted"
          // label instead of climbing "recovering N/max" forever.
          if (rt.attempts < this.deps.thresholds.maxRecoveryAttempts) rt.attempts += 1
          rt.lastAttemptMs = now
          attempt = rt.attempts
        }
        this.deps.recover(cam.deviceId, r.stage, r.streamId, attempt)
      }
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private evaluate(cam: WatchdogCamera, now: number): StageEvaluation {
    const parts: string[] = []
    const recoveries: { stage: WatchdogStage; streamId: string }[] = []
    const disarms: StageDisarm[] = []
    let stalled = false

    const stageOrder: readonly WatchdogStage[] = ['audio', 'motion', 'detection']
    const stageMode: Record<WatchdogStage, string> = {
      audio: cam.audioMode,
      motion: cam.motionSources.includes('analyzer') ? 'analyzer' : cam.motionSources.join('+'),
      detection: cam.detectionMode,
    }

    for (const stage of stageOrder) {
      const streamId = cam.continuousStages.get(stage)
      if (streamId === undefined) {
        parts.push(`${stage}=${stageMode[stage]}(idle)`)
        continue
      }
      const rt = this.state.get(cam.deviceId)?.get(stage)
      if (!rt) {
        parts.push(`${stage}=${stageMode[stage]}(unknown)`)
        continue
      }
      const staleness = now - rt.lastSeenMs
      const thresholdMs = this.deps.thresholds[STAGE_THRESHOLD_KEY[stage]]
      const sSec = Math.round(staleness / 1000)
      // Each stage targets its OWN configured stream (audio/motion/detection
      // may be on different camStreamIds) — the label + recovery use `streamId`.
      if (staleness <= thresholdMs) {
        parts.push(`${stage}=${stageMode[stage]}@${streamId}(OK ${sSec}s)`)
      } else if (rt.attempts >= this.deps.thresholds.maxRecoveryAttempts && !rt.everSeen) {
        // The budget is gone and this stage has never produced a single signal:
        // it is not a stall, it was never feedable. Retrying it on the slow
        // cadence forever would be noise the operator cannot act on, so disarm.
        disarms.push({ stage, streamId, sinceRegisteredMs: now - rt.registeredAtMs })
        parts.push(`${stage}=${stageMode[stage]}@${streamId}(NEVER SIGNALLED ${sSec}s · disarmed)`)
      } else if (rt.attempts >= this.deps.thresholds.maxRecoveryAttempts) {
        // FAST budget exhausted. Do NOT deadlock: keep re-attempting on the slow
        // cadence so a recovered dependency is picked up automatically. The
        // attempts counter stays capped, so the label keeps reading "exhausted".
        stalled = true
        const sinceLastAttempt = now - rt.lastAttemptMs
        if (sinceLastAttempt >= this.deps.thresholds.exhaustedRetryMs) {
          recoveries.push({ stage, streamId })
          parts.push(
            `${stage}=${stageMode[stage]}@${streamId}(STALLED ${sSec}s · exhausted ${rt.attempts} · retrying)`,
          )
        } else {
          parts.push(
            `${stage}=${stageMode[stage]}@${streamId}(STALLED ${sSec}s · exhausted ${rt.attempts})`,
          )
        }
      } else {
        stalled = true
        recoveries.push({ stage, streamId })
        parts.push(
          `${stage}=${stageMode[stage]}@${streamId}(STALLED ${sSec}s · recovering ${rt.attempts + 1}/${this.deps.thresholds.maxRecoveryAttempts})`,
        )
      }
    }

    const line = `[watchdog] cam${cam.deviceId} ${cam.deviceName} · ${parts.join(' · ')} → ${stalled ? 'STALLED' : 'OK'}`
    return { line, stalled, recoveries, disarms }
  }
}

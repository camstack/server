/**
 * Audio markers (D62) — the gates between "an audio frame arrived" and "a
 * synthetic track exists on the camera's timeline".
 *
 * The operator's ask, in their words: surface audio that is *out of the
 * ordinary*, *high volume*, and *when there is no motion active*. Those are
 * three independent gates and this is where they compose, in the order that
 * puts the cheapest and most selective first:
 *
 *   1. {@link observeAudioAnomaly} — out of the ordinary FOR THIS CAMERA, and
 *      loud in absolute terms. Pure, O(1), fed by EVERY audio frame.
 *   2. motion-quiet — an audio marker laid over an active track is noise; the
 *      whole value of the feature is the moment nothing visual is happening.
 *   3. rate ceilings — cooldown, per rolling hour, per rolling day.
 *
 * **Nothing here is silent.** Every gate that drops a frame which had already
 * cleared the ones before it increments a counter, and the counters go out on
 * one info line per camera per minute with `tags: { deviceId }` — because the
 * question always arrives as "why did 102 fire and 101 not", and a line
 * without the tag cannot answer it. A camera on which NOTHING qualified emits
 * no line at all; the line means "something happened", never "I am alive".
 *
 * **The feature ships disabled and still counts.** With `enabled: false` the
 * whole chain runs and the marker that WOULD have been created is counted as
 * `wouldFire`. There is no recorded audio to tune these thresholds against,
 * so the operator gets the rate per camera as data before paying for a single
 * marker. That is also the honest answer to "how many events per camera per
 * day": measured, not predicted — with `maxPerDay` bounding the worst case
 * whatever the thresholds turn out to be.
 */
import type { IScopedLogger, Track } from '@camstack/types'
import {
  type AudioAnomalyConfig,
  type AudioBaselineState,
  emptyAudioBaseline,
  observeAudioAnomaly,
} from '../audio-anomaly-detector.js'
import { AUDIO_TRACK_CLASS } from '../store/audio-track-class.js'
import type { SyntheticTrackInput } from './synthetic-track.js'

/** One info line per camera per minute, and only when something qualified. */
const METRICS_WINDOW_MS = 60_000

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

/** The projector half of {@link SyntheticTrackMaterializer}. */
export interface SyntheticMarkerSink {
  materialize(input: SyntheticTrackInput): Promise<Track | null>
}

export interface AudioMarkerConfig extends AudioAnomalyConfig {
  /** When false: evaluate, count `wouldFire`, materialize nothing. */
  readonly enabled: boolean
  /** Suppress while a track was alive or motion was reported this recently. */
  readonly motionQuietMs: number
  readonly cooldownMs: number
  readonly maxPerHour: number
  readonly maxPerDay: number
}

export interface AudioMarkerObservation {
  readonly deviceId: number
  readonly timestampMs: number
  readonly dbfs: number
  /** Audio macro class on this frame, when the classifier was confident. */
  readonly className?: string
  readonly score?: number
}

export interface AudioMarkerDeps {
  readonly sink: SyntheticMarkerSink
  /**
   * Is something visual happening on this camera right now? Must be O(1) and
   * synchronous — this is called at the audio frame rate (~30 Hz per camera),
   * so a query per event is not an option. The caller answers it from
   * in-RAM mirrors it already maintains on the frame path.
   */
  readonly isMotionActive: (deviceId: number, atMs: number, quietMs: number) => boolean
  readonly logger: IScopedLogger
  readonly onError?: (scope: string, err: unknown) => void
}

/**
 * Per-camera suppression tally for one metrics window. Counted in gate order,
 * so the numbers narrow: a frame appears in exactly one bucket, the FIRST
 * gate that rejected it.
 */
interface MarkerCounters {
  windowStartMs: number
  /** Whether the feature was on for this camera during the window — the
   *  first thing anyone reading `wouldFire: 41` needs to know. */
  enabled: boolean
  /** Frames seen (all verdicts) — the denominator. */
  observed: number
  /** Rejected by the anomaly detector: not loud enough, absolutely. */
  notLoud: number
  /** Loud, but ordinary for this camera. */
  notAnomalous: number
  /** Loud AND out of the ordinary — the frames the gates below act on. */
  candidates: number
  suppressedMotion: number
  suppressedCooldown: number
  suppressedHourly: number
  suppressedDaily: number
  /** A previous materialize for this camera had not finished. */
  suppressedInFlight: number
  /** Would have been a marker, but the feature is off for this camera. */
  wouldFire: number
  materialized: number
  materializeFailed: number
}

function emptyCounters(atMs: number): MarkerCounters {
  return {
    windowStartMs: atMs,
    enabled: false,
    observed: 0,
    notLoud: 0,
    notAnomalous: 0,
    candidates: 0,
    suppressedMotion: 0,
    suppressedCooldown: 0,
    suppressedHourly: 0,
    suppressedDaily: 0,
    suppressedInFlight: 0,
    wouldFire: 0,
    materialized: 0,
    materializeFailed: 0,
  }
}

/** Marker emission times for one camera, newest last, pruned to 24 h. */
interface RateState {
  readonly firedAtMs: readonly number[]
}

export class AudioMarkerProjector {
  private readonly deps: AudioMarkerDeps
  private readonly baselines = new Map<number, AudioBaselineState>()
  private readonly rates = new Map<number, RateState>()
  private readonly counters = new Map<number, MarkerCounters>()
  private readonly inFlight = new Set<number>()

  constructor(deps: AudioMarkerDeps) {
    this.deps = deps
  }

  /**
   * Feed ONE audio frame. Synchronous by construction: at ~30 Hz per camera
   * the common path must not allocate a promise, so the decision is taken
   * inline and only an actual marker goes async (fire-and-forget, bounded by
   * the in-flight guard and the rate ceilings).
   *
   * Call this BEFORE the classification/level route split so the baseline
   * sees every frame. A baseline fed only by the level route is blind to
   * exactly the loud, confidently-classified frames a marker is for.
   */
  observe(input: AudioMarkerObservation, cfg: AudioMarkerConfig): void {
    const { deviceId, timestampMs } = input
    const counters = this.countersFor(deviceId, timestampMs)
    counters.observed += 1
    counters.enabled = cfg.enabled

    const prior = this.baselines.get(deviceId) ?? emptyAudioBaseline()
    const res = observeAudioAnomaly(prior, { timestampMs, dbfs: input.dbfs }, cfg)
    this.baselines.set(deviceId, res.nextState)

    this.maybeFlush(deviceId, timestampMs)

    switch (res.verdict.kind) {
      case 'silent':
      case 'warmup':
        return
      case 'not-loud':
        counters.notLoud += 1
        return
      case 'not-anomalous':
        counters.notAnomalous += 1
        return
      case 'anomalous':
        break
    }
    counters.candidates += 1

    if (this.deps.isMotionActive(deviceId, timestampMs, cfg.motionQuietMs)) {
      counters.suppressedMotion += 1
      return
    }

    const fired = this.rates.get(deviceId)?.firedAtMs ?? []
    const last = fired.length > 0 ? fired[fired.length - 1] : undefined
    if (last !== undefined && timestampMs - last < cfg.cooldownMs) {
      counters.suppressedCooldown += 1
      return
    }
    const recent = fired.filter((t) => timestampMs - t < DAY_MS)
    if (recent.filter((t) => timestampMs - t < HOUR_MS).length >= cfg.maxPerHour) {
      counters.suppressedHourly += 1
      this.rates.set(deviceId, { firedAtMs: recent })
      return
    }
    if (recent.length >= cfg.maxPerDay) {
      counters.suppressedDaily += 1
      this.rates.set(deviceId, { firedAtMs: recent })
      return
    }

    if (!cfg.enabled) {
      counters.wouldFire += 1
      return
    }

    if (this.inFlight.has(deviceId)) {
      counters.suppressedInFlight += 1
      return
    }

    // Charge the budget BEFORE the async work: the snapshot fetch takes real
    // time and a second qualifying frame must see the ceiling already spent.
    this.rates.set(deviceId, { firedAtMs: [...recent, timestampMs] })
    counters.materialized += 1
    this.inFlight.add(deviceId)
    void this.materialize(input, counters)
  }

  /**
   * Emit and reset a camera's window if it has anything to say. Exposed so a
   * shutdown (or a test) can force the tally out rather than losing it.
   */
  flush(nowMs: number): void {
    // Safe to iterate live: `emitWindow` only REPLACES a value, it never adds
    // or removes a key.
    for (const deviceId of this.counters.keys()) this.emitWindow(deviceId, nowMs, true)
  }

  /** Drop all per-camera state for a device (unbind / device removal). */
  forgetDevice(deviceId: number): void {
    this.baselines.delete(deviceId)
    this.rates.delete(deviceId)
    this.counters.delete(deviceId)
    this.inFlight.delete(deviceId)
  }

  private async materialize(
    input: AudioMarkerObservation,
    counters: MarkerCounters,
  ): Promise<void> {
    const { deviceId, timestampMs } = input
    try {
      const audioLabels = buildAudioLabels(input)
      await this.deps.sink.materialize({
        cameraId: deviceId,
        // The camera IS the producer of its own audio — there is no linked
        // device to attribute this to, and no name to label it with.
        sourceDeviceId: deviceId,
        source: 'audio',
        // The taxonomy macro (D189) — shared with the episode projector so the
        // two producers of an audio row cannot drift apart again.
        kind: AUDIO_TRACK_CLASS,
        timestamp: timestampMs,
        ...(audioLabels !== undefined ? { audioLabels } : {}),
      })
    } catch (err) {
      counters.materialized -= 1
      counters.materializeFailed += 1
      this.deps.onError?.('materializeAudioMarker', err)
      this.deps.logger.warn('audio marker materialize failed', {
        tags: { deviceId },
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    } finally {
      this.inFlight.delete(deviceId)
    }
  }

  private countersFor(deviceId: number, atMs: number): MarkerCounters {
    const existing = this.counters.get(deviceId)
    if (existing !== undefined) return existing
    const fresh = emptyCounters(atMs)
    this.counters.set(deviceId, fresh)
    return fresh
  }

  private maybeFlush(deviceId: number, nowMs: number): void {
    const c = this.counters.get(deviceId)
    if (c === undefined || nowMs - c.windowStartMs < METRICS_WINDOW_MS) return
    this.emitWindow(deviceId, nowMs, false)
  }

  /**
   * One line per camera per window — but ONLY when a frame reached the
   * candidate gate. A camera that heard nothing extraordinary has nothing to
   * report, and a line per camera per minute forever would bury the ones that
   * do. `force` still honours that: it flushes the window, it does not invent
   * a reason to speak.
   */
  private emitWindow(deviceId: number, nowMs: number, force: boolean): void {
    const c = this.counters.get(deviceId)
    if (c === undefined) return
    if (!force && nowMs - c.windowStartMs < METRICS_WINDOW_MS) return
    if (c.candidates > 0 || c.materializeFailed > 0) {
      this.deps.logger.info('audio anomaly gate (window)', {
        tags: { deviceId },
        meta: {
          enabled: c.enabled,
          windowMs: nowMs - c.windowStartMs,
          observed: c.observed,
          notLoud: c.notLoud,
          notAnomalous: c.notAnomalous,
          candidates: c.candidates,
          suppressedMotion: c.suppressedMotion,
          suppressedCooldown: c.suppressedCooldown,
          suppressedHourly: c.suppressedHourly,
          suppressedDaily: c.suppressedDaily,
          suppressedInFlight: c.suppressedInFlight,
          wouldFire: c.wouldFire,
          materialized: c.materialized,
          materializeFailed: c.materializeFailed,
        },
      })
    }
    this.counters.set(deviceId, emptyCounters(nowMs))
  }
}

/**
 * The class heard on the anomalous frame, in the shape `Track.audioLabels`
 * already defines. Using that field is what lets a marker label itself
 * ("dog", "glass_breaking") without inventing an event-taxonomy sub-class —
 * the audio macro vocabulary collides with existing subs (`dog` is a COCO
 * animal, `siren` is a control), so a sub per audio class would put a barking
 * dog in the ANIMAL lane.
 */
function buildAudioLabels(input: AudioMarkerObservation): Track['audioLabels'] {
  if (input.className === undefined) return undefined
  return [
    {
      label: input.className,
      peakScore: input.score ?? 0,
      count: 1,
      firstAt: input.timestampMs,
      lastAt: input.timestampMs,
    },
  ]
}

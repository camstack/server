/**
 * What `pipeline-analytics` reports through `failure-contribution` — the four
 * per-camera counters, and the ONE place their vocabulary is written down.
 *
 * ## Why the vocabulary is a module and not four string literals
 *
 * D276 gave a track row a `previewMissReason` composed from strings like
 * `keyframe:native-miss` and `thumbnail:overflow`. Those strings are now
 * joinable evidence: a row says which track lost its tile, and these counters
 * say how often that camera loses one and out of how many tries. A second
 * vocabulary for the same loss would break the join silently — the row would
 * say `native-miss` and the counter `nativeMiss`, and nobody would notice until
 * somebody tried to correlate them. So the reasons live here, named once, and
 * they deliberately reuse D276's spelling.
 *
 * ## Every family carries its denominator
 *
 * Each `note*` call is ONE attempt. The success calls are not decoration: a
 * failure count without them is the number that read as "35x worse than
 * yesterday" on 2026-08-28 and was flat all day once divided
 * (`packages/types/src/metrics/failure-counters.ts`).
 *
 * ## Nothing here logs
 *
 * These paths run at frame rate — 507 enrichment-crop misses in five minutes at
 * peak, ~100/min. A line each is its own defect, and the log lines that already
 * exist on these paths (`enrichment crop native miss`, `capture queue full`,
 * `plate: read discarded`) are unchanged and still throttled. This is the
 * counter that makes them countable without reading them.
 */

import { FailureCounters } from '@camstack/types'
import type { FailureCounterSample } from '@camstack/types'

/**
 * The enrichment crop capture — face / plate / clip / detail-classifier.
 * Denominator: every crop this addon asked the owning runner for.
 */
export const FAMILY_ENRICHMENT_CROP = 'enrichment-crop'

/**
 * The per-camera capture scheduler lane. Denominator: every queued capture that
 * reached a TERMINAL scheduling outcome — started, or dropped. A coalesced or
 * cancelled request is neither and is deliberately not counted: a track that
 * closed before its capture ran did not lose work, it stopped wanting it.
 */
export const FAMILY_CAPTURE_SCHEDULE = 'capture-schedule'

/** Plate OCR reads routed from the detail plane. Denominator: every read. */
export const FAMILY_PLATE_OCR = 'plate-ocr'

/**
 * Person tracks born on this camera. Denominator: every confirmed person birth.
 *
 * The "failure" here is NOT suppressed and must not be — a person standing over
 * a car is a real person, and this repo will not trade that away for a cleaner
 * count (D275 made the same choice for stationary suppression). It is counted so
 * the phantom rate is a number instead of an impression: 4 of 23 on camera 102
 * in two hours, measured by hand on 2026-08-28.
 */
export const FAMILY_PERSON_BIRTH = 'person-birth'

/**
 * The owning runner had no native pixels for the ROI.
 *
 * This collapses the runner-side causes the operator can already see in logs
 * (`worker-lease-gone`, `no-registry-entry`, `jpeg-encode-failed`) because
 * `pipelineRunner.getNativeCrop` answers an ROI miss with `null` and carries no
 * reason on the wire — and `FrameHandle` has no `deviceId`, so the runner could
 * not attribute the split per camera even if it reported it. Splitting this is a
 * framework change (a reason on the reply); until then the honest name is the
 * one the caller can actually stand behind.
 */
export const REASON_NATIVE_MISS = 'native-miss'

/** The crop request threw — routing, transport, a node mid-respawn. */
export const REASON_REQUEST_ERROR = 'request-error'

/** Queued past `staleAfterMs`; the frame it wanted is gone. */
export const REASON_STALE_DROP = 'stale-drop'

/** Shed because the camera's lane was at its queue cap. */
export const REASON_QUEUE_OVERFLOW = 'queue-overflow'

/**
 * The OCR step returned, with nothing in it.
 *
 * The defect this counter was built for: ~35% of plate reads came back with an
 * empty label and fell through the detail router's `d.label.length > 0` gate
 * into no branch at all — no store, no log, no row. Silence read as "this camera
 * never saw a plate", which is a completely different fix.
 */
export const REASON_EMPTY_READ = 'empty-read'

/** A plate detail with no bbox — nothing to crop, nothing to place. */
export const REASON_NO_BBOX = 'no-bbox'

/** `isPlausiblePlateRead` refused it (junk OCR off a distant/oblique plate). */
export const REASON_IMPLAUSIBLE = 'implausible'

/** Below the camera's configured minimum OCR confidence. */
export const REASON_BELOW_MIN_CONFIDENCE = 'below-min-confidence'

/** A person born with its box inside a vehicle's. See {@link FAMILY_PERSON_BIRTH}. */
export const REASON_PERSON_OVER_VEHICLE = 'person-over-vehicle'

/**
 * This addon's `failure-contribution` counters.
 *
 * One instance per addon process, handed to the paths that fail. Every method
 * takes the numeric `deviceId` first, for the same reason every log line does:
 * the question is always per camera.
 */
export class AnalyticsFailureReport {
  private readonly counters: FailureCounters

  constructor(
    private readonly now: () => number = Date.now,
    counters: FailureCounters = new FailureCounters(),
  ) {
    this.counters = counters
  }

  /** One enrichment crop capture. `reason` absent = the native ROI landed. */
  noteEnrichmentCrop(deviceId: number, reason?: string): void {
    this.counters.note(
      { deviceId, family: FAMILY_ENRICHMENT_CROP, ...(reason !== undefined ? { reason } : {}) },
      this.now(),
    )
  }

  /** One capture that reached a terminal scheduling outcome. */
  noteCaptureSchedule(deviceId: number, reason?: string): void {
    this.counters.note(
      { deviceId, family: FAMILY_CAPTURE_SCHEDULE, ...(reason !== undefined ? { reason } : {}) },
      this.now(),
    )
  }

  /** One plate OCR read. `reason` absent = the read was accepted and stored. */
  notePlateRead(deviceId: number, reason?: string): void {
    this.counters.note(
      { deviceId, family: FAMILY_PLATE_OCR, ...(reason !== undefined ? { reason } : {}) },
      this.now(),
    )
  }

  /** One confirmed person birth. `reason` present = it was born over a vehicle. */
  notePersonBirth(deviceId: number, reason?: string): void {
    this.counters.note(
      { deviceId, family: FAMILY_PERSON_BIRTH, ...(reason !== undefined ? { reason } : {}) },
      this.now(),
    )
  }

  /** The `failure-contribution` provider's payload. Reads, never resets. */
  list(): readonly FailureCounterSample[] {
    return this.counters.snapshot(this.now())
  }

  /** Addon disposal. */
  clear(): void {
    this.counters.clear()
  }
}

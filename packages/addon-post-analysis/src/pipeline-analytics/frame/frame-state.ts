/**
 * The per-frame / per-camera state the pipeline-analytics frame path shares.
 *
 * Every field here used to be a private Map (or registry) on
 * `PipelineAnalyticsAddon` itself, read and written by `processFrame` and the
 * handlers around it. They are lifted into ONE object, constructed ONCE by the
 * addon, so the code that uses this state can be moved out of the class and
 * handed the state explicitly instead of reaching for `this`.
 *
 * Nothing here is behaviour: the object only OWNS the containers. Each field
 * keeps the type, the initial value and the documentation it had on the class.
 * Who writes and who clears each entry, and in what order inside a frame, is
 * unchanged and still decided by the caller.
 */
import { randomUUID } from 'node:crypto'

import type { DetailStepAnnounce, Track } from '@camstack/types'

import type { AudioConfirmState } from '../audio-confirm-window.js'
import type { AudioEpisodeState } from '../audio-episode-hysteresis.js'
import type { LevelState } from '../audio-level-detector.js'
import { BirthEvidenceStore } from '../pipeline/birth-evidence-store.js'
import { DeferredBirthRegistry } from '../pipeline/deferred-births.js'
import type { FrameProcessor } from '../pipeline/frame-processor.js'
import type { FrameProcessorInputs } from '../pipeline/frame-processor-config.js'
import { MotionOnsetRegistry } from '../pipeline/motion-onset-registry.js'
import { PackageCollectorMirror } from '../pipeline/package/package-collector-mirror.js'
import type { PackageLookDropReason } from '../pipeline/package/package-look-sightings.js'
import { PackageStillnessTracker } from '../pipeline/package/package-stillness-tracker.js'
import { SecondarySubjectQueue } from '../pipeline/secondary-subjects.js'
import { StartedBirthRegistry } from '../pipeline/started-births.js'
import { SuppressedBirthRegistry } from '../pipeline/suppressed-births.js'

/** Last observed detection-frame dimensions of a device. */
export interface FrameDims {
  w: number
  h: number
}

/** Throttle state of the last audio event insert of a device. */
export interface AudioInsertMark {
  className: string | undefined
  atMs: number
}

/** The latest motion observation of a device, any source. */
export interface MotionTick {
  detected: boolean
  atMs: number
}

export class FrameState {
  // ── Processors (one per `${deviceId}:${source}`) ──────────────────────────

  // Keyed by `${deviceId}:${source}` — one FrameProcessor per (device,
  // source) so the ML and native-onboard streams keep fully isolated
  // tracking/zone/event state. See `procKey()`.
  readonly processors = new Map<string, FrameProcessor>()
  /** The inputs each live processor was built from, by `${deviceId}:${source}`
   *  — so a recorder started after a processor was built can still put it in
   *  a header (D681). Cleared exactly where `processors` is. */
  readonly processorInputs = new Map<string, FrameProcessorInputs>()
  /** Consecutive detector-dropout frames skipped per (deviceId, source) key. */
  readonly dropoutSkipsByKey = new Map<string, number>()
  /** Last time each processor's tracker v2 summary was logged (D683). */
  readonly trackerSummaryAtByKey = new Map<string, number>()

  // ── Track lifecycle and births ────────────────────────────────────────────

  // Current tracked-state snapshot per active track. Used so
  // TrackStarted/TrackEnded fire exactly once per lifecycle transition.
  // Keyed by `${deviceId}:${source}` (same key space as `processors`).
  readonly lastActiveTrackIds = new Map<string, Set<string>>()
  /** See `pipeline/suppressed-births.ts` — rejected births must not be
   *  re-upserted, and must be forgotten when the tracker drops the id. */
  readonly suppressedBirths = new SuppressedBirthRegistry()
  /** Ids whose birth ritual has already run — a birth is decided ONCE (D377). */
  readonly startedBirths = new StartedBirthRegistry()
  /** Births the gate could not MEASURE, awaiting another look on a later frame. */
  readonly deferredBirths = new DeferredBirthRegistry()
  /**
   * The last motion RISING EDGE per device — the reference instant the
   * birth-latency proxy is measured from (D409). Measurement only; nothing
   * gates on it. Fed by the two motion handlers, which are subscribed on the
   * SAME designated post-processing node as the frame path, so a camera whose
   * births land here always has its motion mirror here too.
   */
  readonly motionOnsets = new MotionOnsetRegistry()
  /**
   * The pixels each deferred birth arrived with — a RESERVE per camera, evicted
   * by age inside that camera's own quota (D379).
   *
   * Not a shared cap. The path this replaces was one node-wide 4 096-entry LRU
   * measured pinned full in 6 814 of 6 849 samples over three hours, in which a
   * busy camera evicted a quiet one's proof and every camera added shortened
   * every other camera's window. See `pipeline/birth-evidence-store.ts` for the
   * two measurements the slot count and the TTL are taken from.
   */
  readonly birthEvidence = new BirthEvidenceStore()
  /**
   * Subjects the confirmation gate found in a birth's crop BESIDES the birth
   * itself (a dog in a person's crop), waiting to ride the next frame of the
   * same (device, source) as detections — `pipeline/secondary-subjects.ts`.
   */
  readonly secondarySubjects = new SecondarySubjectQueue()
  /** Pending out-of-band confirmation looks, keyed `deviceId:entryId`, so an
   *  entry that re-arms while one is in flight does not stack timers. */
  readonly pendingConfirmationLooks = new Map<string, ReturnType<typeof setTimeout>>()
  /** Recent SHORT+MOTIONLESS track closes per `<device>:<class>:<cell>` —
   *  see the addon's `noteShortMotionlessTrack`. Measurement only; each entry is
   *  filtered against the 6-hour window on write, so it stays bounded. */
  readonly shortMotionlessCells = new Map<string, number[]>()

  // ── Per-device frame geometry and activity ────────────────────────────────

  // Last seen detection-frame dimensions per device. Positions in the TrackStore
  // are pixels in this frame space; the key-event static-object gate normalizes a
  // track's displacement to this frame's diagonal (scale-invariant). Cleared when
  // a device's processors are forgotten.
  readonly lastFrameDimsByDevice = new Map<number, FrameDims>()
  /**
   * Last ms a spatial track was alive on a device, any plane. Written on the
   * frame path (one `Map.set` per processed frame), read O(1) by the audio-
   * marker motion gate — which runs at the AUDIO frame rate, so it cannot
   * afford a query, a store read or a scan of `lastActiveTrackIds`. This is
   * the D49 shape: an in-memory mirror refreshed off the event path, never a
   * fallible read on the decision path.
   */
  readonly lastTrackActivityMs = new Map<number, number>()

  // ── Runner, detail steps and per-device warn throttles ────────────────────

  /** The runner node that last produced a frame for a camera — see
   *  `handleInferenceResult`. */
  readonly lastRunnerNodeByDevice = new Map<number, string>()
  /**
   * D692 §4: each camera's latest `detailSteps` announce. Kept here rather than read
   * from the detail dispatcher (fresh review L-4) because the dispatcher only ever sees a
   * NON-empty announce, and an empty one is an answer: since D692 the pipeline runner
   * announces `[]` for a camera with no child steps ("no recogniser runs here", final). A
   * runner OLDER than that omits the field, and such a camera stays absent here — every
   * member on it reads `unknown` (pending, D49) until the runner is updated. Bounded by
   * the camera count.
   */
  readonly detailStepsByDevice = new Map<number, readonly DetailStepAnnounce[]>()
  /** Last node this device's captures were gated on, so the drop is logged on
   *  the TRANSITION rather than once per frame (the running count lives in the
   *  key-frame window line). `null` = not currently gated. */
  readonly gatedNodeByDevice = new Map<number, string | null>()
  /** Throttle state for the "overlay synthesis failed" warn, one per device. */
  readonly overlaySynthesisWarnAt = new Map<number, number>()
  /** Throttle state for the "overlay skipped a stale frame" debug line, one per device. */
  readonly overlayStaleLogAt = new Map<number, number>()
  /** Per-device throttle for the inactive-binding frame-drop warn (5 min). */
  readonly inactiveBindingDropWarnAt = new Map<number, number>()

  // ── Motion and audio, per device ──────────────────────────────────────────

  // Throttle state for audio event inserts. Without this every AAC
  // chunk (~30 Hz) becomes a row, blowing the analytics DB to 1M+
  // rows in a single day on one camera.
  readonly lastAudioInsertByDevice = new Map<number, AudioInsertMark>()
  // Device-level mirror of the latest motion observation, ANY source —
  // `isMotionActive` (the audio-marker gate) needs "was something visual
  // happening" per camera, not per (device, source) episode. Updated on
  // every payload `handleMotionAnalysis`/`handleOnboardMotion` see, whether
  // or not it opens/extends/leaves alone an episode. The per-source episode
  // state itself lives in `motionEpisodes` (D475) — this map answers a
  // different, narrower question and must never be reused for episode logic.
  readonly lastMotionTickByDevice = new Map<number, MotionTick>()
  // Per-device rolling-window loudness detector state. Updated on every audio
  // frame that falls to the level path (non-confident / silence classification).
  readonly levelStateByDevice = new Map<number, LevelState>()
  /** Per-device corroboration window for classified audio (see
   *  `audio-confirm-window.ts`). Torn down wherever `levelStateByDevice` is —
   *  a stale window on a removed device would confirm on its first frame back. */
  readonly audioConfirmByDevice = new Map<number, AudioConfirmState>()
  /** Per-device classified-audio episode hysteresis. */
  readonly audioEpisodeByDevice = new Map<number, AudioEpisodeState>()
  /** Open synthetic tracks keyed by hysteresis episodeId. */
  readonly audioEpisodeTracks = new Map<string, Track>()
  readonly audioEpisodeLastPersistMs = new Map<string, number>()

  // ── Package lane, per device ──────────────────────────────────────────────

  /**
   * The DEDICATED package promotion path. The generic stationary registry
   * needs 4 positions inside 30s; `package-detection` is gated by the
   * `MotionSettleGovernor` at one observation per 45s, so that criterion is
   * arithmetically unreachable and `PackageDropDetector` never fired once in
   * its life. This tracker re-associates a package box across governor rounds
   * BY POSITION (the track dies between rounds) and feeds the detector the
   * same appear/depart shape the registry does. Vehicles are untouched.
   */
  readonly packageStillness = new PackageStillnessTracker({
    newId: () => randomUUID(),
  })
  /**
   * Frame-clock timestamp of the last NON-package track seen IN A PACKAGE
   * DROP-OFF ZONE per device — the activity mirror behind the package
   * activity gate ("a parcel needs a deliverer"). A walker at the far gate
   * does not stamp this. Deliberately not {@link lastTrackActivityMs}: that
   * map is stamped by ANY live track, including the package-class FP itself,
   * which would let the streetlight wedge vouch for its own delivery.
   */
  readonly lastNonPackageActivityAt = new Map<number, number>()
  /**
   * WHO was in the drop-off zone, and when (D404). The pick-up is CONCLUDED
   * minutes after the fact, so the collector must be remembered while it is
   * still true — handles only, never pixels.
   */
  readonly packageCollectors = new PackageCollectorMirror()
  /** Last time the oversize-sighting drop was logged per device — one line
   *  per 5 minutes, not one per governor round (the wedge re-sights all
   *  night; ~300 identical lines would bury the log it exists to serve). */
  readonly packageOversizeLogAt = new Map<number, number>()
  /** Reasons logged on the previous package look — episode helper for drops. */
  readonly packageLookDropReasons = new Map<number, ReadonlySet<PackageLookDropReason>>()
}

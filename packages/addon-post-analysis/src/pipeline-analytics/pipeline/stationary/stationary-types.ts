/**
 * stationary-types — the "stationary object" domain model + tunables.
 *
 * A STATIONARY OBJECT is a detection that parked and stayed put (a car in a
 * lot, a bin, a parked bike). Left to the normal tracker it re-spawns a fresh
 * track every `maxTrackLifetimeMs` (5 min on device 102 → 5 vehicle tracks
 * every 4 min on the SAME cars, each re-paying the detail plane — plate OCR +
 * CLIP). Instead, once repeated evidence says the same thing keeps being seen
 * in the same place (`stationary-evidence.ts`), it becomes a lightweight
 * registry entry that:
 *   - suppresses new-track spawns for detections that keep matching it
 *     (no track churn, no re-flooded events/timeline),
 *   - keeps counting toward frame occupancy (it is still an object in view),
 *   - lives INDEFINITELY while the object stays put (no retire→respawn cycle),
 *   - wakes back into a normal moving track the moment the object departs.
 *
 * The entry is the durable record for a parked object — NOT a Track, so it
 * never enters the key-event feed.
 */

/** Pixel-space bounding box in the detection frame (same space as tracks). */
export interface StationaryBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * One parked object. Persisted (survives addon respawn so parked cars are not
 * re-discovered on every boot). `bbox`/`frameWidth`/`frameHeight` are in the
 * detection-frame pixel space so a consumer can normalise the box onto a
 * displayed image, exactly like an ObjectEvent.
 */
export interface StationaryEntry {
  readonly id: string
  readonly deviceId: number
  /** Macro-class (e.g. `vehicle`, `person`). Matching is class-gated. */
  readonly className: string
  readonly bbox: StationaryBbox
  readonly frameWidth: number
  readonly frameHeight: number
  /** When the source track was first seen (its `firstSeen`). */
  readonly firstSeenAt: number
  /** When repeated evidence first justified the entry. */
  readonly becameStationaryAt: number
  /** Last frame a detection confirmed the object is still there. Drives TTL. */
  readonly lastConfirmedAt: number
  /** Track that produced the best evidence for this entry (provenance). */
  readonly sourceTrackId?: string
  /** Enrichment label carried over from the source track (identity / plate). */
  readonly label?: string
  /**
   * Detector score for the box, when the producer knows it.
   *
   * Set ONLY by the dedicated package path
   * (`package/package-stillness-tracker.ts`), whose entries are transient and
   * never enter this registry's ledger — which is why there is no column for
   * it in `STATIONARY_COLUMNS`. It exists because a `package-delivered` object
   * event otherwise carries a fixed confidence of 1 and no notification rule
   * can filter a false positive out (device 101's doormat scores 0.53–0.60 as
   * a `package`, and the operator needs a lever that is not a code change).
   */
  readonly confidence?: number
  /** Native-resolution key-frame media key inherited from the source track,
   *  so the UI can show the parked object's best image without a live crop. */
  readonly keyFrameMediaId?: number
}

/** Compact view of an entry for the occupancy snapshot / UI. */
export interface StationaryObjectView {
  readonly id: string
  readonly className: string
  readonly bbox: StationaryBbox
  readonly frameWidth: number
  readonly frameHeight: number
  readonly firstSeenAt: number
  readonly becameStationaryAt: number
  readonly lastConfirmedAt: number
  readonly label?: string
  readonly keyFrameMediaId?: number
}

export function entryToView(e: StationaryEntry): StationaryObjectView {
  return {
    id: e.id,
    className: e.className,
    bbox: { ...e.bbox },
    frameWidth: e.frameWidth,
    frameHeight: e.frameHeight,
    firstSeenAt: e.firstSeenAt,
    becameStationaryAt: e.becameStationaryAt,
    lastConfirmedAt: e.lastConfirmedAt,
    ...(e.label !== undefined ? { label: e.label } : {}),
    ...(e.keyFrameMediaId !== undefined ? { keyFrameMediaId: e.keyFrameMediaId } : {}),
  }
}

// ── Tunables ────────────────────────────────────────────────────────────────

/** IoU at/above which a detection is unambiguously "the same parked object,
 *  unmoved" → suppress its spawn and refresh `lastConfirmedAt`. Decision #2. */
export const SUPPRESS_IOU = 0.6

/**
 * Minimum IoU for a same-class detection to be ASSOCIATED with an entry — i.e.
 * to be considered THIS parked object's own (possibly jittered/shifted) box
 * rather than a DIFFERENT vehicle. Below this floor a detection can neither
 * confirm nor wake the entry (it is a different object).
 *
 * This overlap gate is the fix for the 102 parking-lot flood: the previous
 * wake test used a centroid-distance radius of half the frame diagonal, so any
 * other vehicle merely PRESENT in the lot (a car driving through, or a second
 * car parked ~120px away) satisfied "near + moved" and retired the parked
 * entry — the parked car then re-spawned a fresh track and re-flooded, over and
 * over. Requiring real box overlap means only the entry's OWN box can wake it.
 */
export const WAKE_ASSOC_IOU = 0.1

/**
 * Look-back window over which a track must have stayed put to stop counting as
 * PRESENT for the orchestrator's session hold.
 *
 * This used to be the promotion criterion — "a track that stayed still this
 * long IS a parked object" — and it was measuring the wrong thing: it rewarded
 * an object seen well and often, while the parked cars that actually need
 * suppressing are re-discovered as dozens of short tracks that never live this
 * long (device 102: 140 tracks for one car, median life 6.8 s). Birth moved to
 * repetition — see `stationary-evidence.ts`.
 *
 * The stillness test survives because it was doing TWO jobs and only one of
 * them was destructive. Creating an entry BLINDS the pipeline to an object, so
 * it needs repeated evidence. Deciding that a motionless subject should stop
 * holding a motion session open destroys nothing — if it is wrong the session
 * closes early and the next motion re-opens it — so one recent stillness read
 * is the right amount of proof. Without this valve, removing promotion would
 * leave every session containing a parked car pinned to `maxSessionHoldMs`
 * (120 s) forever: 102 measured 504 sessions in 24 h, which is 70% detection
 * uptime on one camera, and three cameras are already above 50%.
 */
export const SESSION_STILLNESS_WINDOW_MS = 30_000

/** Minimum recorded positions inside the window to trust the static metrics. */
export const SESSION_STILLNESS_MIN_POINTS = 4

/** Unconfirmed-entry time-to-live: if no detection confirms an entry for this
 *  long (object removed while unobserved, or a long occlusion) → retire it. */
export const ENTRY_TTL_MS = 5 * 60_000

/**
 * The most one gap between two consecutive processed frames counts toward an
 * entry's WATCHED unconfirmed time. Frames inside a motion session arrive every
 * 0.2-2 s; the silence between on-motion sessions is tens of seconds to hours.
 * 10 s sits above any real in-session cadence (a slower frame still counts
 * nearly in full) and far below a session gap, so a gap contributes at most
 * one bound, never its length. Under-counting only delays a retirement.
 */
export const WATCHED_GAP_CAP_MS = 10_000

// ── Departure confirmation (D279) ───────────────────────────────────────────

/**
 * How far apart the two reads of a departure must be before the second one
 * counts as CONFIRMING the first.
 *
 * D49 says a destructive one-shot needs a second read that agrees. Until
 * 2026-08-28 this registry satisfied that by counting to two, and the two reads
 * it counted were consecutive frames of the SAME optical event — which is one
 * read reported twice. Measured on device 102 that day: the same two parked
 * cars were promoted five times in 17 minutes and retired three times as
 * `departed`, while the stored images prove neither car moved.
 *
 * Three numbers set this one:
 *
 *  - the retirement that fired on the session's FIRST TWO FRAMES, **0.9 s
 *    apart** (cold h265 decode). Any separation ≤ 1 s readmits it.
 *  - the steady-state frame rate this pipeline runs at per camera, **5.9–7.9
 *    fps** (measured, and the reason suppression is counted per sweep rather
 *    than per frame). At that rate 3 s is 18–24 frames: the two reads cannot be
 *    neighbouring frames of one event.
 *  - the occlusion that produced the other retirement — a car passing in front
 *    of the parked one, read at IoU 0.36 with its centroid outside. A vehicle
 *    crossing a parked car's footprint at lot speed occupies it for on the
 *    order of a second; 3 s outlives the whole transit, so the occluder has
 *    left the box before a confirmation is even eligible.
 *
 * Cost: a genuine departure retires up to 3 s later than it used to. Against a
 * 120 s promotion span and a 300 s TTL that is under 3% of the cheapest
 * competing timer, and the audit found the wake erring toward retiring.
 */
export const DEPARTURE_CONFIRM_MIN_GAP_MS = 3_000

/**
 * How long an UNCONFIRMED departure strike survives before it decays.
 *
 * The strike used to have no expiry at all: it was a bare id in a `Set`, so a
 * departing read at 17:03 was still waiting at 17:20 and was "confirmed" by an
 * unrelated frame of an unrelated motion session. That is the mechanism behind
 * three retirements of cars that never moved.
 *
 * 30 s, and the bound is structural rather than aesthetic: the motion sessions
 * this camera produces close at `openForMs` ≈ 36 000 (the stillness valve
 * working as designed), so a strike that dies at 30 s can never outlive the
 * session that armed it and be settled by the next one. It is also 10× the
 * confirmation gap, which leaves a real departure — resolved within a second or
 * two of the object leaving its box — an order of magnitude of headroom.
 *
 * A strike is additionally dropped wholesale when a new observation session
 * opens (see {@link GATE_SESSION_GAP_MS}), so the cross-session case is closed
 * twice.
 */
const DEPARTURE_STRIKE_TTL_MS = 30_000

/**
 * How many consecutive frames with NO associated detection are needed before an
 * absence may confirm a pending departure.
 *
 * A miss is not a read of the object; it is the absence of one, and on this
 * fleet it is the single most common non-signal — media capture on 102 fails
 * ~25% of the time, the detector drops boxes at night, and the pipeline has a
 * whole dropout-skip mechanism because detector dropouts come in bursts. So an
 * absence confirms only when it is SUSTAINED: five consecutive unassociated
 * frames, and only once {@link DEPARTURE_CONFIRM_MIN_GAP_MS} has also elapsed
 * since the arming read.
 *
 * Five is the length no dropout burst reaches — the frame-processor's own
 * dropout skip is bounded at `dropoutMaxSkipFrames` and gives up long before
 * that, so a run of five is the detector genuinely reporting an empty spot
 * rather than a hiccup.
 */
export const DEPARTURE_ABSENCE_MIN_READS = 5

/**
 * A gap in gate frames longer than this means a NEW observation session.
 *
 * At 5.9–7.9 fps a 5 s gap is 30–40 missing frames, far beyond any dropout
 * hiccup, and far below the minutes that separate two motion sessions on a
 * session-dispatch camera (the observed re-promotions on 102 were 2–6 min
 * apart). Crossing it resets the warm-up and discards every pending strike:
 * evidence gathered in one session may not settle a question raised in another.
 */
export const GATE_SESSION_GAP_MS = 5_000

/**
 * How long after a session opens the gate refuses to read a DEPARTURE.
 *
 * The first frames of a session are the least trustworthy pixels the pipeline
 * ever sees — a cold h265 decoder emits loose, half-built boxes — and one of the
 * three observed 102 retirements fired on the session's first two frames, which
 * were **0.9 s apart**. Two seconds is more than twice that, and at the ~1.1 fps
 * those cold frames actually arrived it covers the first two or three of them.
 *
 * Only the departure decision is distrusted. Confirmations still land (they
 * refresh `lastConfirmedAt` and cancel strikes) and suppression still runs, so a
 * warm-up frame can never make the registry FORGET anything — it can only fail
 * to destroy something.
 */
export const GATE_WARMUP_MS = 2_000

/**
 * One entry's pending, unconfirmed departure.
 *
 * It is a record and not a bare id on purpose: the two things that were missing
 * when this was a `Set<string>` are WHEN the strike was armed (without which no
 * separation and no expiry can be checked) and how long the object has been
 * unobserved since.
 */
export interface DepartureStrike {
  /** Observed-frame time of the departing read that armed the strike. */
  readonly armedAt: number
  /** Consecutive frames since arming on which no same-class detection was
   *  associated with the entry. Any association resets it to 0. */
  readonly absentReads: number
}

export interface StationaryDepartureConfig {
  readonly confirmMinGapMs: number
  readonly strikeTtlMs: number
  readonly absenceMinReads: number
}

export const DEFAULT_DEPARTURE_CONFIG: StationaryDepartureConfig = {
  confirmMinGapMs: DEPARTURE_CONFIRM_MIN_GAP_MS,
  strikeTtlMs: DEPARTURE_STRIKE_TTL_MS,
  absenceMinReads: DEPARTURE_ABSENCE_MIN_READS,
}

export interface StationaryMatchConfig {
  /** IoU at/above which a same-class detection is the parked object, unmoved. */
  readonly suppressIou: number
  /** Minimum IoU for a same-class detection to be treated as the entry's OWN
   *  object (associated) at all — the overlap gate that stops a different
   *  vehicle in the frame from confirming or waking this entry. */
  readonly wakeAssocIou: number
}

export const DEFAULT_MATCH_CONFIG: StationaryMatchConfig = {
  suppressIou: SUPPRESS_IOU,
  wakeAssocIou: WAKE_ASSOC_IOU,
}

export interface SessionStillnessConfig {
  readonly windowMs: number
  readonly netFracMax: number
  readonly spanFracMax: number
  readonly minPoints: number
}

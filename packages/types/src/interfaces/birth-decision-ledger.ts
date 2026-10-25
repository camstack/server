/**
 * Birth-decision ledger — one durable row per track-birth VERDICT (D409).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * On 2026-09-08 the operator marked eleven tracks for review and five of them
 * said "traccia partita in ritardo" — the track appears to begin long after the
 * subject entered the scene. Two causes were proposed and NEITHER was measured:
 *
 *  - the confirmation gate's deferral (`maxDeferralMs`, 2 s). This is now
 *    DISPROVEN as a cause of a late TIMELINE: a track's `firstSeen` and its
 *    first position are the CANDIDATE's first frame, not the confirmation's.
 *    Verified on `d035f251` (device 3829): first position == `firstSeen`, with
 *    confirmation 2 163 ms later.
 *  - the detector simply not firing until the subject is well into the scene.
 *    Unmeasured, and the reason this table exists.
 *
 * A second, real defect is also unquantified. The deferred-birth re-offer in
 * `index.ts` takes the track from `result.tracked` with NO `matchedThisFrame`
 * check, so a birth can be CONFIRMED on a frame the subject was never observed
 * in. D379's carried birth evidence means some of those confirmations rest on a
 * real observation of the birth instant anyway — and how often is exactly what
 * nobody knows. {@link BirthDecisionRecord.decidedOnCoastedFrame} and
 * {@link BirthDecisionRecord.decidedByBirthEvidence} are the two columns that
 * answer it together.
 *
 * ── Why a TABLE and not a log line ─────────────────────────────────────────
 * `logs.query` is an in-memory ring. Measured on the live hub on 2026-09-08 it
 * held 40 000 entries covering 38 minutes — the whole ring is under an hour of
 * fleet traffic. Every question this data is for ("how often, on camera 102,
 * over the week the operator complained about") outlives that ring by two
 * orders of magnitude, and a previous investigation in this repo was blocked
 * for precisely this reason. The gate ALREADY writes a log line per decision
 * (`confirmation gate: birth confirmed/suppressed/undecided`); adding a
 * fourteenth field to it would answer nothing a day later.
 *
 * This is a MEASUREMENT table. It changes no behaviour, gates nothing, and
 * nothing reads it on the frame path.
 */
import { z } from 'zod'

/**
 * How many birth decisions the cluster keeps, across every camera.
 *
 * Sized off a MEASURED rate, not a guess. Fleet-wide on the live hub,
 * 2026-09-08 20:16 local, over the 38 minutes the log ring covered: 17 `track
 * started` + 14 `birth suppressed — track record retracted` = 31 decided
 * births, i.e. ~49/hour, ~1 200/day. Call a busy daytime hour five times that
 * and the fleet writes ~6 000 rows/day.
 *
 * 30 000 rows is therefore ~25 days at the measured rate and ~5 days at five
 * times it — comfortably past "a few days of traffic", which is the bar the
 * operator's week-long complaint sets. At ~200 bytes a row the ceiling is
 * ~6 MB, against a `tracks` table measured at 4.6 MB for a single 501-row page.
 *
 * A COUNT and not an age, for the same reason as the debug-note archive: the
 * denominator of a miss rate is only meaningful over whatever window the table
 * actually holds, and a quiet fleet should keep more of it, not less. Trimmed
 * oldest-first on append.
 */
export const MAX_BIRTH_DECISION_RECORDS = 30000

/** Default page size for `listBirthDecisions` when the caller omits one. */
export const BIRTH_DECISION_DEFAULT_LIMIT = 500

/**
 * How stale a motion onset may be and still be offered as the birth-latency
 * proxy. Beyond this the row records `null`, never a large number.
 *
 * 60 s is one order of magnitude above the latency being measured (the
 * complaint is "seconds late") and one below the duration of a busy scene's
 * continuous motion burst, where the onset is minutes old and says nothing
 * about THIS subject. See {@link BirthDecisionRecord.birthLatencyMs} for the
 * full error bars.
 */
export const MAX_BIRTH_LATENCY_PROXY_MS = 60_000

/**
 * What the gate decided about a birth, from the CALLER's point of view.
 *
 * Deliberately not `ConfirmationVerdict`: `undecided` is not a birth decision
 * at all — it is a deferral, and the row is written when the deferral ENDS.
 * The third member is the one the gate's own type cannot express, because
 * exhaustion is a property of how long the caller waited.
 */
export const BirthDecisionVerdictSchema = z.enum([
  /** The birth proceeded on a measurement (or with the gate disabled). */
  'confirmed',
  /** A false positive: the row the frame path wrote was retracted. */
  'suppressed',
  /**
   * The ONE remaining fail-open — the deferral ran out, the native crop never
   * arrived and the sub-native fallback missed too, so the birth was allowed
   * without ever being looked at. Counted separately from `confirmed` because
   * lumping them together is what made "the gate stopped failing open" and "the
   * gate now suppresses what it cannot measure" indistinguishable.
   */
  'exhausted-fallback',
])
export type BirthDecisionVerdict = z.infer<typeof BirthDecisionVerdictSchema>

/**
 * Which pixels a gate verdict was taken on (D379): `native` is a full-resolution
 * crop of the birth's own frame and the ONLY source that may suppress;
 * `carried` is that instant at analysis resolution and `fallback` a later
 * instant — both may only confirm.
 */
export const BirthDecisionCropSourceSchema = z.enum(['carried', 'native', 'fallback'])
export type BirthDecisionCropSource = z.infer<typeof BirthDecisionCropSourceSchema>

/** One birth decision, as it is kept. */
export const BirthDecisionRecordSchema = z.object({
  id: z.string(),
  /** Epoch ms the VERDICT was taken (not the birth instant — see `firstSeen`). */
  at: z.number().int(),
  /** The camera. Required: every question here is asked per-camera. */
  deviceId: z.number().int(),
  /**
   * The track the decision was about. PROVENANCE, not ownership — a suppressed
   * birth has no track at all, and a confirmed one is expected to age out long
   * before this row does. Named `sourceTrackId` so the retention model's
   * ownership derivation (`collection-classification.ts`, which keys on a
   * column literally called `trackId`) cannot reach it.
   */
  sourceTrackId: z.string(),
  /** The candidate's claimed class. The miss rate is asked per class too. */
  className: z.string(),
  verdict: BirthDecisionVerdictSchema,
  /**
   * The gate's own `ConfirmationReason` (`confirmed`, `native-pass`, `no-crop`,
   * `timeout`, `carried-inconclusive`, …), or `null`
   * when the gate is DISABLED and every birth is waved through. `null` is not
   * "unknown": it says the gate took no measurement because it was off, which
   * is a different population and must never be averaged in with the rest.
   */
  //
  // A SUPPRESSION names why (D922): `scored-below-threshold`,
  // `below-detector-floor`, `incompatible-class` or `no-detection`. Rows written
  // before D922 say only `suppressed`. A string and not an enum so those rows
  // still read. `session-device-unavailable` (D925): the session's own
  // detector could not re-judge the crop, so nothing was measured and the
  // birth was deferred — no other model is ever asked instead.
  reason: z.string().nullable(),
  /**
   * Which pixels decided it — `null` when no crop was judged (a no-crop or
   * timeout deferral, `native-pass`, the gate disabled), and on rows written
   * before D922. A suppression always says `native`.
   */
  cropSource: BirthDecisionCropSourceSchema.nullable().default(null),
  /** Deferral attempts this birth used. 0 = decided on its first look. */
  attempts: z.number().int(),
  /** Ms from the FIRST undecided attempt to this verdict. 0 = never deferred. */
  deferredForMs: z.number().int(),
  /**
   * THE COLUMN THE RE-OFFER DEFECT IS COUNTED IN.
   *
   * `true` when the frame the verdict was taken on carried no matched
   * detection for this track — the tracker was coasting a frozen box and the
   * subject was not observed. The deferred-birth re-offer pulls the candidate
   * straight out of `result.tracked` without checking, so this is reachable
   * today; the question is the RATE, per camera, and whether refusing those
   * frames would have cost real tracks (cross-read against `verdict` and
   * `decidedByBirthEvidence`).
   */
  decidedOnCoastedFrame: z.boolean(),
  /** Were D379 birth-instant pixels in hand when this candidate was submitted? */
  birthEvidenceAvailable: z.boolean(),
  /**
   * Did those pixels DECIDE it (`cropSource === 'carried'`)? Available and
   * deciding are different: the carried crop is confirm-only, so a candidate
   * can hold evidence, be found inconclusive on it, and be decided by a native
   * crop of a later instant. A coasted decision backed by carried evidence is
   * a real observation of the birth instant; one without it is not.
   */
  decidedByBirthEvidence: z.boolean(),
  /** Best class-compatible crop score, or `null` when nothing compatible was
   *  found — deliberately not 0, which would be a measurement that never was.
   *  Includes a box the detector's own per-class floor refused (D922): since
   *  D925 the gate's bar, not that floor, decides whether it confirms. */
  bestScore: z.number().nullable(),
  /** The bar this candidate actually faced (the phantom-cell hook may raise it). */
  appliedMinConfidence: z.number().nullable(),
  /**
   * The detector the gate re-judged the birth WITH (D925): the session's own
   * root model, inference-device pool and node — never a node default. `null`
   * when the frame named no session detector or no gate ran, and on rows
   * written before D925. A `session-device-unavailable` row names the session
   * detector that could not be reached.
   */
  detectorModelId: z.string().nullable().default(null),
  detectorDeviceKey: z.string().nullable().default(null),
  detectorNodeId: z.string().nullable().default(null),

  // ── Birth latency (part B) ────────────────────────────────────────────────
  /**
   * The track's own `firstSeen` — the candidate's first frame, which is where
   * the timeline starts. `null` for a suppressed birth, which has no track.
   */
  firstSeen: z.number().int().nullable(),
  /**
   * The device's most recent motion RISING EDGE at the moment of the decision,
   * or `null` when there is none, it is older than
   * {@link MAX_BIRTH_LATENCY_PROXY_MS}, or this runner never saw one.
   */
  motionOnsetAt: z.number().int().nullable(),
  /**
   * `firstSeen − motionOnsetAt` — THE OPERATOR'S COMPLAINT, IN MILLISECONDS,
   * AND THE WEAKEST NUMBER IN THIS ROW. Read the error bars before quoting it.
   *
   * **Why motion onset and not something else.** Two other proxies were
   * considered and rejected:
   *  - *the recording/pipeline session start*: for a camera on
   *    `detectionMode: 'always'` the session opens at process start, hours
   *    before any subject. It measures nothing.
   *  - *the first detection on the device in this burst*: CIRCULAR. A track's
   *    `firstSeen` IS the first detection of that object, so for the track that
   *    OPENS a burst — the only one the operator is complaining about — the two
   *    are the same instant and the latency is 0 by construction.
   * Motion onset is the only in-process signal produced by a DIFFERENT
   * mechanism from the object detector, so it is the only one that can precede
   * it. It is also already maintained per-device at frame rate on this very
   * node (`handleMotionAnalysis` / `handleOnboardMotion`), which is what makes
   * it free — and, decisively, the frame path and the motion path are gated to
   * the SAME designated post-processing node, so the mirror is never empty for
   * a camera whose births land here.
   *
   * **Error bars, all of them.**
   *  1. *Motion has no class.* A burst opened by rain, a headlight sweeping a
   *     wall or a branch, and only later joined by the person, OVERSTATES the
   *     latency without bound. Mitigated, never removed, by
   *     {@link BirthDecisionRecord.birthIndexInBurst}: only index 0 is a
   *     candidate for "this burst is this subject", and even then it is a
   *     candidate, not a fact.
   *  2. *The sign is not guaranteed.* The analyzer needs a pixel-count and
   *     intensity threshold. A subject entering slowly at the far edge of the
   *     frame can clear the detector's confidence floor BEFORE it clears the
   *     motion floor, making this negative. Negatives are stored as-is and
   *     never clamped — clamping would fabricate the distribution's left tail,
   *     which is the half that says the proxy is unreliable.
   *  3. *Onboard motion carries firmware latency of unknown, per-model offset*
   *     (hundreds of ms), plus camera-vs-hub clock skew on top. Numbers are
   *     therefore comparable WITHIN a camera and not across cameras of
   *     different motion sources. The motion source is deliberately not copied
   *     here — it belongs to the addon that owns the device (D224) and this is
   *     a write on the frame path — so group by `deviceId`, which is how the
   *     question is always asked anyway.
   *  4. *Continuous motion.* On a busy scene the burst never closes and the
   *     onset is minutes old. Bounded by {@link MAX_BIRTH_LATENCY_PROXY_MS};
   *     past it this is `null`.
   *  5. *No motion signal at all* — analyzer off, onboard-only camera not
   *     reporting, or nothing since boot: `null`. Which is the truth about a
   *     camera nobody has a reference instant for.
   *
   * So this is a per-camera DISTRIBUTION over index-0 births, and it is honest
   * as such. It is not a per-track fact and must never be shown as one.
   */
  birthLatencyMs: z.number().int().nullable(),
  /**
   * How many births this device has already decided since that motion onset.
   * 0 = the first, i.e. the only index at which the burst plausibly belongs to
   * this subject. `null` when there is no usable onset.
   */
  birthIndexInBurst: z.number().int().nullable(),
})
export type BirthDecisionRecord = z.infer<typeof BirthDecisionRecordSchema>

/** Query input for `listBirthDecisions` — newest first, one camera or all. */
export const BirthDecisionQueryInputSchema = z.object({
  /** Restrict to a single camera; omit for every row. */
  deviceId: z.number().int().optional(),
  /** Only decisions at or after this epoch ms. */
  since: z.number().int().optional(),
  /** Restrict to one verdict — the miss rate is read one population at a time. */
  verdict: BirthDecisionVerdictSchema.optional(),
  /** Max rows returned, newest-first. */
  limit: z.number().int().min(1).max(5000).optional(),
})
export type BirthDecisionQueryInput = z.infer<typeof BirthDecisionQueryInputSchema>

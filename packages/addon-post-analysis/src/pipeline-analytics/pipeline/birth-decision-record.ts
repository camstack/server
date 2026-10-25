/**
 * birth-decision-record — turn one resolved birth verdict into the row that is
 * kept (D409).
 *
 * PURE, and separated from the store for the usual reason: the two rules worth
 * getting right — what counts as the fail-open, and when the latency proxy is
 * allowed to report a number — are decisions, not I/O, and a decision that only
 * exists inside a SQLite call cannot be tested or argued with.
 *
 * MEASUREMENT ONLY. Nothing here gates a birth, changes a verdict, or feeds
 * back into the frame path. The caller writes the row after the verdict is
 * already taken.
 */

import {
  type BirthDecisionCropSource,
  type BirthDecisionRecord,
  type BirthDecisionVerdict,
  MAX_BIRTH_LATENCY_PROXY_MS,
} from '@camstack/types'

/** Everything the birth loop knows at the instant a verdict resolves. */
export interface BirthDecisionRecordInput {
  readonly deviceId: number
  readonly trackId: string
  readonly className: string
  /** Did the birth PROCEED? (`outcome.confirmed.has(id)`) */
  readonly confirmed: boolean
  /**
   * Was this birth waved through by the deferral running out — deferred, then
   * confirmed with `exhausted` set, i.e. the gate never looked at the subject?
   * Only meaningful together with {@link confirmed}: exhaustion can only ever
   * ALLOW a birth, never suppress one, so a suppression ignores it.
   */
  readonly exhaustedFallback: boolean
  readonly attempts: number
  readonly deferredForMs: number
  /**
   * Did the tracker MATCH a real detection for this track on the frame the
   * verdict was taken on? ABSENT means yes, mirroring
   * `TrackedDetection.matchedThisFrame` and every other consumer of it.
   */
  readonly matchedThisFrame?: boolean
  /** Were D379 birth-instant pixels in hand when the candidate was submitted? */
  readonly birthEvidenceAvailable: boolean
  /** Did those pixels decide it (`cropSource === 'carried'`)? */
  readonly decidedByBirthEvidence: boolean
  /** The gate's own reason, or `null` when the gate is disabled. */
  readonly reason?: string | null
  readonly bestScore?: number | null
  readonly appliedMinConfidence?: number | null
  /** Which pixels the gate judged — absent when it judged none (D922). */
  readonly cropSource?: BirthDecisionCropSource | null
  /** The session detector the gate re-judged with — absent when none (D925). */
  readonly detector?: BirthDecisionDetector | null
  /** Epoch ms the verdict was taken. */
  readonly decidedAtMs: number
  /**
   * The track's `firstSeen` — the candidate's FIRST frame, where the timeline
   * starts. `null` when unknown; ignored entirely for a suppressed birth, which
   * has no track.
   */
  readonly firstSeen: number | null
  /** The device's last motion rising edge, or `null`. */
  readonly motionOnsetAtMs: number | null
  /** This birth's index in that motion burst, or `null`. */
  readonly birthIndexInBurst: number | null
}

/** The detector a verdict was re-judged with: the session's own (D925). */
export interface BirthDecisionDetector {
  readonly modelId: string
  readonly deviceKey: string
  readonly nodeId: string
}

/** The row minus its `id` — the store mints that. */
export type BirthDecisionRecordDraft = Omit<BirthDecisionRecord, 'id'>

/**
 * The verdict as the ledger reports it.
 *
 * `exhausted-fallback` is a CONFIRMATION and is counted apart from one, because
 * a birth nobody ever looked at and a birth measured and passed are the same
 * row in every existing aggregate — which is what made "the gate stopped
 * failing open" and "the gate now suppresses everything it cannot measure"
 * indistinguishable. Exhaustion attached to a SUPPRESSION is meaningless
 * (exhaustion only ever waves a birth through) and is discarded rather than
 * inventing a fourth member.
 */
function verdictFor(input: BirthDecisionRecordInput): BirthDecisionVerdict {
  if (!input.confirmed) return 'suppressed'
  return input.exhaustedFallback ? 'exhausted-fallback' : 'confirmed'
}

/**
 * The latency proxy, and the three ways it declines to produce a number.
 *
 * It reports `null` — never a fabricated or clamped value — when there is no
 * track (a suppressed birth), no motion reference on this runner, or a
 * reference older than {@link MAX_BIRTH_LATENCY_PROXY_MS}. That last case is
 * the one that matters: on a busy scene the burst never closes and the onset is
 * minutes old, and a minutes-long "birth latency" would be read as the
 * detector's fault when it is the proxy's. When the reference is refused, the
 * onset and the burst index go with it — reporting an index against a reference
 * this row does not carry would be an invitation to join them back up.
 *
 * A NEGATIVE result is returned as measured. The analyzer's pixel-count floor
 * can be crossed after the detector's confidence floor for a subject entering
 * slowly at the frame edge, and clamping that away would delete precisely the
 * evidence that the proxy is unreliable. See `BirthDecisionRecordSchema` for
 * the full error bars.
 */
function latencyFor(
  input: BirthDecisionRecordInput,
  firstSeen: number | null,
): {
  readonly motionOnsetAt: number | null
  readonly birthLatencyMs: number | null
  readonly birthIndexInBurst: number | null
} {
  const onset = input.motionOnsetAtMs
  if (firstSeen === null || onset === null) {
    return { motionOnsetAt: null, birthLatencyMs: null, birthIndexInBurst: null }
  }
  if (firstSeen - onset > MAX_BIRTH_LATENCY_PROXY_MS) {
    return { motionOnsetAt: null, birthLatencyMs: null, birthIndexInBurst: null }
  }
  return {
    motionOnsetAt: onset,
    birthLatencyMs: firstSeen - onset,
    birthIndexInBurst: input.birthIndexInBurst,
  }
}

/** Build the durable row for one resolved birth decision. */
export function buildBirthDecisionRecord(
  input: BirthDecisionRecordInput,
): BirthDecisionRecordDraft {
  const verdict = verdictFor(input)
  // A SUPPRESSED birth owns no track, so it has no `firstSeen` to report and
  // no latency to measure. Carrying the in-flight row's value here would
  // publish a start instant for a track that was retracted.
  const firstSeen = verdict === 'suppressed' ? null : input.firstSeen
  const latency = latencyFor(input, firstSeen)
  return {
    at: input.decidedAtMs,
    deviceId: input.deviceId,
    sourceTrackId: input.trackId,
    className: input.className,
    verdict,
    reason: input.reason ?? null,
    attempts: input.attempts,
    deferredForMs: input.deferredForMs,
    // ABSENT means matched, like every other consumer of the flag.
    decidedOnCoastedFrame: input.matchedThisFrame === false,
    birthEvidenceAvailable: input.birthEvidenceAvailable,
    decidedByBirthEvidence: input.decidedByBirthEvidence,
    bestScore: input.bestScore ?? null,
    appliedMinConfidence: input.appliedMinConfidence ?? null,
    cropSource: input.cropSource ?? null,
    detectorModelId: input.detector?.modelId ?? null,
    detectorDeviceKey: input.detector?.deviceKey ?? null,
    detectorNodeId: input.detector?.nodeId ?? null,
    firstSeen,
    ...latency,
  }
}

/**
 * identity-audit — which of a person's ENROLLED samples do not look like the
 * rest of that person.
 *
 * ## Why this exists
 *
 * The gallery is the one input to recognition that nobody re-reads. A sample
 * enrolled from the wrong face keeps voting forever: it pulls the wrong name
 * onto every future match near it, and because auto-assignment then looks
 * confident, nobody goes back to check. The 2026-09-08 sweep found exactly one
 * such pair on this cluster — a sample under one person scoring 0.61 against
 * three samples of another, enrolled from the same camera in the same minute,
 * where every other cross-identity pair on the cluster sits under 0.50.
 *
 * Finding that took a script and a day. This module makes it a question the
 * operator can ask per person, from the Review tab, and act on.
 *
 * ## What it measures
 *
 * Two numbers per sample, and the second is the one that convicts:
 *
 *  - `selfMean` — mean cosine against the person's OTHER samples. Low means
 *    "this does not look like the rest of you", which is suspicious but can
 *    also be a legitimate hard angle, bad light, a mask.
 *  - `bestForeign` — the highest cosine against any OTHER person's samples,
 *    with that person named. High means "this looks like someone we can name",
 *    which is what a mis-enrolment actually looks like.
 *
 * `suspicion` is the EXCESS — `bestForeign − selfMean` — because that is the
 * only one of the two that discriminates on real data. Measured on Bob's
 * 106 samples, 2026-09-08: `selfMean` has a median of 0.188 and a p90 of 0.235,
 * so ANY absolute reading of "does not look like itself" fires on the whole
 * gallery. The first version of this module scored `(1 − selfMean) / 2` and
 * flagged 56 of 106 — a finding that fires on healthy samples means nothing.
 * `bestForeign` on the same gallery: median 0.283, p95 0.376, and one single
 * outlier at 0.612, which is the mis-enrolment.
 *
 * ## What it refuses to do
 *
 * A cosine between vectors from two different face models is a well-formed
 * float with no meaning — `face-matcher` refuses the comparison and so does
 * this (`comparable: false`). It must read as "cannot say", never as an
 * accusation and never as a clean bill: this list ends in a DELETE button.
 *
 * A person with one sample is not judged either. One sample has nothing to
 * disagree with, and the only thing an outlier score could do there is delete
 * the only sample a new person has.
 *
 * Pure — the caller loads the vectors and performs the removal.
 */
import { cosineSimilarity } from './scene/scene-scoring.js'

/** One enrolled sample, with the vector already loaded from the index. */
export interface AuditSampleInput {
  readonly sampleId: string
  readonly embedding: readonly number[]
  readonly modelId: string
  readonly enrolledAt: number
  readonly deviceId?: number
}

/** Another person's samples, for the "looks like someone else" half. */
export interface AuditForeignIdentity {
  readonly identityId: string
  readonly name: string
  readonly samples: readonly AuditSampleInput[]
}

export interface AuditInput {
  readonly identityId: string
  readonly samples: readonly AuditSampleInput[]
  readonly others: readonly AuditForeignIdentity[]
  /** The cluster's face model. Samples stamped otherwise are not comparable. */
  readonly modelId: string
  /** The recogniser's live `similarityThreshold` — see {@link flaggedCount}. */
  readonly autoAssignThreshold: number
}

export interface AuditForeignMatch {
  readonly identityId: string
  readonly name: string
  readonly score: number
}

export interface AuditRow {
  readonly sampleId: string
  readonly enrolledAt: number
  readonly deviceId?: number
  /** False = a different feature space; every number below is null/0. */
  readonly comparable: boolean
  /** Mean cosine against this person's other comparable samples. Null when
   *  there are none to compare with — never 0, which would read as "opposite". */
  readonly selfMean: number | null
  readonly bestForeign?: AuditForeignMatch
  /** 0 = nothing to say. Higher = look at this one sooner. */
  readonly suspicion: number
}

export interface AuditReport {
  readonly identityId: string
  readonly totalSamples: number
  readonly comparableSamples: number
  /** How many rows crossed {@link SUSPICION_FLAG} — the headline count. */
  readonly flagged: number
  /** Worst first. A row with nothing to say still appears, at the bottom: the
   *  operator asked to see the person's gallery, not only its accusations. */
  readonly rows: readonly AuditRow[]
}

/**
 * A row is FLAGGED when its best foreign match would auto-assign the face to
 * that other person — i.e. it reaches the recogniser's own
 * `similarityThreshold`.
 *
 * Tied to the live threshold rather than to a constant of its own, because
 * that is what the flag MEANS: this sample can steal a match. A second number
 * invented here would drift from the one the recogniser actually uses, and the
 * panel would accuse samples that cannot hurt anyone while staying quiet about
 * ones that can. On the live gallery (threshold 0.40) it flags 2 of 106.
 */
export function flaggedCount(rows: readonly AuditRow[], autoAssignThreshold: number): number {
  return rows.filter((row) => (row.bestForeign?.score ?? 0) >= autoAssignThreshold).length
}

/**
 * How far a foreign match has to stand OUT to count as looking like someone
 * else: `bestForeign - selfMean`. A sample that scores 0.6 against a stranger
 * and 0.7 against its own person is not a mis-enrolment.
 */
function foreignExcess(selfMean: number | null, foreign: AuditForeignMatch | undefined): number {
  if (foreign === undefined) return 0
  if (selfMean === null) return 0
  return Math.max(0, foreign.score - selfMean)
}

function meanCosine(target: AuditSampleInput, pool: readonly AuditSampleInput[]): number | null {
  let sum = 0
  let n = 0
  for (const other of pool) {
    if (other.sampleId === target.sampleId) continue
    sum += cosineSimilarity(target.embedding, other.embedding)
    n += 1
  }
  return n === 0 ? null : sum / n
}

function bestForeignMatch(
  target: AuditSampleInput,
  others: readonly AuditForeignIdentity[],
  modelId: string,
): AuditForeignMatch | undefined {
  let best: AuditForeignMatch | undefined
  for (const identity of others) {
    for (const sample of identity.samples) {
      if (sample.modelId !== modelId) continue
      const score = cosineSimilarity(target.embedding, sample.embedding)
      if (best === undefined || score > best.score) {
        best = { identityId: identity.identityId, name: identity.name, score }
      }
    }
  }
  return best
}

/**
 * Rank one person's samples, worst first.
 *
 * `suspicion` is `(1 - selfMean) / 2` — how far the sample sits from its own
 * person, on [0,1] — plus the foreign EXCESS, which dominates when a sample
 * genuinely resembles somebody the gallery can name. A sample that agrees with
 * its person scores near zero on both terms.
 */
export function auditIdentitySamples(input: AuditInput): AuditReport {
  const comparable = input.samples.filter((s) => s.modelId === input.modelId)
  const rows: AuditRow[] = input.samples.map((sample) => {
    if (sample.modelId !== input.modelId) {
      return {
        sampleId: sample.sampleId,
        enrolledAt: sample.enrolledAt,
        ...(sample.deviceId === undefined ? {} : { deviceId: sample.deviceId }),
        comparable: false,
        selfMean: null,
        suspicion: 0,
      }
    }
    const selfMean = meanCosine(sample, comparable)
    const foreign = bestForeignMatch(sample, input.others, input.modelId)
    // Nothing to compare against → nothing to say. A lone sample is not an
    // outlier, it is an unanswered question.
    const suspicion = foreignExcess(selfMean, foreign)
    return {
      sampleId: sample.sampleId,
      enrolledAt: sample.enrolledAt,
      ...(sample.deviceId === undefined ? {} : { deviceId: sample.deviceId }),
      comparable: true,
      selfMean,
      ...(foreign === undefined ? {} : { bestForeign: foreign }),
      suspicion,
    }
  })
  // Worst first by EXCESS, then by how little the sample looks like its own
  // person. The tie-break carries the whole ordering on a healthy gallery —
  // where every excess is zero — and it is a ranking only: an odd-looking
  // sample with no foreign match is interesting to look at and is not
  // FLAGGED, because nothing it can do would put the wrong name on a face.
  // A sample with nothing to compare against sorts last: unanswered is not
  // suspicious.
  rows.sort((a, b) => {
    if (b.suspicion !== a.suspicion) return b.suspicion - a.suspicion
    const aSelf = a.selfMean ?? Number.POSITIVE_INFINITY
    const bSelf = b.selfMean ?? Number.POSITIVE_INFINITY
    return aSelf - bSelf
  })
  return {
    identityId: input.identityId,
    totalSamples: input.samples.length,
    comparableSamples: comparable.length,
    flagged: flaggedCount(rows, input.autoAssignThreshold),
    rows,
  }
}

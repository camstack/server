import { cosineSimilarity } from '@camstack/types'

/**
 * A gallery vector. Production holds it as the `Float32Array` it was stored as,
 * built once when the gallery loads; a plain array is accepted for callers that
 * assemble samples by hand and is wrapped per comparison (D867).
 */
export type GalleryVector = Float32Array | readonly number[]

/**
 * The scoring view of a sample's vector. A `Float32Array` is returned as is —
 * no per-probe, per-sample allocation (~3200 x 2 KB = 6.5 MB per probe on the
 * live gallery); a plain array is wrapped, exactly as before. The scores are
 * bit-identical either way: wrapping a `number[]` and storing a `Float32Array`
 * produce the same floats.
 */
function galleryVector(sample: GallerySample): Float32Array {
  const e = sample.embedding
  return e instanceof Float32Array ? e : new Float32Array(e)
}

/** One enrolled face sample in the in-memory gallery. */
export interface GallerySample {
  readonly identityId: string
  readonly embedding: GalleryVector
  /** arcface model id this sample was embedded with — must match the probe. */
  readonly modelId: string
}

/** A confirmed single-frame match: the winning identity + its cosine score. */
export interface FaceMatch {
  readonly identityId: string
  readonly score: number
}

export interface MatchOpts {
  /** Minimum cosine to accept a match. */
  readonly threshold: number
  /** Require best − secondBest(other identity) ≥ margin, else ambiguous → null. */
  readonly margin: number
  /**
   * Minimum enrolled-sample count an identity must have to be an auto-match
   * target (#26.3). An identity with fewer samples is excluded from matching —
   * this closes the single-sample-sink loophole where a lone above-threshold
   * identity (no competitor to trigger the ambiguity guard) attracted every
   * probe. Absent ⇒ 1 (no filtering; legacy callers unaffected).
   */
  readonly minIdentitySamples?: number
}

/**
 * Count enrolled samples per identity for probes of a matching model+dimension.
 * Only identities meeting `minIdentitySamples` are eligible auto-match targets.
 */
function eligibleIdentities(
  gallery: readonly GallerySample[],
  probeModelId: string,
  probeDim: number,
  minIdentitySamples: number,
): Set<string> {
  const counts = new Map<string, number>()
  for (const s of gallery) {
    if (s.modelId !== probeModelId) continue
    if (s.embedding.length !== probeDim) continue
    counts.set(s.identityId, (counts.get(s.identityId) ?? 0) + 1)
  }
  const eligible = new Set<string>()
  for (const [id, count] of counts) {
    if (count >= minIdentitySamples) eligible.add(id)
  }
  return eligible
}

/**
 * One identity's standing against a probe: its best comparable sample's cosine,
 * how many comparable samples it has, and whether that count makes it an
 * eligible auto-match target.
 *
 * `eligible: false` rows are RETAINED on purpose. A surface that silently drops
 * the identity `minIdentitySamples` excluded cannot answer the operator's only
 * question about it — "why was this person not offered?" — and the answer is a
 * sample count, not a score.
 */
export interface IdentityScore {
  readonly identityId: string
  /** Cosine of the probe against this identity's BEST comparable sample. */
  readonly score: number
  /** Samples of this identity in the probe's model space AND dimension. */
  readonly sampleCount: number
  /** `sampleCount >= minIdentitySamples` — an auto-match target (#26.3). */
  readonly eligible: boolean
}

/**
 * THE scoring authority. Every identity with at least one sample comparable to
 * the probe (same `modelId` AND same dimension — model-version safety), scored
 * against its best such sample, sorted best-first.
 *
 * Extracted from `matchEmbedding`, which is now a thin decision on top of it,
 * so that "what would the pipeline score this face" has exactly ONE
 * implementation. `face-rescore.ts` — the operator's recompute button — reads
 * the same rows the matcher decides from; a second scoring pass written for the
 * UI would be free to drift, and a UI that disagrees with the pipeline is worse
 * than no UI.
 */
export function rankIdentities(
  probe: { readonly embedding: readonly number[]; readonly modelId: string },
  gallery: readonly GallerySample[],
  minIdentitySamples: number,
): readonly IdentityScore[] {
  const probeVec = new Float32Array(probe.embedding)
  const bestByIdentity = new Map<string, number>()
  const countByIdentity = new Map<string, number>()
  for (const s of gallery) {
    if (s.modelId !== probe.modelId) continue
    if (s.embedding.length !== probe.embedding.length) continue
    const score = cosineSimilarity(probeVec, galleryVector(s))
    const prev = bestByIdentity.get(s.identityId)
    if (prev === undefined || score > prev) bestByIdentity.set(s.identityId, score)
    countByIdentity.set(s.identityId, (countByIdentity.get(s.identityId) ?? 0) + 1)
  }
  const rows: IdentityScore[] = []
  for (const [identityId, score] of bestByIdentity) {
    const sampleCount = countByIdentity.get(identityId) ?? 0
    rows.push({ identityId, score, sampleCount, eligible: sampleCount >= minIdentitySamples })
  }
  rows.sort((a, b) => b.score - a.score)
  return rows
}

/**
 * Match a probe embedding against the gallery. Only samples with the same
 * `modelId` AND the same dimension are compared (model-version safety). Returns
 * the best identity when its score ≥ threshold and it beats the best OTHER
 * identity by ≥ margin; otherwise null.
 *
 * The scores come from {@link rankIdentities}; this function is only the
 * decision (eligibility filter, threshold, ambiguity guard).
 */
export function matchEmbedding(
  probe: { readonly embedding: readonly number[]; readonly modelId: string },
  gallery: readonly GallerySample[],
  opts: MatchOpts,
): FaceMatch | null {
  // Eligible identities only — see #26.3. Already sorted best-first.
  const ranked = rankIdentities(probe, gallery, opts.minIdentitySamples ?? 1).filter(
    (r) => r.eligible,
  )
  const best = ranked[0]
  if (best === undefined) return null
  if (best.score < opts.threshold) return null
  // Ambiguity guard only applies when there IS a second identity.
  const second = ranked[1]
  if (second !== undefined && best.score - second.score < opts.margin) return null
  return { identityId: best.identityId, score: best.score }
}

/** A per-frame face candidate tied to its track. */
export interface FaceCandidate {
  readonly trackId: string
  readonly embedding: readonly number[]
  readonly modelId: string
}

/**
 * Assign at most one identity per track AND at most one track per identity for
 * a single frame. Greedy by score: compute every candidate's full ranked match
 * list, then repeatedly take the globally-highest (track, identity) pair whose
 * track and identity are both still free, until none qualify. A losing track
 * falls back to its next-best free identity ≥ threshold. Ties resolve by input order.
 */

/**
 * Enrollment bound: the maximum cosine an embedding may score against a sample
 * of a DIFFERENT identity and still be enrolled. Genuine ArcFace cross-person
 * cosines sit under ~0.4; the low-information attractor (IR, blur, backs of
 * heads) sits at 0.95+. Measured 2026-08-18: 22 of 50 live samples were
 * enrolled from that attractor, with inter-identity cosines up to 0.988 — each
 * one a magnet that "recognises" every degraded probe as its owner.
 */
export const ENROLLMENT_MAX_FOREIGN_COSINE = 0.9

/** The verdict that condemns an enrollment: the foreign identity and score. */
export interface EnrollmentPromiscuity {
  readonly identityId: string
  readonly cosine: number
}

/**
 * Gate an embedding BEFORE it becomes a gallery sample: condemned when its
 * best cosine against any sample of ANOTHER identity (same model + dimension)
 * reaches {@link ENROLLMENT_MAX_FOREIGN_COSINE}. Null = safe to enroll.
 * Closeness to the TARGET identity's own samples is expected and never
 * condemns.
 */
export function enrollmentPromiscuity(
  embedding: readonly number[],
  modelId: string,
  targetIdentityId: string,
  gallery: readonly GallerySample[],
  bound: number = ENROLLMENT_MAX_FOREIGN_COSINE,
): EnrollmentPromiscuity | null {
  const probeVec = new Float32Array(embedding)
  let worst: EnrollmentPromiscuity | null = null
  for (const s of gallery) {
    if (s.identityId === targetIdentityId) continue
    if (s.modelId !== modelId) continue
    if (s.embedding.length !== embedding.length) continue
    const cosine = cosineSimilarity(probeVec, galleryVector(s))
    if (cosine >= bound && (worst === null || cosine > worst.cosine)) {
      worst = { identityId: s.identityId, cosine }
    }
  }
  return worst
}

export function assignUniquePerFrame(
  candidates: readonly FaceCandidate[],
  gallery: readonly GallerySample[],
  opts: MatchOpts,
): Map<string, FaceMatch> {
  // Build all (trackIdx, identityId, score) pairs above threshold.
  interface Pair {
    readonly trackIdx: number
    readonly identityId: string
    readonly score: number
  }
  const pairs: Pair[] = []
  candidates.forEach((c, trackIdx) => {
    const probeVec = new Float32Array(c.embedding)
    const eligible = eligibleIdentities(
      gallery,
      c.modelId,
      c.embedding.length,
      opts.minIdentitySamples ?? 1,
    )
    const bestByIdentity = new Map<string, number>()
    for (const s of gallery) {
      if (s.modelId !== c.modelId) continue
      if (s.embedding.length !== c.embedding.length) continue
      if (!eligible.has(s.identityId)) continue
      const score = cosineSimilarity(probeVec, galleryVector(s))
      const prev = bestByIdentity.get(s.identityId)
      if (prev === undefined || score > prev) bestByIdentity.set(s.identityId, score)
    }
    // The same ambiguity gate matchEmbedding has always applied: the best
    // identity must beat the best OTHER identity by ≥ margin, else the probe
    // is ambiguous and assigns nothing. This gate was MISSING here from the
    // start — opts.margin arrived and was never read — so the auto-assign
    // path accepted every above-threshold pair: measured on the live gallery
    // (2026-08-18), 241 of 258 auto-assignments in 24 h violated the margin
    // and 79 would re-score to a DIFFERENT identity. A single eligible
    // identity has no competitor and passes, as in matchEmbedding.
    let bestId: string | null = null
    let bestScore = -1
    let secondScore = -1
    for (const [identityId, score] of bestByIdentity) {
      if (score > bestScore) {
        if (bestId !== null) secondScore = bestScore
        bestId = identityId
        bestScore = score
      } else if (score > secondScore) {
        secondScore = score
      }
    }
    const ambiguous = secondScore >= 0 && bestScore - secondScore < opts.margin
    if (bestId !== null && !ambiguous) {
      for (const [identityId, score] of bestByIdentity) {
        if (score >= opts.threshold) pairs.push({ trackIdx, identityId, score })
      }
    }
  })
  // Greedy: stable sort by score desc (forEach preserves input order for ties).
  pairs.sort((a, b) => b.score - a.score)
  const takenTracks = new Set<number>()
  const takenIdentities = new Set<string>()
  const result = new Map<string, FaceMatch>()
  for (const p of pairs) {
    if (takenTracks.has(p.trackIdx) || takenIdentities.has(p.identityId)) continue
    takenTracks.add(p.trackIdx)
    takenIdentities.add(p.identityId)
    result.set(candidates[p.trackIdx]!.trackId, { identityId: p.identityId, score: p.score })
  }
  return result
}

/** Per-track accumulation state for hysteresis. Immutable; updated via a copy. */
export interface TrackAggregate {
  readonly assignedIdentityId: string | null
  readonly confirmations: Readonly<Record<string, number>>
}

export const EMPTY_AGGREGATE: TrackAggregate = Object.freeze({
  assignedIdentityId: null,
  confirmations: Object.freeze({}),
})

export interface AggregateOpts {
  readonly confirmFrames: number
}

/**
 * Fold one frame's match into a track's aggregate. A null match leaves state
 * untouched. An identity is assigned once its cumulative confirmation count
 * reaches `confirmFrames`; once assigned, a different identity must independently
 * reach `confirmFrames` to switch. `changed` is true only on a (re)assignment to
 * a NEW identity, so callers fire the label update exactly once per transition.
 *
 * On each (re)assignment the confirmations record is reset to contain only the
 * newly-assigned identity's count, so any challenger must independently re-reach
 * `confirmFrames` from scratch after any assignment.
 */
export function updateTrackAggregate(
  prev: TrackAggregate,
  match: FaceMatch | null,
  opts: AggregateOpts,
): { state: TrackAggregate; changed: boolean } {
  if (match === null) return { state: prev, changed: false }
  const count = (prev.confirmations[match.identityId] ?? 0) + 1
  const confirmations = { ...prev.confirmations, [match.identityId]: count }
  // Not yet enough evidence to (re)assign this identity.
  if (count < opts.confirmFrames) {
    return { state: { ...prev, confirmations }, changed: false }
  }
  // Enough evidence. Assign/switch only if it differs from the current.
  if (prev.assignedIdentityId === match.identityId) {
    return { state: { ...prev, confirmations }, changed: false }
  }
  // (Re)assignment: reset confirmations to only the newly-assigned identity so
  // any future challenger must independently reach confirmFrames from scratch.
  return {
    state: { assignedIdentityId: match.identityId, confirmations: { [match.identityId]: count } },
    changed: true,
  }
}

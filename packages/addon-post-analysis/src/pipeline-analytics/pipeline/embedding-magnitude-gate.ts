/**
 * embedding-magnitude-gate — refuse a face embedding whose RAW feature
 * magnitude says the model was not looking at a face.
 *
 * ArcFace answers with a 512-d vector that the pipeline L2-normalizes before
 * anyone sees it. The magnitude thrown away in that normalization is a quality
 * signal, and it costs nothing: `postprocess_arcface` already returns the raw
 * vector alongside the normalized one.
 *
 * Why a gate and not just a lower similarity threshold: a degenerate crop does
 * not produce a LOW similarity, it produces a HIGH one. Measured on this
 * cluster (2026-08-18/19), 28.8% of all pairs of DIFFERENT faces scored ≥ 0.90
 * and the worst 40% of the population collapsed onto effectively one vector
 * (mean pairwise cosine 0.976). No threshold can separate that, because it sits
 * above every threshold. The only defence is to refuse the embedding before it
 * enters the gallery or the matcher.
 *
 * The bound is expressed as a MAXIMUM because that is the direction this model
 * runs in — degenerate inputs here yield the larger norm, the inverse of the
 * MagFace convention. Measured over 140 LFW faces through this exact model and
 * preprocessing: usable crops sit at ‖feat‖ ≈ 4.4 (p95 5.25) whatever the size,
 * grey level or blur, while genuinely information-free crops jump to 10–16. A
 * bound of 6.0 kept 97.6% of usable crops and rejected 93.2% of degenerate ones.
 *
 * Ships DISABLED (bound 0). Those numbers come from LFW, not from this cluster,
 * and the magnitude has never been observable here — it was discarded in
 * `result-assembler` one line after it was computed. So the field and its
 * logging land first; the operator sets a real bound once live data says where
 * it belongs. Turning a gate on against a number nobody has measured in
 * production is how you silently stop recognising everybody.
 */

/** Why an embedding was refused: the magnitude seen and the bound it broke. */
export interface EmbeddingMagnitudeVerdict {
  readonly magnitude: number
  readonly bound: number
}

/**
 * `null` = accept. A verdict = refuse, carrying both numbers so the caller can
 * name them in a log.
 *
 * Accepts unconditionally when the bound is 0 (disabled) or when the magnitude
 * is absent / non-finite — an older runner that does not report it must keep
 * working exactly as before, never be silently gated to nothing. Pure.
 */
export function embeddingMagnitudeVerdict(
  magnitude: number | undefined,
  bound: number,
): EmbeddingMagnitudeVerdict | null {
  if (!(bound > 0)) return null
  if (magnitude === undefined || !Number.isFinite(magnitude)) return null
  if (magnitude <= bound) return null
  return { magnitude, bound }
}

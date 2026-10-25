/**
 * detail-semantic-gate — WHEN a detail result's frame earns the SEMANTIC
 * best-shot tier (D406).
 *
 * The attribution path has two moments it could promote on, and they are not
 * the same moment:
 *
 *  - the RECOGNITION — the OCR came back with a plate, right there on this
 *    frame's pixels;
 *  - the LABEL WRITE — `resolveTieredLabelWrite` let that text into a slot on
 *    the track, having weighed it against every earlier candidate.
 *
 * Until 2026-09-08 both went through `applied.trackWritten`, so a plate that
 * was READ but whose text lost the tiered contest (an earlier read holds the
 * slot at a higher score, a gallery vehicle name already claimed it, the tier
 * was undeclared) left the best shot on whatever frame the confidence ranking
 * happened to like. Measured: track `718acf29`, device 102 — plate DNJE230
 * read at `1788879992717`, best shot stored from `1788879987020`, 5.7 s
 * earlier, showing the car's roof. Gating a one-shot promotion on a second,
 * fallible decision is the [D49](../../../../../docs/decisions/adr-0049.md)
 * shape in another domain.
 *
 * A fine CLASSIFICATION keeps the write gate, deliberately: "this is a
 * Motorcycle" that the track REFUSED is not something the record keeps, and
 * promoting on it would let a rejected class steer the best shot.
 *
 * Pure, total, and exhaustive — every class gets exactly one trigger, which is
 * what stops the two call sites from both firing on the same detail.
 */

/** Which event promotes a detail's frame into the semantic tier. */
export type DetailSemanticTrigger = 'recognition' | 'label-write'

/** The detail `className` whose result IS the recognition. */
const PLATE_CLASS = 'plate'

/**
 * The moment `className`'s detail result earns the semantic tier.
 *
 * `recognition` — promote as soon as the result exists (the plate read).
 * `label-write` — promote only once the track ACCEPTED the label.
 */
export function detailSemanticTrigger(className: string): DetailSemanticTrigger {
  return className === PLATE_CLASS ? 'recognition' : 'label-write'
}

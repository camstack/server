/**
 * Zero-shot classification over a CLIP image vector the pipeline ALREADY
 * computed — no dataset, no extra weights, no second inference per crop.
 *
 * ## Why this exists: vehicle type (D649)
 *
 * `vehicle-type-v1` is fine-tuned on a CC BY-NC dataset (DrBimmer), so its
 * weights are treated as non-commercial. The 2026-09-26 spike measured the
 * alternative on 320 Open Images crops (40 per class): the classifier 0.753,
 * SigLIP2 zero-shot with `"a photo of a {class}."` 0.922. The labels are
 * vehicle-type-v1's own, so a caller can emit exactly the strings it does.
 *
 * ## What is here, and what is deliberately NOT (the seam)
 *
 * Here: prompt → prototype vectors (built once per CLIP model, in that model's
 * space), and a pure argmax-with-margin over them that REFUSES by name — a
 * vector from another model, a wrong dimension, or a margin too thin to call.
 *
 * Not here: writing the answer onto a track. Vehicle subtype is a tier-2 label
 * whose writer today is the `vehicle-type` pipeline step; a second writer for
 * the same tier needs a precedence rule (per camera, which source wins, and
 * what an operator sees when they disagree), and that is a decision record of
 * its own, not a side effect of shipping a model. The wiring point is
 * `routeClipDetail` / `persistObjectEmbeddingBests` in `pipeline-analytics`,
 * where the vehicle track's CLIP vector and its model id arrive together.
 * Until then this is an option an operator can evaluate (it is exercised end
 * to end by the SigLIP2 check in the D649 report), not a label source.
 */

/** vehicle-type-v1's eight labels, verbatim — the strings a caller must emit. */
export const VEHICLE_TYPE_LABELS = [
  'Ambulance',
  'Bicycle',
  'Bus',
  'Car',
  'Motorcycle',
  'Taxi',
  'Truck',
  'Van',
] as const
export type VehicleTypeLabel = (typeof VEHICLE_TYPE_LABELS)[number]

/** The prompt the spike measured. Lower-cased: SigLIP2 was trained lower-cased. */
export function zeroShotPrompt(label: string): string {
  return `a photo of a ${label.toLowerCase()}.`
}

/**
 * The top-1 must beat the runner-up by this much cosine, or there is no answer.
 * A cosine margin, so it transfers across models better than a raw floor; the
 * spike's misses (Van ↔ Car) sat inside it.
 */
const DEFAULT_ZERO_SHOT_MIN_MARGIN = 0.01

/** One label's prototype: the L2-normalised text vector of its prompt. */
export interface ZeroShotPrototypes<L extends string> {
  /** The CLIP model the prototypes were encoded with — its space only. */
  readonly modelId: string
  readonly labels: readonly L[]
  readonly vectors: readonly Float32Array[]
}

/** Encodes one prompt in ONE model's space (the embedding encoder's `encodeText`). */
export type EncodePrompt = (text: string, modelId: string) => Promise<readonly number[]>

export async function buildZeroShotPrototypes<L extends string>(
  labels: readonly L[],
  modelId: string,
  encode: EncodePrompt,
): Promise<ZeroShotPrototypes<L>> {
  const vectors: Float32Array[] = []
  for (const label of labels) {
    vectors.push(normalise(await encode(zeroShotPrompt(label), modelId)))
  }
  return { modelId, labels, vectors }
}

export type ZeroShotRefusal = 'other-model' | 'dimension' | 'margin'

export type ZeroShotResult<L extends string> =
  | { readonly kind: 'label'; readonly label: L; readonly score: number; readonly margin: number }
  | { readonly kind: 'refused'; readonly reason: ZeroShotRefusal }

export interface ZeroShotInput {
  readonly vector: readonly number[]
  /** The model that produced `vector` — it must be the prototypes' model. */
  readonly modelId: string
  readonly minMargin?: number
}

export function classifyZeroShot<L extends string>(
  prototypes: ZeroShotPrototypes<L>,
  input: ZeroShotInput,
): ZeroShotResult<L> {
  // Cosine between two CLIP spaces is not a weak signal, it is noise.
  if (input.modelId !== prototypes.modelId) return { kind: 'refused', reason: 'other-model' }
  const probe = normalise(input.vector)
  const first = prototypes.vectors[0]
  if (first === undefined || probe.length !== first.length) {
    return { kind: 'refused', reason: 'dimension' }
  }
  let best = -Infinity
  let second = -Infinity
  let bestIndex = -1
  prototypes.vectors.forEach((proto, i) => {
    const score = dot(probe, proto)
    if (score > best) {
      second = best
      best = score
      bestIndex = i
    } else if (score > second) {
      second = score
    }
  })
  const label = prototypes.labels[bestIndex]
  const margin = best - second
  if (label === undefined || margin < (input.minMargin ?? DEFAULT_ZERO_SHOT_MIN_MARGIN)) {
    return { kind: 'refused', reason: 'margin' }
  }
  return { kind: 'label', label, score: best, margin }
}

function normalise(v: readonly number[]): Float32Array {
  let norm = 0
  for (const x of v) norm += x * x
  const n = Math.sqrt(norm)
  const out = new Float32Array(v.length)
  if (n === 0) return out
  v.forEach((x, i) => {
    out[i] = x / n
  })
  return out
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0)
  return s
}

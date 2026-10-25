/**
 * The camera's own record types → the operator's own filter vocabulary.
 *
 * D549 decision 20, and the table in `docs/design/2026-09-20-external-videoclips.md`
 * § 3b. Three rules the mapping exists to keep:
 *
 * 1. **A class and a kind are different questions.** `md` and `pir` say
 *    "something moved" — they are the built-in MOTION kind, never an object
 *    class. Folding them into `labels` would put "Motion" in a filter row that
 *    means "what was it".
 * 2. **A behaviour travels beside a class, never instead of one.**
 *    `crossline` / `intrude` / `loitering` say what the subject DID; a clip is
 *    `people` + `intrude`, and the class filter ignores the second half.
 * 3. **An unknown type stays visible.** A firmware inventing a type must not
 *    vanish, so anything unrecognised becomes `unknown:<raw>` and the raw
 *    strings ALWAYS travel too. A closed enum that throws on the first
 *    disagreeing camera is the defect, not the camera.
 */

/** `Clip.kind` values this mapping can produce. */
export type NativeClipKind = 'motion' | 'audio' | 'native'

export interface NativeTypeClassification {
  /** Our vocabulary, dominant first, at most three (`MAX_CLIP_LABELS`). */
  readonly labels: readonly string[]
  /** What the subject DID. Rendered as a chip; does not filter. */
  readonly behaviours: readonly string[]
  /** Every raw string the camera sent, in wire order. Lossless. */
  readonly nativeTypes: readonly string[]
  readonly kind: NativeClipKind
}

/** Cap on `ClipSchema.labels`, mirrored from `@camstack/types` MAX_CLIP_LABELS. */
const MAX_LABELS = 3

/** Native → object class. The same rule `native-detection-mapping.ts` applies
 *  to live boxes, so a clip and a live box never disagree about a dog. */
const CLASS_BY_NATIVE: Readonly<Record<string, string>> = {
  people: 'person',
  face: 'person',
  visitor: 'person',
  vehicle: 'vehicle',
  nonmotorveh: 'vehicle',
  dog_cat: 'animal',
  package: 'package',
}

/** Natives that state a KIND rather than a class. */
const KIND_BY_NATIVE: Readonly<Record<string, NativeClipKind>> = {
  md: 'motion',
  pir: 'motion',
  cry: 'audio',
  // A file the camera wrote and DECLINED to class is a file something moved
  // in: `other` sits beside `md` in every listing that carries both, and on
  // this fleet it is the only reason a detection-armed camera records at all.
  //
  // It used to be a recording REASON, which left those rows with no class and
  // no kind — so the card fell back to `Clip.kind`'s own value, `native`, and
  // showed the operator an internal identifier. Measured on 3628 the same
  // day: 6 of 23 clips were `other` alone. Operator's call, 2026-09-21:
  // *"ok per other allora é semplice Motion"*.
  //
  // `none` stays a reason: no `recordType` at all is the camera saying
  // nothing, which is not the same as saying "something moved".
  other: 'motion',
}

/** What the subject DID — carried beside a class, never as one. */
const BEHAVIOUR_BY_NATIVE: Readonly<Record<string, string>> = {
  crossline: 'crossline',
  intrude: 'intrude',
  intrusion: 'intrude',
  loitering: 'loitering',
  // A visitor is a person AT THE DOOR: the class is `person`, the doorbell is
  // the circumstance. Both, never one.
  visitor: 'doorbell',
}

/**
 * Recording REASONS — why the file exists, not what is in it. They get no
 * label and no behaviour; the row still lists, showing the reason raw.
 * `none` is the camera declining to classify, which is not the same as the
 * camera saying "nothing". `other` used to live here and is now a motion KIND
 * — see {@link KIND_BY_NATIVE}.
 */
const RECORDING_REASONS: ReadonlySet<string> = new Set([
  'sched',
  'manual',
  'io',
  'IPCInputOutput',
  'legacy',
  'loss',
  'answer',
  'tamper',
  'lmsg',
  'none',
])

/**
 * Ordering for `labels` — "dominant first". A person outranks a vehicle
 * outranks an animal outranks a package; anything unknown sorts last so a
 * newer firmware's invention never displaces a class the operator filters on.
 */
const CLASS_RANK: readonly string[] = ['person', 'vehicle', 'animal', 'package']

/** Split the `recordType` CSV a file carries into raw types, de-duplicated,
 *  in wire order. Case is NOT normalised: `IPCInputOutput` is what the camera
 *  said and what `nativeTypes` must carry back. */
export function parseNativeTypes(recordType: string | undefined): readonly string[] {
  if (recordType === undefined) return []
  const out: string[] = []
  for (const part of recordType.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '' || out.includes(trimmed)) continue
    out.push(trimmed)
  }
  return out
}

export function classifyNativeTypes(nativeTypes: readonly string[]): NativeTypeClassification {
  const labels: string[] = []
  const behaviours: string[] = []
  let kind: NativeClipKind = 'native'

  for (const raw of nativeTypes) {
    const behaviour = BEHAVIOUR_BY_NATIVE[raw]
    if (behaviour !== undefined && !behaviours.includes(behaviour)) behaviours.push(behaviour)

    const cls = CLASS_BY_NATIVE[raw]
    if (cls !== undefined) {
      if (!labels.includes(cls)) labels.push(cls)
      continue
    }
    const kindOf = KIND_BY_NATIVE[raw]
    if (kindOf !== undefined) {
      // A classified object outranks "something moved": once a class is in the
      // row, `md` is only how the camera noticed it.
      if (kind === 'native') kind = kindOf
      continue
    }
    if (RECORDING_REASONS.has(raw)) continue
    if (behaviour !== undefined) continue
    const unknown = `unknown:${raw}`
    if (!labels.includes(unknown)) labels.push(unknown)
  }

  // A class demotes the motion/audio kind back to `native` — the row is about
  // what it saw, and the kind filter keeps `motion` for rows with nothing else.
  if (labels.some((label) => !label.startsWith('unknown:'))) kind = 'native'

  const ordered = labels.toSorted((a, b) => rankOf(a) - rankOf(b))
  return {
    labels: ordered.slice(0, MAX_LABELS),
    behaviours,
    nativeTypes: [...nativeTypes],
    kind,
  }
}

function rankOf(label: string): number {
  const at = CLASS_RANK.indexOf(label)
  return at === -1 ? CLASS_RANK.length : at
}

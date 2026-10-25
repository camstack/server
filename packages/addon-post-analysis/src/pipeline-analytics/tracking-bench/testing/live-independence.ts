/**
 * Carried from the Task 19 review into every committed case (D681): a
 * tracker dropped into `CASE_TRACKER` — including D683's — must never read
 * the OLD tracker's `live[]` to decide what it emits. `replay.spec.ts`
 * proves this for `ProcessorTracker` alone; this proves it for WHATEVER
 * tracker a case is replayed through, by replaying the tape twice — once as
 * recorded, once perturbed — and requiring one hash.
 *
 * A tape with no `identity` record gets the strongest test: `live[]` emptied
 * outright, nothing left to read.
 *
 * A tape that DOES carry one needs more care (fix round 1, H1): the narrow
 * exception lets a tracker read `live[]` to resolve `identity.trk` to the
 * detections that live track bound, and the ORIGINAL fix only rotated the
 * state fields (`m`, `st`, `lsh`), leaving every `trk`/`det` PAIRING intact —
 * which is exactly what a tracker that COPIES `live[].trk` as its own id
 * copies. That tracker passed on every identity tape, `RecordedTracker`
 * (the literal definition of "reads live[]") included. The fix:
 *
 *  - every `trk` — in `live[]` AND in `identity` records — is renamed through
 *    ONE bijection, so `identity.trk` still resolves to the SAME (renamed)
 *    detections, but a COPIED value differs from the original and changes
 *    the hash;
 *  - a `live[]` entry whose `trk` no `identity` record ever names is DROPPED
 *    outright — a tracker has no legitimate reason to read it at all;
 *  - `rs` rotates alongside `m`/`st`/`lsh` (the original fix listed it as
 *    scrambled but never touched it).
 *
 * A residual limit remains even after this fix, worth recording for D683: the
 * GROUPING of the named tracks (which entries share a `trk`, before renaming)
 * is still visible through the exception, because the exception needs it.
 *
 * (D683 Task 12, M4) The exception now covers `drop.trk` too — a recorded
 * `dropTrack` names a LIVE id exactly like `identity.trk` — so a `drop`
 * record is a naming record: its `trk` is renamed through the same bijection
 * and the `live[]` entries it names are kept. And every `fusion` record (the
 * live L2's own answer, tape v2) is REMOVED from the perturbed tape: only
 * `RecordedTracker` has a reason to read one, and a tracker that copied it
 * would pass a case by replaying the answer.
 */
import { replayTape } from '../replay.js'
import type { Tape } from '../tape-codec.js'
import type {
  TapeBodyRecord,
  TapeDrop,
  TapeFrame,
  TapeIdentity,
  TapeLive,
  TapePlane,
} from '../tape-schema.js'
import type { TapeTrackerFactory } from '../trackers/tape-tracker.js'

function emptyLive(frame: TapeFrame): TapeFrame {
  return { ...frame, live: [] }
}

const NEXT_STATE: Readonly<Record<TapeLive['st'], TapeLive['st']>> = {
  new: 'entered',
  entered: 'left',
  left: 'moving',
  moving: 'idle',
  idle: 'new',
}

type Rs = NonNullable<TapeLive['rs']>
const NEXT_RS: Readonly<Record<Rs, Rs>> = {
  'sole-subject': 'sole-subject-veto-lifted',
  'sole-subject-veto-lifted': 'multi-subject',
  'multi-subject': 'sole-subject',
}

type TapeNamingRecord = TapeIdentity | TapeDrop

/** A control record that names a LIVE track by `trk` — the only reason a
 *  tracker may read `live[]` at all (`identity`, and `drop` since M4). */
function isNamingRecord(r: TapeBodyRecord): r is TapeNamingRecord {
  return r.kind === 'identity' || r.kind === 'drop'
}

function hasNamingRecord(tape: Tape): boolean {
  return tape.body.some(isNamingRecord)
}

/** Every distinct `trk` a naming control record names, anywhere on the
 *  tape — the only `live[]` entries a tracker has a legitimate reason to
 *  read at all. */
function namedTrks(tape: Tape): ReadonlySet<string> {
  const out = new Set<string>()
  for (const r of tape.body) if (isNamingRecord(r)) out.add(r.trk)
  return out
}

/**
 * A bijection old `trk` → a DIFFERENT string, stable across the whole tape:
 * `identity.trk` still resolves to the SAME renamed live track, so a tracker
 * using the narrow exception correctly still agrees with itself, while a
 * tracker that COPIES a `trk` value produces a different `liveId` than it
 * did on the tape as recorded.
 */
function trkRename(tape: Tape): ReadonlyMap<string, string> {
  const trks = new Set<string>()
  for (const r of tape.body) {
    if (r.kind === 'frame') for (const l of r.live) trks.add(l.trk)
    if (isNamingRecord(r)) trks.add(r.trk)
  }
  const map = new Map<string, string>()
  const sorted = [...trks].sort()
  sorted.forEach((trk, i) => map.set(trk, `shadow-${String(i)}`))
  return map
}

function scrambledLive(l: TapeLive, renameOf: (trk: string) => string): TapeLive {
  return {
    trk: renameOf(l.trk),
    det: l.det,
    m: !l.m,
    st: NEXT_STATE[l.st],
    ...(l.rs === undefined ? {} : { rs: NEXT_RS[l.rs] }),
    ...(l.lsh === true ? {} : { lsh: true as const }),
  }
}

/**
 * On a tape with a naming record: keep only the `live[]` entries a naming
 * record names (dropping every other entry outright), rename every `trk` —
 * in both `live[]` and the naming records themselves — through the SAME
 * bijection, and rotate the state fields of what remains (fix round 1, H1).
 */
function perturbNamedTape(tape: Tape): Tape {
  const named = namedTrks(tape)
  const rename = trkRename(tape)
  const renameOf = (trk: string): string => rename.get(trk) ?? trk
  const body = withoutFusions(tape).map((r): Tape['body'][number] => {
    if (isNamingRecord(r)) return { ...r, trk: renameOf(r.trk) }
    if (r.kind !== 'frame') return r
    return {
      ...r,
      live: r.live.filter((l) => named.has(l.trk)).map((l) => scrambledLive(l, renameOf)),
    }
  })
  return { ...tape, body }
}

/** The live L2's recorded answer, removed (D683 Task 12). */
function withoutFusions(tape: Tape): Tape['body'] {
  return tape.body.filter((r) => r.kind !== 'fusion')
}

function perturb(tape: Tape): Tape {
  return hasNamingRecord(tape)
    ? perturbNamedTape(tape)
    : { ...tape, body: withoutFusions(tape).map((r) => (r.kind === 'frame' ? emptyLive(r) : r)) }
}

/**
 * `true` when replaying `tape` through a fresh tracker from `factory` gives
 * the same hash as-is and perturbed — the proof that the tracker never reads
 * `live[]` beyond the narrow `identity.trk` / `drop.trk` exception, nor a
 * recorded `fusion`.
 */
export function isLiveIndependent(
  tape: Tape,
  plane: TapePlane,
  factory: TapeTrackerFactory,
): boolean {
  const asIs = replayTape(tape, factory(), plane)
  const perturbed = replayTape(perturb(tape), factory(), plane)
  return asIs.hash === perturbed.hash
}

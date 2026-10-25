/**
 * Feed one plane of a tape through a tracker, in tape order (spec §5.2), and
 * hash what came out: two replays of one tape through two fresh instances of
 * one tracker must be byte-identical. `skip` and `gap` records are not passed
 * (the dropout decision is replayed as recorded; a gap is a jump in `t`).
 *
 * `identity` records ARE passed, to `control` (Task 19 fix round 1, M1): a
 * face-recognizer verdict a tracker needs to reproduce a cannot-link. So are
 * `fusion` records (v2, D683): the live L2's decisions, which `RecordedTracker`
 * reports and a tracker that links on its own ignores. Passing
 * it does not compromise determinism — a tracker's `control` is as
 * side-effect-free (no clock, no I/O) as `step`.
 */
import { createHash } from 'node:crypto'
import type { Tape } from './tape-codec.js'
import type { TapePlane } from './tape-schema.js'
import type { TapeFinalisation, TapeTracker, TapeTrackOutput } from './trackers/tape-tracker.js'

export interface ReplayFrame {
  readonly t: number
  readonly outputs: readonly TapeTrackOutput[]
}

export interface ReplayResult {
  readonly tracker: string
  readonly plane: TapePlane
  readonly frames: readonly ReplayFrame[]
  readonly finalisations: readonly TapeFinalisation[]
  readonly hash: string
}

export function replayTape(tape: Tape, tracker: TapeTracker, plane: TapePlane): ReplayResult {
  tracker.start(tape.header, plane)
  const frames: ReplayFrame[] = []
  const finalisations: TapeFinalisation[] = []
  for (const r of tape.body) {
    switch (r.kind) {
      case 'frame': {
        if (r.plane !== plane) break
        const out = tracker.step(r)
        frames.push({ t: r.t, outputs: out.outputs })
        finalisations.push(...out.finalised)
        break
      }
      case 'processor':
      case 'scene':
      case 'drop':
      case 'identity':
      case 'fusion':
        tracker.control(r)
        break
      case 'skip':
      case 'gap':
        break
    }
  }
  const endT = tape.end?.durationMs ?? frames[frames.length - 1]?.t ?? 0
  finalisations.push(...tracker.finish(endT).finalised)
  const hash = createHash('sha256').update(JSON.stringify({ frames, finalisations })).digest('hex')
  return { tracker: tracker.name, plane, frames, finalisations, hash }
}

/** Provisional id → final id (the last finalisation wins; none = itself). */
export function finalIdResolver(replay: ReplayResult): (liveId: string) => string {
  const map = new Map<string, string>()
  for (const f of replay.finalisations) map.set(f.provisionalId, f.finalId)
  return (liveId) => map.get(liveId) ?? liveId
}

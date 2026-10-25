/**
 * Carried from the Task 19 review into every committed case (D681): a
 * tracker plugged into `CASE_TRACKER` — including D683's — must never read
 * the OLD tracker's `live[]` to decide what it emits. `replayTape` already
 * proves this for `ProcessorTracker` alone (`replay.spec.ts`, H1); this
 * proves it PER CASE, for whatever tracker occupies the slot, by replaying
 * the case's own tape twice — once as recorded, once perturbed — and
 * requiring one hash.
 *
 * A tape with no `identity` record gets the strongest test — `live[]` emptied
 * outright.
 *
 * A tape that DOES carry one (fix round 1, H1) renames every `trk` — in
 * `live[]` AND in `identity` records — through one bijection, drops every
 * `live[]` entry no `identity` record names, and rotates `m`/`st`/`rs`/`lsh`
 * on what remains. `RecordedTracker`, the literal definition of "reads
 * live[]", must therefore be caught on an identity tape too — the original
 * fix (rotating state fields only, leaving `trk`/`det` pairs untouched)
 * missed exactly this, because a COPIED `trk` value survived unchanged.
 *
 * Disarms:
 *  - in `isLiveIndependent`, replay `tape` twice instead of `tape` then
 *    `perturb(tape)` — "catches a tracker that reads live[] state" must fail;
 *  - in `perturbIdentityTape`, return `tape` unchanged (a no-op) — "catches
 *    RecordedTracker on an identity tape" must fail (this is the identity
 *    branch specifically; the plain-tape disarm above does not exercise it).
 */
import { describe, expect, it } from 'vitest'
import { sampleEnd, sampleFrame, sampleHeader } from '../../__tests__/tape-fixtures.js'
import { ProcessorTracker } from '../../trackers/processor-tracker.js'
import { RecordedTracker } from '../../trackers/recorded-tracker.js'
import type { Tape } from '../../tape-codec.js'
import type { TapeControlRecord, TapeFrame, TapeHeader, TapePlane } from '../../tape-schema.js'
import type { TapeFinalOutput, TapeStepOutput, TapeTracker } from '../../trackers/tape-tracker.js'
import { isLiveIndependent } from '../live-independence.js'

/** A tracker that CHEATS: it reads the OLD tracker's own `st` verdict off
 *  `live[]` to decide `confirmed` — exactly the class of read this harness
 *  exists to catch. */
class CheatingTracker implements TapeTracker {
  readonly name = 'cheating'
  start(_h: TapeHeader, _p: TapePlane): void {}
  control(_r: TapeControlRecord): void {}
  step(frame: TapeFrame): TapeStepOutput {
    return {
      outputs: frame.dets.map((d) => {
        const l = frame.live.find((x) => x.det === d.id)
        return {
          liveId: l?.trk ?? d.id,
          detectionId: d.id,
          box: d.b,
          kind: 'bound',
          confirmed: l?.st !== 'idle',
        }
      }),
      finalised: [],
    }
  }
  finish(_endT: number): TapeFinalOutput {
    return { finalised: [] }
  }
}

/** A cheater that STOPS copying `live[].trk` once it has seen an `identity`
 *  record for that track, and graduates to its own stable id — the exact
 *  shape the narrow exception permits, EXCEPT it also copies beforehand,
 *  which the exception never allows (fix round 1, H1: this must still be
 *  caught, since before the identity record fires there is no legitimate
 *  reason to read `live[]` at all). */
class CopyUntilIdentityTracker implements TapeTracker {
  readonly name = 'copy-until-identity'
  private readonly graduated = new Set<string>()
  start(_h: TapeHeader, _p: TapePlane): void {}
  step(frame: TapeFrame): TapeStepOutput {
    return {
      outputs: frame.dets.map((d) => {
        const l = frame.live.find((x) => x.det === d.id)
        const liveId = l !== undefined && !this.graduated.has(l.trk) ? l.trk : d.id
        return { liveId, detectionId: d.id, box: d.b, kind: 'bound', confirmed: true }
      }),
      finalised: [],
    }
  }
  control(record: TapeControlRecord): void {
    if (record.kind === 'identity') this.graduated.add(record.trk)
  }
  finish(_endT: number): TapeFinalOutput {
    return { finalised: [] }
  }
}

/** A tracker that legitimately uses the narrow exception: it remembers every
 *  frame's `trk` → `det` pairing, and on an `identity` record looks up which
 *  detection that live track bound — nothing else. Must still agree with
 *  itself under the fix round 1 perturbation (rename + drop), since the
 *  rename is a BIJECTION and `identity.trk` is renamed the same way. */
class IdentityUsingTracker implements TapeTracker {
  readonly name = 'identity-using'
  private readonly detByTrk = new Map<string, string>()
  private readonly identifiedDets = new Set<string>()
  start(_h: TapeHeader, _p: TapePlane): void {}
  step(frame: TapeFrame): TapeStepOutput {
    for (const l of frame.live) if (l.det !== undefined) this.detByTrk.set(l.trk, l.det)
    return {
      outputs: frame.dets.map((d) => ({
        liveId: d.id,
        detectionId: d.id,
        box: d.b,
        kind: 'bound',
        confirmed: this.identifiedDets.has(d.id),
      })),
      finalised: [],
    }
  }
  control(record: TapeControlRecord): void {
    if (record.kind !== 'identity' || record.fid === null) return
    const det = this.detByTrk.get(record.trk)
    if (det !== undefined) this.identifiedDets.add(det)
  }
  finish(_endT: number): TapeFinalOutput {
    return { finalised: [] }
  }
}

/** `id: 'd0'` and `trk: 'A'` on every frame — the same slot returns, the way a
 *  real per-frame ordinal reuses a number once the earlier subject leaves —
 *  so a later frame can observe what an earlier `identity` record settled. */
function frame(t: number, st: 'moving' | 'idle'): TapeFrame {
  return sampleFrame(t, {
    dets: [{ id: 'd0', k: 'first-level', cls: 'person', s: 0.9, b: [0, 0, 50, 100], src: 'frame' }],
    live: [{ trk: 'A', det: 'd0', m: true, st }],
  })
}

const PLAIN_TAPE: Tape = {
  header: sampleHeader(),
  body: [frame(0, 'moving'), frame(100, 'idle')],
  end: sampleEnd({ durationMs: 100, frames: 2 }),
}

const IDENTITY_TAPE: Tape = {
  header: sampleHeader(),
  body: [frame(0, 'moving'), { kind: 'identity', t: 50, trk: 'A', fid: 'p1' }, frame(100, 'idle')],
  end: sampleEnd({ durationMs: 100, frames: 2 }),
}

describe('isLiveIndependent', () => {
  it('catches a tracker that reads live[] state to decide its output', () => {
    expect(isLiveIndependent(PLAIN_TAPE, 'pipeline', () => new CheatingTracker())).toBe(false)
  })

  it('passes a tracker that reads only the detector inputs', () => {
    expect(isLiveIndependent(PLAIN_TAPE, 'pipeline', () => new ProcessorTracker())).toBe(true)
  })

  it('catches RecordedTracker on an identity tape (fix round 1, H1)', () => {
    expect(isLiveIndependent(PLAIN_TAPE, 'pipeline', () => new RecordedTracker())).toBe(false)
    expect(isLiveIndependent(IDENTITY_TAPE, 'pipeline', () => new RecordedTracker())).toBe(false)
  })

  it('catches a tracker that copies live[] until it sees an identity record (fix round 1, H1)', () => {
    expect(isLiveIndependent(IDENTITY_TAPE, 'pipeline', () => new CopyUntilIdentityTracker())).toBe(
      false,
    )
  })

  it('passes a tracker legitimately using the identity exception, on a tape carrying one', () => {
    expect(isLiveIndependent(IDENTITY_TAPE, 'pipeline', () => new IdentityUsingTracker())).toBe(
      true,
    )
  })
})

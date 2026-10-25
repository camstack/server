/**
 * Replay (spec §5.2, §7.1).
 *
 *  - determinism: the same tape through the same tracker twice gives the same
 *    hash;
 *  - the minter changes names only: `processor` with a random minter and with
 *    the sequential one gives the same partition;
 *  - `processor` reproduces the live bindings of a tape the real processor
 *    recorded (the synthetic scene) — which needs the recorded gate;
 *  - `processor` never reads `frame.live[]`: scrambling or emptying it on
 *    every frame of the tape must not change the replay's hash (H1, fix
 *    round 1);
 *  - `recorded` re-emits exactly the tape's own bindings;
 *  - control records are applied: a `drop` makes the tracker forget a track;
 *  - `identity` control records reach `control`, in tape order (M1, fix
 *    round 1);
 *  - `confirmed` means past the tracker's OWN birth gate (`minHits`), pinned
 *    directly rather than only implied by the synthetic scene (M2, fix
 *    round 1);
 *  - the one slot the committed cases use builds the production processor.
 *
 * Disarms: (1) in `ProcessorTracker.control`, ignore `drop` records — the drop
 * test must fail; (2) in `RecordedStationaryGate.load`, load nothing — "reproduces
 * the live bindings" must fail (the parked car is strong-held on the tape);
 * (3) in `RecordedTracker.step`, return `NO_OUTPUT` — the recorded test must fail;
 * (4) at the top of `ProcessorTracker.step`, re-emit `frame.live[]` verbatim
 * when it is non-empty (the way `RecordedTracker` does) — "does not read
 * live[]" must fail, even though every OTHER replay test still passes.
 */
import { describe, expect, it } from 'vitest'
import { newTrackId } from '../../pipeline/track-id.js'
import { replayTape, type ReplayResult } from '../replay.js'
import { buildSyntheticScenario } from '../synthetic.js'
import type { Tape } from '../tape-codec.js'
import type { TapeDetection, TapeFrame } from '../tape-schema.js'
import { CASE_TRACKER } from '../trackers/case-tracker.js'
import { ProcessorTracker } from '../trackers/processor-tracker.js'
import { RecordedTracker } from '../trackers/recorded-tracker.js'
import type { TapeTracker } from '../trackers/tape-tracker.js'
import { sampleEnd, sampleFrame, sampleHeader, sampleInputs } from './tape-fixtures.js'

function partition(r: ReplayResult): readonly string[] {
  const names = new Map<string, string>()
  return r.frames.flatMap((f) =>
    f.outputs
      .filter((o) => o.detectionId !== undefined)
      .map((o) => {
        if (!names.has(o.liveId)) names.set(o.liveId, `#${String(names.size + 1)}`)
        return `${String(f.t)}:${o.detectionId ?? ''}=${names.get(o.liveId) ?? ''}`
      }),
  )
}

function livePartition(tape: Tape): readonly string[] {
  const names = new Map<string, string>()
  return tape.body.flatMap((r) =>
    r.kind !== 'frame'
      ? []
      : r.live
          .filter((l) => l.det !== undefined)
          .map((l) => {
            if (!names.has(l.trk)) names.set(l.trk, `#${String(names.size + 1)}`)
            return `${String(r.t)}:${l.det ?? ''}=${names.get(l.trk) ?? ''}`
          }),
  )
}

describe('replayTape', () => {
  const { tape } = buildSyntheticScenario()

  it('is deterministic', () => {
    const a = replayTape(tape, new ProcessorTracker(), 'pipeline')
    const b = replayTape(tape, new ProcessorTracker(), 'pipeline')
    expect(a.hash).toBe(b.hash)
    expect(a.frames.length).toBeGreaterThan(200)
  })

  it('gives the same partition under a random minter', () => {
    const seq = replayTape(tape, new ProcessorTracker(), 'pipeline')
    const rnd = replayTape(tape, new ProcessorTracker({ mintTrackId: newTrackId }), 'pipeline')
    expect(partition(rnd)).toEqual(partition(seq))
  })

  it('reproduces the live bindings the real processor recorded', () => {
    expect(partition(replayTape(tape, new ProcessorTracker(), 'pipeline'))).toEqual(
      livePartition(tape),
    )
  })

  it('does not read live[]: emptying it on every frame changes nothing (H1)', () => {
    const a = replayTape(tape, new ProcessorTracker(), 'pipeline')
    const stripped: Tape = {
      ...tape,
      body: tape.body.map((r) => (r.kind === 'frame' ? { ...r, live: [] } : r)),
    }
    const b = replayTape(stripped, new ProcessorTracker(), 'pipeline')
    expect(b.hash).toBe(a.hash)
  })

  it('re-emits the recorded bindings, with the live ids themselves', () => {
    const r = replayTape(tape, new RecordedTracker(), 'pipeline')
    expect(partition(r)).toEqual(livePartition(tape))
    const first = tape.body.find(
      (x): x is TapeFrame => x.kind === 'frame' && x.live.some((l) => l.det !== undefined),
    )
    const firstLive = first?.live.find((l) => l.det !== undefined)
    expect(r.frames.find((f) => f.t === first?.t)?.outputs.map((o) => o.liveId)).toContain(
      firstLive?.trk,
    )
    expect(r.tracker).toBe('recorded')
  })

  it('applies a drop: the tracker forgets the track and the next box is a new id', () => {
    const inputs = sampleInputs()
    const oneHit = { ...inputs, sensitivity: { ...inputs.sensitivity, minHits: 1 } }
    const det = (t: number): TapeDetection => ({
      id: `p-${String(t)}`,
      k: 'first-level',
      cls: 'person',
      s: 0.9,
      b: [100 + t / 100, 100, 50, 120],
      src: 'frame',
    })
    const frame = (t: number): TapeFrame => ({
      kind: 'frame',
      t,
      plane: 'pipeline',
      w: 1280,
      h: 720,
      dets: [det(t)],
      disc: [],
      inj: [],
      live: [],
    })
    const dropped: Tape = {
      header: sampleHeader({ planes: { pipeline: oneHit } }),
      // The drop names the LIVE id (`live-7`), bound on its own frame — never
      // the replay's `t1` (D683 Task 12, M4: this test used to name `t1`, which
      // only worked because the untranslated live id happened to match).
      body: [
        frame(0),
        { ...frame(140), live: [{ trk: 'live-7', det: 'p-140', m: true, st: 'moving' }] },
        { kind: 'drop', t: 140, plane: 'pipeline', trk: 'live-7', reason: 'dropped' },
        frame(280),
      ],
      end: sampleEnd({ durationMs: 280, frames: 3 }),
    }
    const r = replayTape(dropped, new ProcessorTracker(), 'pipeline')
    const ids = r.frames.map((f) => f.outputs.find((o) => o.detectionId !== undefined)?.liveId)
    expect(ids[0]).toBe('t1')
    expect(ids[1]).toBe('t1')
    expect(ids[2]).not.toBe('t1')
  })

  it("confirmed means past the tracker's own birth gate (minHits), not any later gate (M2)", () => {
    const inputs = sampleInputs()
    const threeHits = { ...inputs, sensitivity: { ...inputs.sensitivity, minHits: 3 } }
    const det = (t: number): TapeDetection => ({
      id: `p-${String(t)}`,
      k: 'first-level',
      cls: 'person',
      s: 0.9,
      b: [100, 100, 50, 120],
      src: 'frame',
    })
    const frame = (t: number): TapeFrame => ({
      kind: 'frame',
      t,
      plane: 'pipeline',
      w: 1280,
      h: 720,
      dets: [det(t)],
      disc: [],
      inj: [],
      live: [],
    })
    const gated: Tape = {
      header: sampleHeader({ planes: { pipeline: threeHits } }),
      body: [frame(0), frame(140), frame(280)],
      end: sampleEnd({ durationMs: 280, frames: 3 }),
    }
    const r = replayTape(gated, new ProcessorTracker(), 'pipeline')
    // Below minHits: the tracker's update() never emits the track at all — not
    // even coasting — so the first two frames have no output whatsoever.
    expect(r.frames[0]?.outputs).toEqual([])
    expect(r.frames[1]?.outputs).toEqual([])
    expect(r.frames[2]?.outputs).toHaveLength(1)
    expect(r.frames[2]?.outputs[0]?.confirmed).toBe(true)
  })

  it('passes identity control records to the tracker, in tape order (M1)', () => {
    const calls: string[] = []
    const spy: TapeTracker = {
      name: 'spy',
      start: () => {},
      control: (record) => calls.push(record.kind),
      step: () => ({ outputs: [], finalised: [] }),
      finish: () => ({ finalised: [] }),
    }
    const withIdentity: Tape = {
      header: sampleHeader(),
      body: [
        sampleFrame(0),
        { kind: 'identity', t: 100, trk: 'trk-a', fid: 'p1' },
        sampleFrame(140),
      ],
      end: sampleEnd({ durationMs: 140, frames: 2 }),
    }
    replayTape(withIdentity, spy, 'pipeline')
    expect(calls).toEqual(['identity'])
  })

  it('the case slot is the production processor', () => {
    expect(CASE_TRACKER().name).toBe('processor')
  })
})

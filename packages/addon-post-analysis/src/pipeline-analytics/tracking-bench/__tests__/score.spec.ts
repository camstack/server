/**
 * Local scoring (spec §5.4): truth from the marks, two replays (their hashes
 * must match), the standard metrics on FINAL ids and the operator metrics.
 * A metric cross-check that needs no reference implementation: the same
 * re-acquired subject scores IDF1 0.75 while the tracker keeps two ids and
 * 1 once a finalisation fuses them.
 *
 * Disarm: in `scoreTape`, compare `first.hash` with itself instead of with a
 * second replay — "refuses a tracker that is not deterministic" must fail.
 */
import { describe, expect, it } from 'vitest'
import type { GroundTruthFile } from '../ground-truth.js'
import { scoreTape } from '../score.js'
import type { Tape } from '../tape-codec.js'
import type { TapeControlRecord, TapeFrame, TapeHeader, TapePlane } from '../tape-schema.js'
import { RecordedTracker } from '../trackers/recorded-tracker.js'
import type { TapeFinalOutput, TapeStepOutput, TapeTracker } from '../trackers/tape-tracker.js'
import { sampleEnd, sampleFrame, sampleHeader } from './tape-fixtures.js'

/** A binds 0–200, B binds 300–500 (the same person, re-acquired), C throughout. */
function frame(t: number): TapeFrame {
  const bindings: [string, string][] = [[`c-${String(t)}`, 'C']]
  if (t <= 200) bindings.push([`a-${String(t)}`, 'A'])
  else bindings.push([`b-${String(t)}`, 'B'])
  return sampleFrame(t, {
    dets: bindings.map(([id], i) => ({
      id,
      k: 'first-level',
      cls: 'person',
      s: 0.9,
      b: [i * 200, 0, 50, 120],
      src: 'frame',
    })),
    live: bindings.map(([det, trk]) => ({ trk, det, m: true, st: 'moving' })),
  })
}

const TAPE: Tape = {
  header: sampleHeader(),
  body: [0, 100, 200, 300, 400, 500].map(frame),
  end: sampleEnd({ durationMs: 500, frames: 6, reason: 'window-end' }),
}

function gt(over: Partial<GroundTruthFile> = {}): GroundTruthFile {
  return {
    version: 1,
    reviewed: true,
    relations: [{ a: 'A', b: 'B', relation: 'same-subject' }],
    purities: [],
    external: [],
    ...over,
  }
}

/** The recorded ids, with B finalised into A at the end. */
class FusingTracker implements TapeTracker {
  readonly name = 'fusing'
  private readonly inner = new RecordedTracker()
  start(header: TapeHeader, plane: TapePlane): void {
    this.inner.start(header, plane)
  }
  control(record: TapeControlRecord): void {
    this.inner.control(record)
  }
  step(f: TapeFrame): TapeStepOutput {
    return this.inner.step(f)
  }
  finish(endT: number): TapeFinalOutput {
    return { finalised: [{ provisionalId: 'B', finalId: 'A', t: endT }] }
  }
}

let instances = 0
/** Names its one track after how many instances exist: not deterministic. */
class DriftingTracker implements TapeTracker {
  readonly name = 'drifting'
  private readonly seed = (instances += 1)
  start(_header: TapeHeader, _plane: TapePlane): void {}
  control(_record: TapeControlRecord): void {}
  step(f: TapeFrame): TapeStepOutput {
    const d = f.dets[0]
    return {
      outputs:
        d === undefined
          ? []
          : [
              {
                liveId: `n${String(this.seed)}`,
                detectionId: d.id,
                box: d.b,
                kind: 'bound',
                confirmed: true,
              },
            ],
      finalised: [],
    }
  }
  finish(_endT: number): TapeFinalOutput {
    return { finalised: [] }
  }
}

const NOW = (): number => 0

describe('scoreTape', () => {
  it('scores the recorded split at IDF1 0.75 and one re-split presence of two', () => {
    const r = scoreTape(
      { tape: TAPE, gt: gt(), plane: 'pipeline' },
      () => new RecordedTracker(),
      NOW,
    )
    if (!r.ok) throw new Error(r.detail)
    expect(r.tracker).toBe('recorded')
    expect(r.metrics.IDF1).toBeCloseTo(0.75, 12)
    expect(r.metrics.idsPerPresence).toBeCloseTo(1.5, 12)
    expect(r.metrics.resplitShare).toBeCloseTo(0.5, 12)
    expect(r.metrics.frames).toBe(6)
    expect(r.warnings).toEqual([])
  })

  it('scores identity on FINAL ids: a fusion lifts IDF1 to 1', () => {
    const r = scoreTape({ tape: TAPE, gt: gt(), plane: 'pipeline' }, () => new FusingTracker(), NOW)
    if (!r.ok) throw new Error(r.detail)
    expect(r.metrics.IDF1).toBeCloseTo(1, 12)
    expect(r.metrics.resplitShare).toBe(0)
  })

  it('refuses contradicting marks, naming the chain', () => {
    const r = scoreTape(
      {
        tape: TAPE,
        gt: gt({
          relations: [
            { a: 'A', b: 'B', relation: 'same-subject' },
            { a: 'A', b: 'B', relation: 'different-subjects' },
          ],
        }),
        plane: 'pipeline',
      },
      () => new RecordedTracker(),
      NOW,
    )
    expect(r).toEqual({
      ok: false,
      code: 'contradiction',
      detail: 'different-subjects inside a same-subject chain: A → B',
    })
  })

  it('refuses a tracker that is not deterministic', () => {
    const r = scoreTape(
      { tape: TAPE, gt: gt(), plane: 'pipeline' },
      () => new DriftingTracker(),
      NOW,
    )
    expect(r).toMatchObject({ ok: false, code: 'nondeterministic' })
  })

  it('scores an unreviewed or gapped tape, and says so', () => {
    const gapped: Tape = {
      ...TAPE,
      body: [{ kind: 'gap', fromT: 250, toT: 290, reason: 'backpressure' }, ...TAPE.body],
    }
    const r = scoreTape(
      { tape: gapped, gt: gt({ reviewed: false }), plane: 'pipeline' },
      () => new RecordedTracker(),
      NOW,
    )
    if (!r.ok) throw new Error(r.detail)
    expect(r.warnings.join('\n')).toContain('gap')
    expect(r.warnings.join('\n')).toContain('not marked reviewed')
  })
})

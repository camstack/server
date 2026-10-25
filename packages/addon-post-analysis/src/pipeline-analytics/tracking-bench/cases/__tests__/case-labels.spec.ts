/**
 * The operator's labels, asserted on a replay (D681, plan decision 16):
 * "same subject" pieces must end under ONE final id, "different subjects"
 * pieces must not, and a labelled piece the replay never bound is a
 * violation. A deferred linker's finalisation counts — that is how a v2
 * tracker fuses two pieces of one subject.
 *
 * Disarm: in `finalIdsByDetection`, store `o.liveId` instead of
 * `finalOf(o.liveId)` — "a finalisation that fuses the pieces honours it"
 * must fail.
 */
import { describe, expect, it } from 'vitest'
import type { GroundTruthFile } from '../../ground-truth.js'
import { replayTape, type ReplayResult } from '../../replay.js'
import type { Tape } from '../../tape-codec.js'
import type { TapeFrame } from '../../tape-schema.js'
import { RecordedTracker } from '../../trackers/recorded-tracker.js'
import { sampleEnd, sampleFrame, sampleHeader } from '../../__tests__/tape-fixtures.js'
import type { CaseContent } from '../case-fixture.js'
import { checkCaseLabels, formatCaseReport } from '../case-labels.js'

/** A binds frames 0–200, B binds 300–500 (the same person, re-acquired), C is
 *  a second person present throughout. */
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

function content(gt: Partial<GroundTruthFile>): CaseContent {
  return {
    manifest: {
      version: 1,
      slug: 'unit-case',
      deviceId: 101,
      plane: 'pipeline',
      lighting: 'day',
      status: 'held',
      recordedDate: '2026-09-29',
      importedDate: '2026-09-29',
      frames: 6,
    },
    tape: TAPE,
    gt: { version: 1, reviewed: true, relations: [], purities: [], external: [], ...gt },
  }
}

const recorded = (): ReplayResult => replayTape(TAPE, new RecordedTracker(), 'pipeline')

describe('checkCaseLabels', () => {
  it('a same-subject pair split across two final ids is a violation', () => {
    const r = checkCaseLabels(
      content({ relations: [{ a: 'A', b: 'B', relation: 'same-subject' }] }),
      recorded(),
    )
    expect(r).toEqual({
      slug: 'unit-case',
      tracker: 'recorded',
      checked: 1,
      skipped: 0,
      violations: [{ kind: 'same-subject-split', a: 'A', b: 'B', finalA: 'A', finalB: 'B' }],
    })
    expect(formatCaseReport(r).join('\n')).toContain('same subject, split')
  })

  it('a finalisation that fuses the pieces honours it', () => {
    const fused: ReplayResult = {
      ...recorded(),
      finalisations: [{ provisionalId: 'B', finalId: 'A', t: 500 }],
    }
    const r = checkCaseLabels(
      content({ relations: [{ a: 'A', b: 'B', relation: 'same-subject' }] }),
      fused,
    )
    expect(r.violations).toEqual([])
    expect(r.checked).toBe(1)
  })

  it('different subjects fused into one final id is a violation', () => {
    const fused: ReplayResult = {
      ...recorded(),
      finalisations: [{ provisionalId: 'C', finalId: 'A', t: 500 }],
    }
    const r = checkCaseLabels(
      content({ relations: [{ a: 'A', b: 'C', relation: 'different-subjects' }] }),
      fused,
    )
    expect(r.violations).toEqual([
      { kind: 'different-subjects-merged', a: 'A', b: 'C', finalId: 'A' },
    ])
  })

  it('judges a mixed track by side, and skips it without a switch', () => {
    const sided = checkCaseLabels(
      content({
        relations: [{ a: 'A', b: 'C', relation: 'same-subject', bSide: 'before' }],
        purities: [{ trk: 'C', purity: 'mixed', switchT: 250 }],
      }),
      recorded(),
    )
    expect(sided.violations).toEqual([
      { kind: 'same-subject-split', a: 'A', b: 'C#before', finalA: 'A', finalB: 'C' },
    ])
    const blind = checkCaseLabels(
      content({
        relations: [{ a: 'A', b: 'C', relation: 'same-subject' }],
        purities: [{ trk: 'C', purity: 'mixed' }],
      }),
      recorded(),
    )
    expect(blind).toMatchObject({ checked: 0, skipped: 1, violations: [] })
  })

  it('skips a relation on a not-a-subject track', () => {
    const r = checkCaseLabels(
      content({
        relations: [{ a: 'A', b: 'C', relation: 'different-subjects' }],
        purities: [{ trk: 'C', purity: 'not-a-subject' }],
      }),
      recorded(),
    )
    expect(r).toMatchObject({ checked: 0, skipped: 1, violations: [] })
  })

  it('a labelled piece the replay never bound is unbound', () => {
    const base = recorded()
    const withoutB: ReplayResult = {
      ...base,
      frames: base.frames.map((f) => ({
        ...f,
        outputs: f.outputs.filter((o) => o.liveId !== 'B'),
      })),
    }
    const r = checkCaseLabels(
      content({ relations: [{ a: 'A', b: 'B', relation: 'same-subject' }] }),
      withoutB,
    )
    expect(r.violations).toEqual([{ kind: 'unbound', piece: 'B' }])
  })
})

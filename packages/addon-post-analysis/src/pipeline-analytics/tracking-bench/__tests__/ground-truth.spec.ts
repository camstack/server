/**
 * Marks → truth over a tape (spec §4.4):
 *  - identities are union-find over same-subject;
 *  - a different-subjects inside one component refuses, naming the chain;
 *  - a mixed track with a switch is two pieces; without one it is IGNORE and
 *    counted unscorable;
 *  - not-a-subject detections are NOT truth (a bound output is a false positive);
 *  - detections no live track bound, and discarded boxes, are ignore regions;
 *  - `continuous` turns the time between two tracks into a presence gap;
 *  - export keeps relations with both ends inside, `external` for one end.
 *
 * Disarm: skip the contradiction check in `deriveTruth` — the chain test fails.
 *
 * (Amended 2026-09-29, Task 12 fix round.) Face pseudonyms (`fid`) are keyed
 * per recorder SESSION — one per boot — and a promoted tape turns every
 * session change into a `restart` gap. `deriveTruth` also auto-derives a
 * cannot-link from two tracks the recognizer settled with DIFFERENT `fid`s,
 * but only inside one restart-free span: the same face is legitimately `p1`
 * before a restart and `p2` after it, because the HMAC key rotated, not
 * because the person changed.
 * Disarm: in `trackFidEpochs`, drop the `epoch += 1` on a `restart` gap (one
 * global epoch) — the boot-boundary test turns into a false contradiction.
 *
 * (Fix round 1, review H1.) The operator's marks always win: an explicit
 * same-subject mark — direct, or through the operator's own union — outranks
 * the auto fid cannot-link for that pair. It is suppressed and listed in
 * `Truth.suppressedAuto`, logged at info, never refused; only an explicit
 * operator SELF-contradiction still fails (`reason: 'operator-contradiction'`,
 * named distinctly from anything automatic).
 * Disarm: in `deriveTruth`'s auto cannot-link loop, replace the `continue` on
 * a union-find match with the old `return { ok: false, reason:
 * 'operator-contradiction', chain: bfsPath(...) }` — the suppression test
 * turns into a contradiction.
 */
import type { TrackPurity, TrackRelation } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeLogRecorder, makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { Tape } from '../tape-codec.js'
import {
  deriveTruth,
  exportGroundTruth,
  GroundTruthFileSchema,
  type GroundTruthFile,
} from '../ground-truth.js'
import { sampleEnd, sampleFrame, sampleHeader } from './tape-fixtures.js'

function frame(
  t: number,
  bindings: readonly [string, string][],
  extraDets: readonly string[] = [],
): Tape['body'][number] {
  const ids = [...bindings.map(([det]) => det), ...extraDets]
  return sampleFrame(t, {
    dets: ids.map((id, i) => ({
      id,
      k: 'first-level',
      cls: 'person',
      s: 0.9,
      b: [i * 100, 0, 50, 100],
      src: 'frame',
    })),
    disc: [{ b: [900, 0, 10, 10], cls: 'person', s: 0.4, r: 'below-threshold' }],
    live: bindings.map(([det, trk]) => ({ trk, det, m: true, st: 'moving' })),
  })
}

const TAPE: Tape = {
  header: sampleHeader(),
  body: [
    frame(
      100,
      [
        ['a1', 'A'],
        ['m1', 'M'],
        ['n1', 'N'],
      ],
      ['free1'],
    ),
    frame(200, [['m2', 'M']]),
    frame(5_000, [['b1', 'B']]),
  ],
  end: sampleEnd({ durationMs: 5_000, frames: 3 }),
}

function gt(over: Partial<GroundTruthFile> = {}): GroundTruthFile {
  return { version: 1, reviewed: true, relations: [], purities: [], external: [], ...over }
}

describe('deriveTruth', () => {
  it('joins same-subject tracks and turns a continuous mark into a presence gap', () => {
    const r = deriveTruth(
      TAPE,
      gt({ relations: [{ a: 'A', b: 'B', relation: 'same-subject', presence: 'continuous' }] }),
      'pipeline',
      makeSilentLogger(),
    )
    if (!r.ok) throw new Error('expected truth')
    const a1 = r.truth.frames[0]?.boxes.find((b) => b.detectionId === 'a1')
    const b1 = r.truth.frames[2]?.boxes.find((b) => b.detectionId === 'b1')
    expect(a1?.identity).toBe(b1?.identity)
    expect(r.truth.presenceGaps).toEqual([{ identity: a1?.identity, fromT: 100, toT: 5_000 }])
  })

  it('refuses a different-subjects inside a same-subject chain, naming it', () => {
    const r = deriveTruth(
      TAPE,
      gt({
        relations: [
          { a: 'A', b: 'M', relation: 'same-subject' },
          { a: 'M', b: 'B', relation: 'same-subject' },
          { a: 'A', b: 'B', relation: 'different-subjects' },
        ],
      }),
      'pipeline',
      makeSilentLogger(),
    )
    expect(r).toEqual({ ok: false, reason: 'operator-contradiction', chain: ['A', 'M', 'B'] })
  })

  it('splits a mixed track at its switch; without one it is ignore and unscorable', () => {
    const split = deriveTruth(
      TAPE,
      gt({ purities: [{ trk: 'M', purity: 'mixed', switchT: 150 }] }),
      'pipeline',
      makeSilentLogger(),
    )
    if (!split.ok) throw new Error('expected truth')
    const before = split.truth.frames[0]?.boxes.find((b) => b.detectionId === 'm1')?.identity
    const after = split.truth.frames[1]?.boxes.find((b) => b.detectionId === 'm2')?.identity
    expect(before).not.toBe(after)
    const blind = deriveTruth(
      TAPE,
      gt({ purities: [{ trk: 'M', purity: 'mixed' }] }),
      'pipeline',
      makeSilentLogger(),
    )
    if (!blind.ok) throw new Error('expected truth')
    expect(blind.truth.frames[0]?.ignoreDetections).toContain('m1')
    expect(blind.truth.unscorableTracks).toBe(1)
  })

  it('drops not-a-subject from truth without making it ignore, and ignores unbound and discarded boxes', () => {
    const r = deriveTruth(
      TAPE,
      gt({ purities: [{ trk: 'N', purity: 'not-a-subject' }] }),
      'pipeline',
      makeSilentLogger(),
    )
    if (!r.ok) throw new Error('expected truth')
    const f0 = r.truth.frames[0]
    expect(f0?.boxes.map((b) => b.detectionId)).not.toContain('n1')
    expect(f0?.ignoreDetections).not.toContain('n1')
    expect(f0?.ignoreDetections).toContain('free1')
    expect(f0?.ignoreBoxes).toEqual([[900, 0, 10, 10]])
  })

  it('suppresses (never refuses) an explicit same-subject mark across two tracks recognised with different fids in one session, and lists it', () => {
    const oneEpoch: Tape = {
      header: sampleHeader(),
      body: [
        frame(100, [['a1', 'A']]),
        { kind: 'identity', t: 150, trk: 'A', fid: 'p1' },
        frame(200, [['b1', 'B']]),
        { kind: 'identity', t: 250, trk: 'B', fid: 'p2' },
      ],
      end: sampleEnd({ durationMs: 250, frames: 2 }),
    }
    const { logger, entries } = makeLogRecorder()
    const r = deriveTruth(
      oneEpoch,
      gt({ relations: [{ a: 'A', b: 'B', relation: 'same-subject' }] }),
      'pipeline',
      logger,
    )
    if (!r.ok) throw new Error('expected truth: the operator mark must win, not refuse')
    expect(r.truth.suppressedAuto).toEqual([
      { a: 'A', b: 'B', aFid: 'p1', bFid: 'p2', reason: 'operator-same-subject' },
    ])
    const a1 = r.truth.frames[0]?.boxes.find((b) => b.detectionId === 'a1')
    const b1 = r.truth.frames[1]?.boxes.find((b) => b.detectionId === 'b1')
    expect(a1?.identity).toBe(b1?.identity)
    expect(
      entries.some(
        (e) => e.level === 'info' && e.message === 'recognizer disagreed with the operator',
      ),
    ).toBe(true)
  })

  it('still refuses an operator same/different self-contradiction even with fid data present', () => {
    const oneEpoch: Tape = {
      header: sampleHeader(),
      body: [
        frame(100, [['a1', 'A']]),
        { kind: 'identity', t: 150, trk: 'A', fid: 'p1' },
        frame(200, [['b1', 'B']]),
        { kind: 'identity', t: 250, trk: 'B', fid: 'p1' },
      ],
      end: sampleEnd({ durationMs: 250, frames: 2 }),
    }
    const r = deriveTruth(
      oneEpoch,
      gt({
        relations: [
          { a: 'A', b: 'B', relation: 'same-subject' },
          { a: 'A', b: 'B', relation: 'different-subjects' },
        ],
      }),
      'pipeline',
      makeSilentLogger(),
    )
    expect(r).toEqual({ ok: false, reason: 'operator-contradiction', chain: ['A', 'B'] })
  })

  it('never turns different fids across a restart gap into a cannot-link (D681 amendment)', () => {
    const acrossRestart: Tape = {
      header: sampleHeader(),
      body: [
        frame(100, [['a1', 'A']]),
        { kind: 'identity', t: 150, trk: 'A', fid: 'p1' },
        { kind: 'gap', fromT: 200, toT: 1_000, reason: 'restart' },
        frame(1_000, [['b1', 'B']]),
        { kind: 'identity', t: 1_050, trk: 'B', fid: 'p2' },
      ],
      end: sampleEnd({ durationMs: 1_050, frames: 2 }),
    }
    const r = deriveTruth(
      acrossRestart,
      gt({ relations: [{ a: 'A', b: 'B', relation: 'same-subject' }] }),
      'pipeline',
      makeSilentLogger(),
    )
    if (!r.ok) throw new Error('expected truth: a restart gap must never manufacture a cannot-link')
    const a1 = r.truth.frames[0]?.boxes.find((b) => b.detectionId === 'a1')
    const b1 = r.truth.frames[1]?.boxes.find((b) => b.detectionId === 'b1')
    expect(a1?.identity).toBe(b1?.identity)
    expect(r.truth.suppressedAuto).toEqual([])
  })
})

describe('exportGroundTruth', () => {
  const base = {
    id: 'x',
    deviceId: 101,
    leftSide: null,
    rightSide: null,
    presence: null,
    leftStartedAt: 1_000_050,
    rightStartedAt: 1_000_100,
    createdAt: 0,
    updatedAt: 0,
    author: null,
  } as const
  it('keeps inside relations, marks one-sided ones external, rebases purity switches', () => {
    const relations: TrackRelation[] = [
      { ...base, leftTrackId: 'A', rightTrackId: 'B', relation: 'same-subject' },
      { ...base, leftTrackId: 'A', rightTrackId: 'OUT', relation: 'different-subjects' },
    ]
    const purities: TrackPurity[] = [
      {
        id: 'M',
        deviceId: 101,
        sourceTrackId: 'M',
        purity: 'mixed',
        switchAtMs: 1_000_150,
        startedAt: 1_000_100,
        createdAt: 0,
        updatedAt: 0,
        author: null,
      },
    ]
    const out = exportGroundTruth({
      liveTrackIds: ['A', 'B', 'M'],
      fromMs: 1_000_000,
      toMs: 1_005_000,
      reviewed: true,
      relations,
      purities,
    })
    expect(out).toEqual({
      version: 1,
      reviewed: true,
      relations: [{ a: 'A', b: 'B', relation: 'same-subject' }],
      purities: [{ trk: 'M', purity: 'mixed', switchT: 150 }],
      external: [{ inside: 'A', relation: 'different-subjects' }],
    })
    expect(GroundTruthFileSchema.parse(out)).toEqual(out)
  })
})

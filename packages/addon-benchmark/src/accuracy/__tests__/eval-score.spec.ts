import { describe, expect, it } from 'vitest'
import type { EvalBox, EvalDetection, EvalSampleBody } from '../../benchmark-schemas.js'
import { EvalSampleBodySchema, EvalRunSummarySchema } from '../../benchmark-schemas.js'
import {
  diffRuns,
  type EvalLabel,
  type EvalScoringSample,
  latencyStats,
  scoreRun,
} from '../eval-score.js'

const box = (x: number, y: number, w: number, h: number): EvalBox => ({ x, y, w, h })

const sample = (sampleId: string, lighting: string | null = 'day'): EvalScoringSample => ({
  sampleId,
  nativeWidth: 3840,
  nativeHeight: 2160,
  lighting,
})

const det = (
  macro: string,
  score: number,
  b: EvalBox,
  origin: EvalDetection['origin'] = 'full',
): EvalDetection => ({ macro, cls: null, score, box: b, origin })

const label = (
  status: string,
  boxes: EvalLabel['boxes'],
  extra: Partial<Pick<EvalLabel, 'ignore' | 'phantoms'>> = {},
): EvalLabel => ({ status, boxes, ignore: extra.ignore ?? [], phantoms: extra.phantoms ?? [] })

const result = (
  sampleId: string,
  final: readonly EvalDetection[],
  extra: Partial<EvalSampleBody> = {},
): EvalSampleBody =>
  EvalSampleBodySchema.parse({
    runId: 'run-1',
    sampleId,
    ok: true,
    refusal: null,
    full: final.filter((d) => d.origin === 'full'),
    final,
    recipe: null,
    timings: {
      fullStepMs: null,
      fullPredictMs: null,
      fullWallMs: null,
      frameStepMs: null,
      cropStepMs: [],
    },
    flooredCount: 0,
    ...extra,
  })

const PERSON = box(0.1, 0.1, 0.2, 0.4) // large in the 640 view
const SMALL_ANIMAL = box(0.8, 0.8, 0.02, 0.02) // ≈ 13×7 px in the view → small

describe('scoreRun', () => {
  it('counts tp / fp / fn per class and per size, and the FP rate on empty frames', () => {
    const samples = [sample('a'), sample('b')]
    const labels = new Map([
      [
        'a',
        label('reviewed', [
          { macro: 'person', box: PERSON },
          { macro: 'animal', box: SMALL_ANIMAL },
        ]),
      ],
      ['b', label('reviewed', [])],
    ])
    const results = new Map([
      ['a', result('a', [det('person', 0.9, PERSON)])],
      ['b', result('b', [det('vehicle', 0.7, box(0.5, 0.5, 0.1, 0.1))])],
    ])
    const r = scoreRun(samples, labels, results)
    expect([r.overall.tp, r.overall.fp, r.overall.fn]).toEqual([1, 1, 1])
    expect(r.overall.recall).toBe(0.5)
    expect(r.overall.precision).toBe(0.5)
    expect(r.byClass['person']).toMatchObject({ tp: 1, recall: 1, precision: 1 })
    expect(r.byClass['animal']).toMatchObject({ fn: 1, recall: 0, precision: null })
    expect(r.byClass['vehicle']).toMatchObject({ fp: 1, recall: null, precision: 0 })
    expect(r.bySize['small']).toMatchObject({ fn: 1 })
    expect(r.bySize['large']).toMatchObject({ tp: 1 })
    expect(r.byClassSize['animal/small']).toMatchObject({ fn: 1 })
    expect(r.emptyFrames).toEqual({ frames: 1, framesWithFp: 1, fpBoxes: 1, fpFrameRate: 1 })
  })

  it('scores per lighting, an unknown lighting under its own key', () => {
    const labels = new Map([
      ['day', label('reviewed', [{ macro: 'person', box: PERSON }])],
      ['night', label('reviewed', [{ macro: 'person', box: PERSON }])],
      ['dark', label('reviewed', [{ macro: 'person', box: PERSON }])],
    ])
    const results = new Map([
      ['day', result('day', [det('person', 0.9, PERSON)])],
      ['night', result('night', [])],
      ['dark', result('dark', [det('person', 0.9, PERSON)])],
    ])
    const r = scoreRun(
      [sample('day', 'day'), sample('night', 'night-ir'), sample('dark', null)],
      labels,
      results,
    )
    expect(r.byLighting['day']?.recall).toBe(1)
    expect(r.byLighting['night-ir']?.recall).toBe(0)
    expect(r.byLighting['unknown']?.recall).toBe(1)
  })

  it('scores the full pass alone apart from the final output', () => {
    const labels = new Map([['a', label('reviewed', [{ macro: 'animal', box: SMALL_ANIMAL }])]])
    const results = new Map([['a', result('a', [det('animal', 0.85, SMALL_ANIMAL, 'recovered')])]])
    expect(scoreRun([sample('a')], labels, results, 'final').overall.tp).toBe(1)
    const full = scoreRun([sample('a')], labels, results, 'full')
    expect(full.which).toBe('full')
    expect(full.overall).toMatchObject({ tp: 0, fn: 1 })
  })

  it('ignores classes outside person / vehicle / animal on both sides', () => {
    const labels = new Map([['a', label('coco', [{ macro: 'ignore', box: PERSON }])]])
    const results = new Map([['a', result('a', [det('face', 0.9, PERSON)])]])
    const r = scoreRun([sample('a')], labels, results)
    expect(r.overall).toMatchObject({ tp: 0, fp: 0, fn: 0, recall: null, precision: null })
    expect(r.emptyFrames.framesWithFp).toBe(0)
  })

  it('a prediction inside an ignore (crowd) region is neither TP nor FP', () => {
    const labels = new Map([['a', label('coco', [], { ignore: [box(0, 0, 0.5, 0.5)] })]])
    const results = new Map([['a', result('a', [det('person', 0.8, box(0.1, 0.1, 0.1, 0.1))])]])
    expect(scoreRun([sample('a')], labels, results).overall.fp).toBe(0)
  })

  it('reports a failed sample as missing, never as misses, and counts label statuses', () => {
    const labels = new Map([
      ['a', label('reviewed', [{ macro: 'person', box: PERSON }])],
      ['b', label('prelabel', [{ macro: 'person', box: PERSON }])],
    ])
    const results = new Map([['a', result('a', [], { ok: false, refusal: 'model-not-servable' })]])
    const r = scoreRun([sample('a'), sample('b'), sample('unlabelled')], labels, results)
    expect(r.missing).toBe(2)
    expect(r.scored).toBe(0)
    expect(r.overall.fn).toBe(0)
    expect(r.labelStatuses).toEqual({ reviewed: 1, prelabel: 1 })
  })

  it('counts a model_error phantom the run draws AGAIN as repeated', () => {
    const phantom = box(0.6, 0.1, 0.1, 0.2)
    const labels = new Map([
      ['a', label('reviewed', [], { phantoms: [{ macro: 'person', box: phantom }] })],
      ['b', label('reviewed', [], { phantoms: [{ macro: 'vehicle', box: phantom }] })],
    ])
    const results = new Map([
      // the same phantom again
      ['a', result('a', [det('person', 0.7, box(0.61, 0.1, 0.1, 0.2))])],
      // a box on the same spot but another class does not repeat it
      ['b', result('b', [det('animal', 0.7, phantom)])],
    ])
    const r = scoreRun([sample('a'), sample('b')], labels, results)
    expect(r.phantoms).toEqual({
      boxes: 2,
      repeated: 1,
      repeatRate: 0.5,
      byClass: { person: { boxes: 1, repeated: 1 }, vehicle: { boxes: 1, repeated: 0 } },
    })
    // A repeated phantom is also a false positive on a negative frame.
    expect(r.emptyFrames.framesWithFp).toBe(2)
  })

  it('answers no phantom rate when the dataset has no model_error box', () => {
    const r = scoreRun(
      [sample('a')],
      new Map([['a', label('reviewed', [])]]),
      new Map([['a', result('a', [])]]),
    )
    expect(r.phantoms).toEqual({ boxes: 0, repeated: 0, repeatRate: null, byClass: {} })
    expect(r.emptyFrames.fpFrameRate).toBe(0)
  })
})

describe('latencyStats', () => {
  it('takes p50 / p95 over the samples that ran, leaving untimed ones out', () => {
    const timed = (
      id: string,
      ms: number | null,
      crops: readonly (number | null)[],
    ): EvalSampleBody =>
      result(id, [det('animal', 0.9, SMALL_ANIMAL, 'recovered')], {
        timings: {
          fullStepMs: ms,
          fullPredictMs: ms,
          fullWallMs: ms === null ? null : ms + 5,
          frameStepMs: ms === null ? null : ms + crops.reduce<number>((a, c) => a + (c ?? 0), 0),
          cropStepMs: [...crops],
        },
        flooredCount: 1,
      })
    const results = new Map([
      ['a', timed('a', 10, [4])],
      ['b', timed('b', 20, [])],
      ['c', timed('c', null, [null])],
      ['d', result('d', [], { ok: false, refusal: 'node offline' })],
    ])
    const s = latencyStats(results)
    expect(s.fullStepMs).toEqual({ n: 2, p50: 20, p95: 20 })
    expect(s.fullWallMs).toEqual({ n: 2, p50: 25, p95: 25 })
    expect(s.frameStepMs).toEqual({ n: 2, p50: 20, p95: 20 })
    expect(s.cropStepMs).toEqual({ n: 1, p50: 4, p95: 4 })
    expect(s.cropsPerFrame).toBe(0.667)
    expect(s.flooredCropBoxes).toBe(3)
    expect(s.recoveredBoxes).toBe(3)
  })

  it('answers null, not 0, over a run where nothing ran', () => {
    const s = latencyStats(new Map())
    expect(s.fullStepMs).toEqual({ n: 0, p50: null, p95: null })
    expect(s.cropsPerFrame).toBeNull()
  })
})

describe('diffRuns', () => {
  it('names the boxes lost and gained against the reference, per class×size', () => {
    const extra = det('vehicle', 0.6, box(0.4, 0.4, 0.3, 0.3))
    const lostAnimal = det('animal', 0.8, SMALL_ANIMAL)
    const ref = new Map([['a', result('a', [det('person', 0.9, PERSON), lostAnimal])]])
    const dev = new Map([['a', result('a', [det('person', 0.8, PERSON), extra])]])
    const d = diffRuns([sample('a')], dev, ref, 'ref-run')
    expect(d).toMatchObject({
      referenceRunId: 'ref-run',
      samples: 1,
      agreedBoxes: 1,
      lostVsRef: 1,
      gainedVsRef: 1,
      boxAgreement: 0.333,
      lostByClassSize: { 'animal/small': 1 },
      gainedByClassSize: { 'vehicle/large': 1 },
    })
    expect(d.worstSamples).toEqual([{ sampleId: 'a', lost: [lostAnimal], gained: [extra] }])
  })

  it('skips a sample either run failed, and agrees fully when both match', () => {
    const ref = new Map([
      ['a', result('a', [det('person', 0.9, PERSON)])],
      ['b', result('b', [det('person', 0.9, PERSON)])],
    ])
    const dev = new Map([
      ['a', result('a', [det('person', 0.7, PERSON)])],
      ['b', result('b', [], { ok: false, refusal: 'x' })],
    ])
    const d = diffRuns([sample('a'), sample('b')], dev, ref, 'r')
    expect(d).toMatchObject({
      samples: 1,
      agreedBoxes: 1,
      lostVsRef: 0,
      gainedVsRef: 0,
      boxAgreement: 1,
    })
    expect(d.worstSamples).toEqual([])
  })

  it('a whole summary validates against the eval-run summary schema', () => {
    const samples = [sample('a')]
    const labels = new Map([['a', label('reviewed', [{ macro: 'person', box: PERSON }])]])
    const results = new Map([['a', result('a', [det('person', 0.9, PERSON)])]])
    const summary = {
      final: scoreRun(samples, labels, results, 'final'),
      full: scoreRun(samples, labels, results, 'full'),
      latency: latencyStats(results),
      diff: diffRuns(samples, results, results, 'self'),
    }
    expect(EvalRunSummarySchema.parse(summary)).toEqual(summary)
  })
})

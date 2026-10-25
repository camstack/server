import { describe, expect, it } from 'vitest'
import { type SubjectPathSample, subjectAgreement } from '../subject-agreement.js'

const MIN_IOU = 0.5
const MAX_GAP_MS = 1000

function query(
  path: readonly SubjectPathSample[],
  measuredAtMs: number,
  cutFromMs: number,
): Parameters<typeof subjectAgreement>[0] {
  return { path, measuredAtMs, cutFromMs, minIou: MIN_IOU, maxSampleGapMs: MAX_GAP_MS }
}

/** A subject that translates `pxPerSample` every 100 ms, for 6 s. */
function samplePath(pxPerSample: number): SubjectPathSample[] {
  const path: SubjectPathSample[] = []
  for (let i = 0; i <= 60; i += 1) {
    path.push({ timestamp: i * 100, bbox: { x: i * pxPerSample, y: 50, w: 80, h: 60 } })
  }
  return path
}

describe('subjectAgreement — did the subject stay put between the two instants?', () => {
  it('a stationary subject agrees across ANY skew', () => {
    const parked = samplePath(0)
    const near = subjectAgreement(query(parked, 0, 500))
    const far = subjectAgreement(query(parked, 0, 6000))
    expect(near).toEqual({ kind: 'agrees', iou: 1, sampleGapMs: 0 })
    // 6 s apart and still `agrees` — time is not the quantity being measured.
    expect(far.kind).toBe('agrees')
  })

  it('a crossing subject disagrees even across a SMALL skew', () => {
    // 20 px per 100 ms on an 80 px box: 500 ms puts it fully clear of itself.
    const crossing = samplePath(20)
    const verdict = subjectAgreement(query(crossing, 0, 500))
    expect(verdict.kind).toBe('moved')
    if (verdict.kind === 'moved') expect(verdict.iou).toBe(0)
  })

  it('the verdict tracks MOTION, not elapsed time — the same skew, both answers', () => {
    const skewMs = 800
    const parked = subjectAgreement(query(samplePath(0), 0, skewMs))
    const crossing = subjectAgreement(query(samplePath(20), 0, skewMs))
    expect(parked.kind).toBe('agrees')
    expect(crossing.kind).toBe('moved')
  })

  it('is symmetric in the two instants (IoU is, so the verdict must be)', () => {
    const crossing = samplePath(5)
    const forward = subjectAgreement(query(crossing, 0, 900))
    const backward = subjectAgreement(query(crossing, 900, 0))
    expect(forward).toEqual(backward)
  })

  it('an empty trail is `unknown` — never a confident 0', () => {
    expect(subjectAgreement(query([], 0, 800))).toEqual({ kind: 'unknown', reason: 'no-path' })
  })

  it('names WHICH instant the trail could not answer about', () => {
    const late: SubjectPathSample[] = [{ timestamp: 9000, bbox: { x: 0, y: 0, w: 10, h: 10 } }]
    expect(subjectAgreement(query(late, 0, 9000))).toEqual({
      kind: 'unknown',
      reason: 'no-sample-near-measure',
    })
    const early: SubjectPathSample[] = [{ timestamp: 0, bbox: { x: 0, y: 0, w: 10, h: 10 } }]
    expect(subjectAgreement(query(early, 0, 9000))).toEqual({
      kind: 'unknown',
      reason: 'no-sample-near-cut',
    })
  })

  it('reports the WORST of the two sample gaps, so the caller sees the weakest leg', () => {
    const path: SubjectPathSample[] = [
      { timestamp: 100, bbox: { x: 0, y: 0, w: 10, h: 10 } },
      { timestamp: 1700, bbox: { x: 0, y: 0, w: 10, h: 10 } },
    ]
    const verdict = subjectAgreement(query(path, 0, 900))
    expect(verdict.kind).toBe('agrees')
    if (verdict.kind === 'agrees') expect(verdict.sampleGapMs).toBe(800)
  })

  it('is order-independent — the trail is seeked, not assumed sorted', () => {
    const shuffled: SubjectPathSample[] = [
      { timestamp: 800, bbox: { x: 400, y: 0, w: 80, h: 60 } },
      { timestamp: 0, bbox: { x: 0, y: 0, w: 80, h: 60 } },
      { timestamp: 400, bbox: { x: 200, y: 0, w: 80, h: 60 } },
    ]
    expect(subjectAgreement(query(shuffled, 0, 800)).kind).toBe('moved')
  })

  it('the reported IoU is the number the threshold is compared against', () => {
    // Half-overlapping 100×100 boxes: intersection 5000, union 15000 → 1/3.
    const path: SubjectPathSample[] = [
      { timestamp: 0, bbox: { x: 0, y: 0, w: 100, h: 100 } },
      { timestamp: 800, bbox: { x: 50, y: 0, w: 100, h: 100 } },
    ]
    const verdict = subjectAgreement(query(path, 0, 800))
    expect(verdict.kind).toBe('moved')
    if (verdict.kind === 'moved') expect(verdict.iou).toBeCloseTo(1 / 3, 6)
    // Same geometry, lower bar → the other side of the same boundary.
    const relaxed = subjectAgreement({ ...query(path, 0, 800), minIou: 0.3 })
    expect(relaxed.kind).toBe('agrees')
  })
})

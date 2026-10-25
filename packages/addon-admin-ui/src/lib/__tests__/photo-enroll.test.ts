/**
 * The Photo-enrollment tab's contract with the `photo.*` bridge.
 *
 * `addons.custom` is typed `z.unknown()` at the cap boundary, so every reply is
 * narrowed here with type guards rather than casts: a malformed reply yields
 * `null` and the dialog says it could not read it, instead of rendering
 * `undefined` into a face grid.
 *
 * The assignment model is the other half. An operator looking at a family
 * photograph is making N independent decisions, and two of them can be
 * "ignore". So the draft is a map keyed by face, never a single selection, and
 * a face the SERVER refused can never carry one — the button must not offer to
 * enrol something the server will reject.
 */
import { describe, expect, it } from 'vitest'
import {
  buildEnrollPlan,
  countAssignable,
  PHOTO_ADDON_ID,
  PHOTO_ANALYZE_ACTION,
  PHOTO_ENROLL_ACTION,
  type PhotoFaceView,
  parsePhotoAnalyze,
  parsePhotoEnroll,
  refusalLabel,
  setAssignment,
} from '../photo-enroll'

const ANALYZE_REPLY = {
  sessionId: 'sess-1',
  ranOnNodeId: 'hub',
  faces: [
    {
      faceIndex: 0,
      bbox: { x: 10, y: 10, width: 200, height: 200 },
      score: 0.97,
      enrollable: true,
      alignedCropBase64: 'AAAA',
      modelId: 'arcface-r100',
      quality: { detectionShortSidePx: 200, score: 0.97, magnitude: 4.4 },
    },
    {
      faceIndex: 1,
      bbox: { x: 400, y: 10, width: 30, height: 30 },
      score: 0.6,
      enrollable: false,
      refusedReason: 'no-embedding',
      quality: { detectionShortSidePx: 30, score: 0.6 },
    },
  ],
}

describe('the bridge names', () => {
  it('addresses the MANIFEST id, never the npm package', () => {
    expect(PHOTO_ADDON_ID).toBe('pipeline-analytics')
    expect(PHOTO_ANALYZE_ACTION).toBe('photo.analyze')
    expect(PHOTO_ENROLL_ACTION).toBe('photo.enroll')
  })
})

describe('parsePhotoAnalyze', () => {
  it('reads a well-formed reply, refusals included', () => {
    const parsed = parsePhotoAnalyze(ANALYZE_REPLY)
    expect(parsed?.sessionId).toBe('sess-1')
    expect(parsed?.ranOnNodeId).toBe('hub')
    expect(parsed?.faces).toHaveLength(2)
    expect(parsed?.faces[0]?.enrollable).toBe(true)
    expect(parsed?.faces[1]?.refusedReason).toBe('no-embedding')
  })

  it('answers null on a shape it was not promised', () => {
    expect(parsePhotoAnalyze(null)).toBeNull()
    expect(parsePhotoAnalyze({ sessionId: 'x' })).toBeNull()
    expect(parsePhotoAnalyze({ sessionId: 'x', ranOnNodeId: 'hub', faces: 'nope' })).toBeNull()
  })

  it('drops ONE unreadable face rather than the whole photo', () => {
    const parsed = parsePhotoAnalyze({
      ...ANALYZE_REPLY,
      faces: [ANALYZE_REPLY.faces[0], { nonsense: true }],
    })
    expect(parsed?.faces).toHaveLength(1)
  })

  it('accepts a photo with no faces — that is an answer, not a failure', () => {
    const parsed = parsePhotoAnalyze({ sessionId: 's', ranOnNodeId: 'hub', faces: [] })
    expect(parsed?.faces).toEqual([])
  })
})

describe('parsePhotoEnroll', () => {
  it('reads the sample and the model that was stamped', () => {
    const parsed = parsePhotoEnroll({
      sampleId: 'smp-1',
      identityId: 'i1',
      modelId: 'auraface-v1',
    })
    expect(parsed).toEqual({ sampleId: 'smp-1', identityId: 'i1', modelId: 'auraface-v1' })
  })

  it('answers null when the model is missing — an unstamped sample is the bug', () => {
    expect(parsePhotoEnroll({ sampleId: 'smp-1', identityId: 'i1' })).toBeNull()
  })
})

// ── The draft the operator builds ───────────────────────────────────────────

const enrollable: PhotoFaceView = {
  faceIndex: 0,
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  score: 0.9,
  enrollable: true,
  alignedCropBase64: 'AAAA',
  modelId: 'arcface-r100',
  quality: { detectionShortSidePx: 10, score: 0.9 },
}
const refused: PhotoFaceView = {
  faceIndex: 1,
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  score: 0.5,
  enrollable: false,
  refusedReason: 'magnitude',
  quality: { detectionShortSidePx: 10, score: 0.5 },
}

describe('the assignment draft', () => {
  it('is per FACE — a family photo is several independent decisions', () => {
    let draft = setAssignment({}, 0, 'i1')
    draft = setAssignment(draft, 2, 'i2')
    expect(draft).toEqual({ 0: 'i1', 2: 'i2' })
  })

  it('treats "ignore" as removing the assignment, not as an identity', () => {
    const draft = setAssignment({ 0: 'i1' }, 0, null)
    expect(draft).toEqual({})
    // Immutable: the caller's object is never edited underneath it.
    expect(setAssignment({ 0: 'i1' }, 1, 'i2')).not.toBe(draft)
  })

  it('counts only faces that are BOTH assigned and enrollable', () => {
    expect(countAssignable([enrollable, refused], { 0: 'i1', 1: 'i2' })).toBe(1)
    expect(countAssignable([enrollable, refused], {})).toBe(0)
  })
})

describe('buildEnrollPlan', () => {
  it('emits one confirmation per assigned enrollable face, in face order', () => {
    const plan = buildEnrollPlan('sess-1', [enrollable, { ...enrollable, faceIndex: 2 }], {
      2: 'i2',
      0: 'i1',
    })
    expect(plan).toEqual([
      { sessionId: 'sess-1', faceIndex: 0, identityId: 'i1' },
      { sessionId: 'sess-1', faceIndex: 2, identityId: 'i2' },
    ])
  })

  it('NEVER plans a face the server refused, however it was assigned', () => {
    // The refusal is the server's; offering to enrol anyway would produce a
    // request that can only fail, and would read to the operator as a bug in
    // the photo rather than a property of the face.
    expect(buildEnrollPlan('s', [refused], { 1: 'i1' })).toEqual([])
  })

  it('plans nothing when nothing was assigned', () => {
    expect(buildEnrollPlan('s', [enrollable], {})).toEqual([])
  })
})

describe('refusalLabel', () => {
  it('names every reason the addon can send', () => {
    for (const reason of ['no-embedding', 'no-model-id', 'no-aligned-crop', 'magnitude'] as const) {
      expect(refusalLabel(reason).length).toBeGreaterThan(0)
    }
  })

  it('degrades honestly on a reason it has never seen', () => {
    // A newer addon may name a refusal this build does not know. Saying so is
    // the only honest render; guessing a label would put a wrong sentence on
    // screen with no way to tell.
    expect(refusalLabel(undefined)).toMatch(/not usable/i)
  })
})

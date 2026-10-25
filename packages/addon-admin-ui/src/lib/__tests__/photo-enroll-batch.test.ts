/**
 * Multi-photo enrollment — the batch layer over the per-photo `photo.*` bridge.
 *
 * The server contract stays PER PHOTO (one `photo.analyze` per photograph, one
 * session each); the batch is a client concept. These tests pin the parts that
 * make the batch honest:
 *
 *  - a bounded pick: too many files or an oversized file is REPORTED, never
 *    silently dropped;
 *  - analyses run a few at a time, not all at once — each one is a pipeline
 *    run on a real node;
 *  - one draft across all photos, but every face stays an independent
 *    decision, exactly as in the single-photo dialog;
 *  - an expired session is retried by RE-ANALYSING that one photograph, and a
 *    retry that comes back with a different face list refuses rather than
 *    enrolling a face the operator never saw.
 */
import { describe, expect, it } from 'vitest'
import type { PhotoAnalyzeView, PhotoFaceView } from '../photo-enroll'
import {
  ANALYZE_CONCURRENCY,
  type BatchAssignmentDraft,
  type BatchPhoto,
  buildBatchEnrollPlan,
  countBatchAssignable,
  enrollAssignedFaces,
  faceKey,
  isSessionExpiredMessage,
  mapWithConcurrency,
  MAX_PHOTOS_PER_BATCH,
  partitionPickedFiles,
  patchBatchPhoto,
  planNewIdentities,
  resolveNewIdentityAssignments,
  setBatchAssignment,
} from '../photo-enroll-batch'

const face = (faceIndex: number, over: Partial<PhotoFaceView> = {}): PhotoFaceView => ({
  faceIndex,
  bbox: { x: 0, y: 0, width: 100, height: 100 },
  score: 0.9,
  enrollable: true,
  alignedCropBase64: 'AAAA',
  modelId: 'auraface-r100',
  quality: { detectionShortSidePx: 100, score: 0.9 },
  ...over,
})

const analysis = (sessionId: string, faces: readonly PhotoFaceView[]): PhotoAnalyzeView => ({
  sessionId,
  ranOnNodeId: 'hub',
  faces,
})

const analyzedPhoto = (
  photoIndex: number,
  sessionId: string,
  faces: readonly PhotoFaceView[],
): BatchPhoto => ({
  photoIndex,
  filename: `photo-${photoIndex}.jpg`,
  photoBase64: `base64-${photoIndex}`,
  status: 'analyzed',
  analysis: analysis(sessionId, faces),
})

// ── Picking files ───────────────────────────────────────────────────────────

describe('partitionPickedFiles', () => {
  const f = (name: string, size: number) => ({ name, size })

  it('accepts everything within both bounds', () => {
    const out = partitionPickedFiles([f('a.jpg', 10), f('b.jpg', 20)], {
      maxCount: 3,
      maxBytes: 100,
    })
    expect(out.accepted.map((x) => x.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(out.oversize).toEqual([])
    expect(out.overflow).toEqual([])
  })

  it('names an oversized file instead of silently dropping it', () => {
    const out = partitionPickedFiles([f('big.jpg', 200), f('ok.jpg', 5)], {
      maxCount: 3,
      maxBytes: 100,
    })
    expect(out.accepted.map((x) => x.name)).toEqual(['ok.jpg'])
    expect(out.oversize).toEqual(['big.jpg'])
  })

  it('caps the batch and names what did NOT make it', () => {
    const out = partitionPickedFiles([f('a.jpg', 1), f('b.jpg', 1), f('c.jpg', 1)], {
      maxCount: 2,
      maxBytes: 100,
    })
    expect(out.accepted.map((x) => x.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(out.overflow).toEqual(['c.jpg'])
  })

  it('counts the cap AFTER dropping oversized files — an oversize never burns a slot', () => {
    const out = partitionPickedFiles([f('big.jpg', 200), f('a.jpg', 1), f('b.jpg', 1)], {
      maxCount: 2,
      maxBytes: 100,
    })
    expect(out.accepted.map((x) => x.name)).toEqual(['a.jpg', 'b.jpg'])
    expect(out.overflow).toEqual([])
  })
})

describe('the batch bounds', () => {
  it('fits inside the server session bound with slack for a second tab', () => {
    // The server holds one session per analysed photo
    // (DEFAULT_PHOTO_SESSION_MAX = 16). A batch at or above that bound would
    // evict its own first photos before the operator confirms.
    expect(MAX_PHOTOS_PER_BATCH).toBeLessThan(16)
  })

  it('analyses a few photos at a time — each analysis is a pipeline run', () => {
    expect(ANALYZE_CONCURRENCY).toBeGreaterThanOrEqual(1)
    expect(ANALYZE_CONCURRENCY).toBeLessThanOrEqual(3)
  })
})

// ── Bounded concurrency ─────────────────────────────────────────────────────

describe('mapWithConcurrency', () => {
  it('preserves input order in the results', async () => {
    const out = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5))
      return n * 10
    })
    expect(out).toEqual([30, 10, 20])
  })

  it('never runs more than the limit at once', async () => {
    let inFlight = 0
    let peak = 0
    await mapWithConcurrency([1, 2, 3, 4, 5], 2, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
    })
    expect(peak).toBe(2)
  })

  it('propagates a rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async (n) => {
        if (n === 2) throw new Error('boom')
        return n
      }),
    ).rejects.toThrow('boom')
  })
})

// ── The batch draft ─────────────────────────────────────────────────────────

describe('the batch draft', () => {
  it('keys assignments by photo AND face — two photos are independent reviews', () => {
    let draft: BatchAssignmentDraft = {}
    draft = setBatchAssignment(draft, 0, 0, 'i1')
    draft = setBatchAssignment(draft, 1, 0, 'i2')
    expect(draft[0]).toEqual({ 0: 'i1' })
    expect(draft[1]).toEqual({ 0: 'i2' })
  })

  it('takes an assignment back with null, dropping empty photo entries', () => {
    let draft: BatchAssignmentDraft = setBatchAssignment({}, 0, 0, 'i1')
    draft = setBatchAssignment(draft, 0, 0, null)
    expect(draft).toEqual({})
  })

  it('counts assignable faces across every ANALYZED photo', () => {
    const photos = [
      analyzedPhoto(0, 's0', [face(0), face(1, { enrollable: false })]),
      analyzedPhoto(1, 's1', [face(0)]),
    ]
    const draft: BatchAssignmentDraft = {
      0: { 0: 'i1', 1: 'i1' }, // face 1 is refused → not counted
      1: { 0: 'i2' },
    }
    expect(countBatchAssignable(photos, draft)).toBe(2)
  })

  it('counts nothing for a photo that failed analysis', () => {
    const failed: BatchPhoto = {
      photoIndex: 0,
      filename: 'x.jpg',
      photoBase64: 'b',
      status: 'failed',
      error: 'node down',
    }
    expect(countBatchAssignable([failed], { 0: { 0: 'i1' } })).toBe(0)
  })
})

describe('patchBatchPhoto', () => {
  it('replaces one photo immutably, leaving the others untouched', () => {
    const photos = [analyzedPhoto(0, 's0', []), analyzedPhoto(1, 's1', [])]
    const next = patchBatchPhoto(photos, 1, { status: 'failed', error: 'x' })
    expect(next[1]?.status).toBe('failed')
    expect(next[0]).toBe(photos[0])
    expect(photos[1]?.status).toBe('analyzed')
  })
})

// ── New identities across the batch ─────────────────────────────────────────

describe('planNewIdentities', () => {
  it('creates ONE identity per unique name, however many faces share it', () => {
    const photos = [analyzedPhoto(0, 's0', [face(0), face(1)]), analyzedPhoto(1, 's1', [face(0)])]
    const draft: BatchAssignmentDraft = {
      0: { 0: '__new__', 1: '__new__' },
      1: { 0: '__new__' },
    }
    const names = {
      [faceKey(0, 0)]: 'Anna',
      [faceKey(0, 1)]: 'Marco',
      [faceKey(1, 0)]: ' Anna ', // same person, typed again with spaces
    }
    const plan = planNewIdentities(photos, draft, names)
    expect(plan.kind).toBe('ok')
    if (plan.kind !== 'ok') return
    expect(plan.names).toEqual(['Anna', 'Marco'])
  })

  it('refuses a new-person face with no name, naming photo and face', () => {
    const photos = [analyzedPhoto(0, 's0', [face(0)])]
    const plan = planNewIdentities(photos, { 0: { 0: '__new__' } }, {})
    expect(plan.kind).toBe('error')
    if (plan.kind !== 'error') return
    expect(plan.message).toMatch(/photo-0\.jpg/)
    expect(plan.message).toMatch(/face 1/i)
  })
})

describe('resolveNewIdentityAssignments', () => {
  it('swaps every new-person sentinel for the created identity id', () => {
    const draft: BatchAssignmentDraft = {
      0: { 0: '__new__', 1: 'existing-id' },
      1: { 0: '__new__' },
    }
    const names = {
      [faceKey(0, 0)]: 'Anna',
      [faceKey(1, 0)]: 'Anna',
    }
    const resolved = resolveNewIdentityAssignments(draft, names, {
      Anna: 'id-anna',
    })
    expect(resolved[0]).toEqual({ 0: 'id-anna', 1: 'existing-id' })
    expect(resolved[1]).toEqual({ 0: 'id-anna' })
  })
})

// ── The enroll plan and its execution ───────────────────────────────────────

describe('buildBatchEnrollPlan', () => {
  it('plans per photo, in photo order, and skips failed/faceless photos', () => {
    const photos: readonly BatchPhoto[] = [
      analyzedPhoto(0, 's0', [face(0)]),
      {
        photoIndex: 1,
        filename: 'bad.jpg',
        photoBase64: 'b',
        status: 'failed',
        error: 'x',
      },
      analyzedPhoto(2, 's2', [face(0)]),
    ]
    const draft: BatchAssignmentDraft = { 0: { 0: 'i1' }, 2: { 0: 'i2' } }
    const plan = buildBatchEnrollPlan(photos, draft)
    expect(plan).toEqual([
      {
        photoIndex: 0,
        request: { sessionId: 's0', faceIndex: 0, identityId: 'i1' },
      },
      {
        photoIndex: 2,
        request: { sessionId: 's2', faceIndex: 0, identityId: 'i2' },
      },
    ])
  })
})

describe('isSessionExpiredMessage', () => {
  it('recognises the server wording', () => {
    expect(
      isSessionExpiredMessage(
        'photo.enroll: that analysis has expired — upload the photograph again',
      ),
    ).toBe(true)
    expect(isSessionExpiredMessage('embedding is ambiguous')).toBe(false)
  })
})

describe('enrollAssignedFaces', () => {
  it('enrols every assigned face across photos and reports the stamped model', async () => {
    const photos = [analyzedPhoto(0, 's0', [face(0), face(1)]), analyzedPhoto(1, 's1', [face(0)])]
    const draft: BatchAssignmentDraft = {
      0: { 0: 'i1', 1: 'i2' },
      1: { 0: 'i1' },
    }
    const enrolled: string[] = []
    const out = await enrollAssignedFaces(photos, draft, {
      enroll: async (req) => {
        enrolled.push(`${req.sessionId}:${req.faceIndex}:${req.identityId}`)
        return {
          sampleId: `smp-${enrolled.length}`,
          identityId: req.identityId,
          modelId: 'auraface-r100',
        }
      },
      reanalyze: async () => {
        throw new Error('must not reanalyze on the happy path')
      },
    })
    expect(enrolled).toEqual(['s0:0:i1', 's0:1:i2', 's1:0:i1'])
    expect(out.enrolled).toBe(3)
    expect(out.stampedModelId).toBe('auraface-r100')
    expect(out.failures).toEqual([])
  })

  it('one refused face fails alone — the rest of the batch still enrols', async () => {
    const photos = [analyzedPhoto(0, 's0', [face(0), face(1)])]
    const draft: BatchAssignmentDraft = { 0: { 0: 'i1', 1: 'i2' } }
    const out = await enrollAssignedFaces(photos, draft, {
      enroll: async (req) => {
        if (req.faceIndex === 0) throw new Error('embedding is ambiguous')
        return {
          sampleId: 'smp-1',
          identityId: req.identityId,
          modelId: 'auraface-r100',
        }
      },
      reanalyze: async () => {
        throw new Error('must not reanalyze')
      },
    })
    expect(out.enrolled).toBe(1)
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]).toMatch(/photo-0\.jpg/)
    expect(out.failures[0]).toMatch(/face 1/i)
    expect(out.failures[0]).toMatch(/ambiguous/)
  })

  it('re-analyses ONE photo on an expired session and retries with the fresh session', async () => {
    const photos = [analyzedPhoto(0, 'stale', [face(0)]), analyzedPhoto(1, 's1', [face(0)])]
    const draft: BatchAssignmentDraft = { 0: { 0: 'i1' }, 1: { 0: 'i2' } }
    const calls: string[] = []
    let reanalyzed = 0
    const out = await enrollAssignedFaces(photos, draft, {
      enroll: async (req) => {
        calls.push(req.sessionId)
        if (req.sessionId === 'stale') {
          throw new Error('photo.enroll: that analysis has expired — upload the photograph again')
        }
        return {
          sampleId: `smp-${calls.length}`,
          identityId: req.identityId,
          modelId: 'auraface-r100',
        }
      },
      reanalyze: async (photo) => {
        reanalyzed += 1
        expect(photo.photoIndex).toBe(0)
        return analysis('fresh', [face(0)])
      },
    })
    expect(reanalyzed).toBe(1)
    expect(calls).toEqual(['stale', 'fresh', 's1'])
    expect(out.enrolled).toBe(2)
    expect(out.failures).toEqual([])
    // The dialog folds the fresh analysis back into its state.
    expect(out.refreshedAnalyses[0]?.sessionId).toBe('fresh')
  })

  it('refuses a retry whose re-analysis no longer matches the face the operator saw', async () => {
    const photos = [analyzedPhoto(0, 'stale', [face(0)])]
    const draft: BatchAssignmentDraft = { 0: { 0: 'i1' } }
    const out = await enrollAssignedFaces(photos, draft, {
      enroll: async (req) => {
        if (req.sessionId === 'stale') {
          throw new Error('photo.enroll: that analysis has expired — upload the photograph again')
        }
        throw new Error('must not enrol a face the operator never saw')
      },
      // The fresh analysis found no enrollable face 0 — enrolling anything
      // from it would store a vector whose crop was never on screen.
      reanalyze: async () =>
        analysis('fresh', [face(0, { enrollable: false, refusedReason: 'no-embedding' })]),
    })
    expect(out.enrolled).toBe(0)
    expect(out.failures).toHaveLength(1)
    expect(out.failures[0]).toMatch(/expired/i)
  })

  it('re-analyses an expired photo ONCE even when several of its faces were assigned', async () => {
    const photos = [analyzedPhoto(0, 'stale', [face(0), face(1)])]
    const draft: BatchAssignmentDraft = { 0: { 0: 'i1', 1: 'i2' } }
    let reanalyzed = 0
    const out = await enrollAssignedFaces(photos, draft, {
      enroll: async (req) => {
        if (req.sessionId === 'stale') {
          throw new Error('photo.enroll: that analysis has expired — upload the photograph again')
        }
        return {
          sampleId: 'smp',
          identityId: req.identityId,
          modelId: 'auraface-r100',
        }
      },
      reanalyze: async () => {
        reanalyzed += 1
        return analysis('fresh', [face(0), face(1)])
      },
    })
    expect(reanalyzed).toBe(1)
    expect(out.enrolled).toBe(2)
  })
})

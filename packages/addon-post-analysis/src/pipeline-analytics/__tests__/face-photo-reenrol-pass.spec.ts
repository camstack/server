/**
 * The photo re-enrol pass (D643): bring every PHOTO sample into the fixed
 * SCRFD alignment from the photograph it was cut from.
 *
 * A photo sample is the only kind whose original survives (`sourceMediaId`),
 * so it is the only kind that can be re-derived. The pass runs the REAL photo
 * analyze path over that original and has to pick, among the faces it finds,
 * the one the old sample was. Picking wrong enrols a stranger under a name —
 * which is why an ambiguous or weak pick is REFUSED and logged, never guessed —
 * and a failed step must leave the old sample exactly where it was (D49).
 */
import { describe, expect, it } from 'vitest'
import { FACE_ALIGNMENT_SCRFD_V2 } from '../face-alignment-version.js'
import {
  choosePhotoFace,
  type PhotoReenrolAddInput,
  type PhotoReenrolDeps,
  type PhotoReenrolSample,
  reenrolPhotoSamples,
} from '../face-photo-reenrol-pass.js'
import type { PhotoBbox, PhotoFace } from '../photo-enrollment.js'
import type { GallerySample } from '../pipeline/face-matcher.js'

const MODEL = 'auraface-r100'
const OLD_VECTOR: readonly number[] = [1, 0, 0]

/** A unit vector whose cosine with OLD_VECTOR is exactly `cos`. */
function vec(cos: number, sign = 1): readonly number[] {
  return [cos, sign * Math.sqrt(1 - cos * cos), 0]
}

function face(
  faceIndex: number,
  bbox: PhotoBbox,
  embedding: readonly number[],
  over: Partial<PhotoFace> = {},
): PhotoFace {
  return {
    faceIndex,
    bbox,
    score: 0.9,
    enrollable: true,
    alignedCropBase64: Buffer.from(`template-${faceIndex}`).toString('base64'),
    modelId: MODEL,
    embedding,
    quality: { detectionShortSidePx: 300, score: 0.9 },
    ...over,
  }
}

const LEFT: PhotoBbox = { x: 0, y: 0, width: 100, height: 100 }
const LEFT_SHIFTED: PhotoBbox = { x: 10, y: 5, width: 100, height: 100 }
const RIGHT: PhotoBbox = { x: 500, y: 0, width: 100, height: 100 }

describe('choosePhotoFace', () => {
  it('chooses by IoU with the old box when the box is known — even over a face with a higher cosine', () => {
    const choice = choosePhotoFace({
      faces: [face(0, RIGHT, vec(0.9)), face(1, LEFT_SHIFTED, vec(0.7))],
      oldBox: LEFT,
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice.kind).toBe('chosen')
    if (choice.kind !== 'chosen') return
    expect(choice.face.faceIndex).toBe(1)
    expect(choice.by).toBe('iou')
  })

  it('refuses when no face overlaps the old box enough', () => {
    const choice = choosePhotoFace({
      faces: [face(0, RIGHT, vec(0.9))],
      oldBox: LEFT,
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'no-iou-match' })
  })

  it('refuses when two faces overlap the old box — the box cannot tell them apart', () => {
    const choice = choosePhotoFace({
      faces: [face(0, LEFT, vec(0.8)), face(1, LEFT_SHIFTED, vec(0.7, -1))],
      oldBox: LEFT,
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'ambiguous' })
  })

  it('an IoU pick still has to clear the cosine floor', () => {
    const choice = choosePhotoFace({
      faces: [face(0, LEFT_SHIFTED, vec(0.3))],
      oldBox: LEFT,
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'below-floor' })
  })

  it('without a box, chooses the highest cosine to the old vector', () => {
    const choice = choosePhotoFace({
      faces: [face(0, LEFT, vec(0.2)), face(1, RIGHT, vec(0.8))],
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice.kind).toBe('chosen')
    if (choice.kind !== 'chosen') return
    expect(choice.face.faceIndex).toBe(1)
    expect(choice.by).toBe('cosine')
    expect(choice.cosine).toBeCloseTo(0.8, 5)
  })

  it('refuses a best cosine below the floor rather than enrolling the least-bad stranger', () => {
    const choice = choosePhotoFace({
      faces: [face(0, LEFT, vec(0.45)), face(1, RIGHT, vec(0.1))],
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'below-floor' })
  })

  it('refuses two faces that both clear the floor and sit too close to each other', () => {
    const choice = choosePhotoFace({
      faces: [face(0, LEFT, vec(0.8)), face(1, RIGHT, vec(0.75, -1))],
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'ambiguous' })
  })

  it('refuses faces embedded in a different model space — their cosine to the old vector means nothing', () => {
    const choice = choosePhotoFace({
      faces: [face(0, LEFT, vec(0.9), { modelId: 'arcface-r100' })],
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'model-mismatch' })
  })

  it('refuses a photo whose faces were all refused by analysis', () => {
    const choice = choosePhotoFace({
      faces: [
        face(0, LEFT, vec(0.9), {
          enrollable: false,
          refusedReason: 'no-embedding',
        }),
      ],
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'no-enrollable-face' })
  })
})

describe('choosePhotoFace — a face analysis refused still competes (M9)', () => {
  it('a NON-enrollable face on the old box makes the box ambiguous', () => {
    const choice = choosePhotoFace({
      faces: [
        face(0, LEFT, vec(0.8)),
        face(1, LEFT_SHIFTED, vec(0.7, -1), { enrollable: false, refusedReason: 'magnitude' }),
      ],
      oldBox: LEFT,
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'ambiguous' })
  })

  it('the only face on the old box being non-enrollable is refused, not swapped for another', () => {
    const choice = choosePhotoFace({
      faces: [
        face(0, RIGHT, vec(0.9)),
        face(1, LEFT_SHIFTED, vec(0.8, -1), { enrollable: false, refusedReason: 'magnitude' }),
      ],
      oldBox: LEFT,
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'no-enrollable-face' })
  })

  it('a non-enrollable face within the margin of the best makes the cosine pick ambiguous', () => {
    const choice = choosePhotoFace({
      faces: [
        face(0, LEFT, vec(0.8)),
        face(1, RIGHT, vec(0.76, -1), { enrollable: false, refusedReason: 'no-aligned-crop' }),
      ],
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'ambiguous' })
  })

  it('a non-enrollable face CLOSER than every enrollable one refuses the pick', () => {
    const choice = choosePhotoFace({
      faces: [
        face(0, LEFT, vec(0.6)),
        face(1, RIGHT, vec(0.9, -1), { enrollable: false, refusedReason: 'magnitude' }),
      ],
      oldVector: OLD_VECTOR,
      modelId: MODEL,
    })
    expect(choice).toMatchObject({ kind: 'refused', reason: 'ambiguous' })
  })
})

// ── the pass ────────────────────────────────────────────────────────────────

interface LogLine {
  readonly level: 'info' | 'warn'
  readonly message: string
  readonly meta: Record<string, unknown>
}

interface Harness {
  readonly deps: PhotoReenrolDeps
  /** The live sample table — the pass mutates it through addSample/removeOldSample. */
  readonly samples: PhotoReenrolSample[]
  readonly added: PhotoReenrolAddInput[]
  readonly removed: string[]
  readonly deletedMedia: number[]
  readonly analyzed: string[]
  readonly logs: LogLine[]
}

function photoSample(over: Partial<PhotoReenrolSample> = {}): PhotoReenrolSample {
  return {
    sampleId: 'old-1',
    identityId: 'id-dave',
    identityName: 'Dave',
    modelId: MODEL,
    mediaId: 10,
    sourceMediaId: 11,
    ...over,
  }
}

function harness(
  initial: readonly PhotoReenrolSample[],
  faces: readonly PhotoFace[],
  over: Partial<PhotoReenrolDeps> = {},
): Harness {
  const samples = [...initial]
  const added: PhotoReenrolAddInput[] = []
  const removed: string[] = []
  const deletedMedia: number[] = []
  const analyzed: string[] = []
  const logs: LogLine[] = []
  let nextMedia = 100
  const deps: PhotoReenrolDeps = {
    listPhotoSamples: async () => [...samples],
    loadSourcePhoto: async (s) =>
      s.sourceMediaId === undefined ? null : Buffer.from(`photo-${s.sourceMediaId}`),
    analyzePhoto: async (s) => {
      analyzed.push(s.sampleId)
      return faces
    },
    loadOldVector: async () => OLD_VECTOR,
    loadGallery: async () => [],
    putTemplate: async () => {
      nextMedia += 1
      return nextMedia
    },
    deleteMedia: async (mediaId) => {
      deletedMedia.push(mediaId)
    },
    addSample: async (input) => {
      added.push(input)
      const id = `new-${added.length}`
      samples.push({
        sampleId: id,
        identityId: input.identityId,
        identityName: 'Dave',
        modelId: input.modelId,
        mediaId: input.mediaId,
        sourceMediaId: input.sourceMediaId,
        sourceBbox: input.sourceBbox,
        alignment: input.alignment,
      })
      return { id }
    },
    removeOldSample: async (s) => {
      removed.push(s.sampleId)
      const at = samples.findIndex((x) => x.sampleId === s.sampleId)
      if (at >= 0) samples.splice(at, 1)
    },
    sampleExists: async (sampleId) => samples.some((x) => x.sampleId === sampleId),
    refreshGallery: () => undefined,
    pause: async () => undefined,
    logger: {
      info: (message, extras) => logs.push({ level: 'info', message, meta: extras?.meta ?? {} }),
      warn: (message, extras) => logs.push({ level: 'warn', message, meta: extras?.meta ?? {} }),
    },
    ...over,
  }
  return { deps, samples, added, removed, deletedMedia, analyzed, logs }
}

describe('reenrolPhotoSamples', () => {
  it('adds the new sample beside the old one, stamped v2, same identity, SAME source photo — then removes the old', async () => {
    const h = harness([photoSample()], [face(0, RIGHT, vec(0.1)), face(1, LEFT, vec(0.8))])
    const result = await reenrolPhotoSamples(h.deps, {})

    expect(result.reenrolled).toBe(1)
    expect(h.added).toHaveLength(1)
    expect(h.added[0]).toMatchObject({
      identityId: 'id-dave',
      source: 'photo',
      sourceMediaId: 11,
      modelId: MODEL,
      alignment: FACE_ALIGNMENT_SCRFD_V2,
      sourceBbox: LEFT,
    })
    expect(h.removed).toEqual(['old-1'])
    expect(h.samples.map((s) => s.sampleId)).toEqual(['new-1'])
  })

  it('is idempotent through the stamp: a second run touches nothing', async () => {
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8))])
    await reenrolPhotoSamples(h.deps, {})
    const second = await reenrolPhotoSamples(h.deps, {})

    expect(second).toMatchObject({ total: 1, alreadyV2: 1, reenrolled: 0, remaining: 0 })
    expect(h.analyzed).toEqual(['old-1'])
    expect(h.added).toHaveLength(1)
  })

  it('refuses an ambiguous pick, LOGS it with the identity, and leaves the old sample untouched', async () => {
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8)), face(1, RIGHT, vec(0.78, -1))])
    const result = await reenrolPhotoSamples(h.deps, {})

    expect(result).toMatchObject({ refused: 1, reenrolled: 0 })
    expect(result.refusals).toEqual([
      { sampleId: 'old-1', identityId: 'id-dave', reason: 'ambiguous' },
    ])
    expect(h.added).toHaveLength(0)
    expect(h.removed).toHaveLength(0)
    const line = h.logs.find((l) => l.level === 'warn' && l.meta['reason'] === 'ambiguous')
    expect(line?.meta['identityId']).toBe('id-dave')
    expect(line?.meta['sampleId']).toBe('old-1')
  })

  it('refuses a below-floor pick and leaves the old sample untouched', async () => {
    const h = harness([photoSample()], [face(0, LEFT, vec(0.3))])
    const result = await reenrolPhotoSamples(h.deps, {})
    expect(result.refusals.map((r) => r.reason)).toEqual(['below-floor'])
    expect(h.added).toHaveLength(0)
    expect(h.removed).toHaveLength(0)
    expect(h.logs.some((l) => l.level === 'warn' && l.meta['reason'] === 'below-floor')).toBe(true)
  })

  it('a FAILED analyze keeps the old sample (D49)', async () => {
    const h = harness([photoSample()], [], {
      analyzePhoto: async () => {
        throw new Error('no node could analyse the photograph')
      },
    })
    const result = await reenrolPhotoSamples(h.deps, {})
    expect(result).toMatchObject({ failed: 1, reenrolled: 0, complete: false })
    expect(h.removed).toHaveLength(0)
    expect(h.samples.map((s) => s.sampleId)).toEqual(['old-1'])
  })

  it('a new sample that does not land keeps the old one AND reclaims the new template blob', async () => {
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8))], {
      addSample: async () => {
        throw new Error('vector did not reach the gallery index')
      },
    })
    const result = await reenrolPhotoSamples(h.deps, {})
    expect(result.failed).toBe(1)
    expect(h.removed).toHaveLength(0)
    expect(h.deletedMedia).toEqual([101])
  })

  it('never touches the source photo: removing the old sample is the pass dependency, not a media sweep', async () => {
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8))])
    await reenrolPhotoSamples(h.deps, {})
    expect(h.deletedMedia).not.toContain(11)
  })

  it('an old sample that would not go is retried on the next run WITHOUT enrolling a second copy', async () => {
    let failRemoval = true
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8))])
    const baseRemove = h.deps.removeOldSample
    const deps: PhotoReenrolDeps = {
      ...h.deps,
      removeOldSample: async (s, replacement) => {
        if (failRemoval) throw new Error('store busy')
        await baseRemove(s, replacement)
      },
    }
    const first = await reenrolPhotoSamples(deps, {})
    expect(first).toMatchObject({ reenrolled: 1, oldKept: 1, complete: false })
    expect(h.samples.map((s) => s.sampleId).toSorted()).toEqual(['new-1', 'old-1'])

    failRemoval = false
    const second = await reenrolPhotoSamples(deps, {})
    expect(second).toMatchObject({ reenrolled: 0, oldRemovalRetried: 1 })
    expect(h.added).toHaveLength(1)
    expect(h.analyzed).toEqual(['old-1'])
    expect(h.samples.map((s) => s.sampleId)).toEqual(['new-1'])
  })

  it('a sample whose original photo is gone is refused and logged, not analysed', async () => {
    const h = harness([photoSample({ sourceMediaId: undefined })], [face(0, LEFT, vec(0.8))])
    const result = await reenrolPhotoSamples(h.deps, {})
    expect(result.refusals.map((r) => r.reason)).toEqual(['no-source'])
    expect(h.analyzed).toHaveLength(0)
    expect(h.logs.some((l) => l.level === 'warn' && l.meta['reason'] === 'no-source')).toBe(true)
  })

  it('refuses a pick that sits on top of ANOTHER identity (the promiscuity gate every enrolment runs)', async () => {
    const foreign: GallerySample = { identityId: 'id-carol', embedding: vec(0.8), modelId: MODEL }
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8))], {
      loadGallery: async () => [foreign],
    })
    const result = await reenrolPhotoSamples(h.deps, {})
    expect(result.refusals.map((r) => r.reason)).toEqual(['promiscuous'])
    expect(h.added).toHaveLength(0)
  })

  it('stops at the budget and reports what is left', async () => {
    const h = harness(
      [photoSample(), photoSample({ sampleId: 'old-2', mediaId: 20, sourceMediaId: 21 })],
      [face(0, LEFT, vec(0.8))],
    )
    const result = await reenrolPhotoSamples(h.deps, { maxSamples: 1 })
    expect(result).toMatchObject({ reenrolled: 1, remaining: 1, complete: false })
  })
})

describe('reenrolPhotoSamples — dry run (I1)', () => {
  it('analyses and chooses, reports the pick with its evidence, and writes NOTHING', async () => {
    const h = harness([photoSample({ sourceBbox: LEFT })], [face(0, LEFT_SHIFTED, vec(0.8))])
    const writes: string[] = []
    const deps: PhotoReenrolDeps = {
      ...h.deps,
      putTemplate: async () => {
        writes.push('putTemplate')
        return 1
      },
      deleteMedia: async () => {
        writes.push('deleteMedia')
      },
      addSample: async () => {
        writes.push('addSample')
        return { id: 'x' }
      },
      removeOldSample: async () => {
        writes.push('removeOldSample')
      },
    }
    const result = await reenrolPhotoSamples(deps, { dryRun: true })

    expect(writes).toEqual([])
    expect(result).toMatchObject({ dryRun: true, wouldReenrol: 1, reenrolled: 0, remaining: 1 })
    const [only] = result.outcomes
    expect(only?.outcome).toBe('would-reenrol')
    expect(only?.pick?.by).toBe('iou')
    expect(only?.pick?.faceIndex).toBe(0)
    expect(only?.pick?.cosine).toBeCloseTo(0.8, 5)
    expect(only?.pick?.iou).toBeGreaterThan(0.3)
  })

  it('a dry run leaves an owed removal owed', async () => {
    const h = harness(
      [
        photoSample(),
        photoSample({ sampleId: 'new-0', alignment: FACE_ALIGNMENT_SCRFD_V2, mediaId: 50 }),
      ],
      [face(0, LEFT, vec(0.8))],
    )
    const result = await reenrolPhotoSamples(h.deps, { dryRun: true })
    expect(result.outcomes.map((o) => o.outcome)).toEqual(['old-removal-pending'])
    expect(h.removed).toEqual([])
  })
})

describe('reenrolPhotoSamples — a write that threw is checked, not assumed (M7)', () => {
  it('addSample threw but the row LANDED: the template is kept and the old sample goes', async () => {
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8))])
    const deps: PhotoReenrolDeps = {
      ...h.deps,
      addSample: async (input) => {
        await h.deps.addSample(input)
        throw new Error('identity bump failed after the insert')
      },
    }
    const result = await reenrolPhotoSamples(deps, {})
    expect(h.deletedMedia).toEqual([])
    expect(h.removed).toEqual(['old-1'])
    expect(result.reenrolled).toBe(1)
  })

  it('addSample threw and the read-back failed: the template is KEPT (it may be named)', async () => {
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8))])
    let lists = 0
    const deps: PhotoReenrolDeps = {
      ...h.deps,
      listPhotoSamples: async () => {
        lists += 1
        if (lists > 1) throw new Error('read failed')
        return [...h.samples]
      },
      addSample: async () => {
        throw new Error('insert failed')
      },
    }
    const result = await reenrolPhotoSamples(deps, {})
    expect(result.failed).toBe(1)
    expect(h.deletedMedia).toEqual([])
    expect(h.removed).toEqual([])
  })

  it('a removal that threw AFTER the old row went counts as removed', async () => {
    const h = harness([photoSample()], [face(0, LEFT, vec(0.8))])
    const base = h.deps.removeOldSample
    const deps: PhotoReenrolDeps = {
      ...h.deps,
      removeOldSample: async (sample, replacement) => {
        await base(sample, replacement)
        throw new Error('identity update failed after the delete')
      },
    }
    const result = await reenrolPhotoSamples(deps, {})
    expect(result).toMatchObject({ reenrolled: 1, oldKept: 0, remaining: 0, complete: true })
  })
})

describe('reenrolPhotoSamples — source re-enrol of a DETECTED sample (D644)', () => {
  const detected = (over: Partial<PhotoReenrolSample> = {}): PhotoReenrolSample =>
    photoSample({
      sampleId: 'det-1',
      source: 'detected',
      deviceId: 101,
      sourceBbox: LEFT,
      ...over,
    })

  it('re-derives it from its source frame, chosen by IoU, and it STAYS detected on its camera', async () => {
    const h = harness([detected()], [face(0, RIGHT, vec(0.9)), face(1, LEFT_SHIFTED, vec(0.7))])
    const moves: string[] = []
    const result = await reenrolPhotoSamples(
      {
        ...h.deps,
        removeOldSample: async (s, replacement) => {
          moves.push(`${s.sampleId}->${replacement.sampleId}@${String(replacement.mediaId)}`)
          await h.deps.removeOldSample(s, replacement)
        },
      },
      {},
    )
    expect(result.reenrolled).toBe(1)
    expect(h.added[0]).toMatchObject({
      source: 'detected',
      deviceId: 101,
      sourceMediaId: 11,
      sourceBbox: LEFT_SHIFTED,
      alignment: FACE_ALIGNMENT_SCRFD_V2,
    })
    // The old row goes only with its replacement named — the faces follow it.
    expect(moves).toEqual(['det-1->new-1@101'])
  })

  it('a detected sample WITHOUT a source frame is refused as no-source, and stays', async () => {
    const h = harness([detected({ sourceMediaId: undefined })], [face(0, LEFT, vec(0.8))])
    const result = await reenrolPhotoSamples(h.deps, {})
    expect(result.refusals).toEqual([
      { sampleId: 'det-1', identityId: 'id-dave', reason: 'no-source' },
    ])
    expect(h.removed).toEqual([])
  })
})

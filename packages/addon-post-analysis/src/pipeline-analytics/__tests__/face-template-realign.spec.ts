/**
 * Re-aligning a stored template (D644): the letterbox geometry the live
 * measurement chose, and the refusal rules — a re-detection that does not
 * look like the old sample, or that is ambiguous, keeps the old sample.
 */
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import {
  letterboxFaceTemplate,
  realignVerdictFrom,
  TEMPLATE_REALIGN_CANVAS_PX,
  TEMPLATE_REALIGN_SCALE,
} from '../face-template-realign.js'
import type { PhotoFace } from '../photo-enrollment.js'

const MODEL = 'auraface-r100'

function face(embedding: readonly number[], over: Partial<PhotoFace> = {}): PhotoFace {
  return {
    faceIndex: 0,
    bbox: { x: 100, y: 100, width: 200, height: 250 },
    score: 0.8,
    enrollable: true,
    alignedCropBase64: Buffer.from('new').toString('base64'),
    modelId: MODEL,
    embedding,
    quality: { detectionShortSidePx: 200, score: 0.8 },
    ...over,
  }
}

describe('letterboxFaceTemplate', () => {
  it('is 2.5× on a 512 canvas, the template centred on black', async () => {
    expect(TEMPLATE_REALIGN_SCALE).toBe(2.5)
    expect(TEMPLATE_REALIGN_CANVAS_PX).toBe(512)
    const template = await sharp({
      create: { width: 112, height: 112, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .jpeg()
      .toBuffer()
    const out = await letterboxFaceTemplate(template)
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true })
    expect(info.width).toBe(512)
    const at = (x: number, y: number): number => data[(y * info.width + x) * info.channels] ?? -1
    expect(at(5, 5)).toBeLessThan(20) // border: black
    expect(at(256, 256)).toBeGreaterThan(230) // centre: the template
    expect(at(256 - 135, 256)).toBeGreaterThan(230) // 280/2 = 140 px half-side
    expect(at(256 - 150, 256)).toBeLessThan(20)
  })
})

describe('realignVerdictFrom', () => {
  it('takes the one face that looks like the old sample', () => {
    const v = realignVerdictFrom([face([0.8, 0.6, 0])], [1, 0, 0], MODEL)
    expect(v).toMatchObject({ kind: 'realigned', modelId: MODEL, score: 0.8 })
    if (v.kind === 'realigned') expect(v.cosineToOld).toBeCloseTo(0.8, 5)
  })

  it('refuses below the 0.5 floor — the re-detection latched onto something else', () => {
    expect(realignVerdictFrom([face([0.4, 0.9165, 0])], [1, 0, 0], MODEL).kind).toBe('refused')
  })

  it('refuses no face at all', () => {
    expect(realignVerdictFrom([], [1, 0, 0], MODEL).kind).toBe('refused')
  })

  it('refuses a face from another model space', () => {
    expect(
      realignVerdictFrom([face([0.9, 0.43589, 0], { modelId: 'arcface-r100' })], [1, 0, 0], MODEL)
        .kind,
    ).toBe('refused')
  })
})

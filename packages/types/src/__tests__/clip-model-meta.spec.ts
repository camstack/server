import { describe, expect, it } from 'vitest'
import {
  ClipModelMetaSchema,
  CLIP_VECTOR_INDEX_PATTERN,
  resolveClipSearchMinScore,
} from '../types/clip-model.js'
import { ModelCatalogEntrySchema } from '../types/models.js'

const meta = {
  textModelId: 'siglip2-b16-224-text',
  embeddingDim: 768,
  vectorIndex: 'object-clip-siglip2-b16-224',
  tokenizerFile: 'camstack-siglip2-b16-224-tokenizer.json',
  contextLength: 64,
  padId: 0,
  searchMinScore: 0.1,
}

describe('ClipModelMeta (D649)', () => {
  it('parses a SigLIP2 block and rides on a catalog entry', () => {
    expect(ClipModelMetaSchema.parse(meta)).toEqual(meta)
    const entry = ModelCatalogEntrySchema.parse({
      id: 'siglip2-b16-224',
      name: 'SigLIP2',
      description: 'x',
      formats: {},
      inputSize: { width: 224, height: 224 },
      labels: [],
      clip: meta,
    })
    expect(entry.clip?.vectorIndex).toBe('object-clip-siglip2-b16-224')
  })

  it('accepts only object-clip-<model> index names — nothing that collides as a sqlite table, and not the retired bare object-clip (D871)', () => {
    expect(CLIP_VECTOR_INDEX_PATTERN.test('object-clip')).toBe(false)
    expect(ClipModelMetaSchema.safeParse({ ...meta, vectorIndex: 'object-clip' }).success).toBe(
      false,
    )
    expect(CLIP_VECTOR_INDEX_PATTERN.test('object-clip-siglip2-b16-224')).toBe(true)
    expect(CLIP_VECTOR_INDEX_PATTERN.test('object_clip_x')).toBe(false)
    expect(CLIP_VECTOR_INDEX_PATTERN.test('faces')).toBe(false)
    expect(ClipModelMetaSchema.safeParse({ ...meta, vectorIndex: 'Object-Clip' }).success).toBe(
      false,
    )
  })
})

describe('resolveClipSearchMinScore — the floor is per model', () => {
  it("reproduces MobileCLIP's historical presets 0.20 / 0.25 / 0.30", () => {
    const mc = { searchMinScore: 0.2 }
    expect(resolveClipSearchMinScore(mc, {})).toBe(0.2)
    expect(resolveClipSearchMinScore(mc, { strictness: 'balanced' })).toBe(0.25)
    expect(resolveClipSearchMinScore(mc, { strictness: 'strict' })).toBe(0.3)
  })

  it("scales SigLIP2's own floor, and an absolute minScore wins verbatim", () => {
    expect(resolveClipSearchMinScore(meta, {})).toBe(0.1)
    expect(resolveClipSearchMinScore(meta, { strictness: 'balanced' })).toBe(0.125)
    expect(resolveClipSearchMinScore(meta, { minScore: 0.2, strictness: 'strict' })).toBe(0.2)
  })
})

import { ClipModelMetaSchema, CLIP_VECTOR_INDEX_PATTERN } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_CLIP_MODELS,
  buildClipModelRegistry,
  DEFAULT_CLIP_MODEL,
} from '../../../shared/clip/clip-model-registry.js'
import { CLIP_IMAGE_MODELS, CLIP_TEXT_MODELS, SIGLIP2_TOKENIZER_FILE } from '../embedding-models.js'

describe('CLIP catalogs (embedding-models.ts)', () => {
  it('ships SigLIP2 B/16 alone — MobileCLIP S0/S1/S2 left the catalog', () => {
    expect(CLIP_IMAGE_MODELS.map((m) => m.id)).toEqual(['siglip2-b16-224'])
    expect(CLIP_TEXT_MODELS.map((m) => m.id)).toEqual(['siglip2-b16-224-text'])
    expect(DEFAULT_CLIP_MODEL).toBe('siglip2-b16-224')
  })

  it('every vision entry ships openvino + coreml and NO onnx build (D209)', () => {
    // The int8 ONNX vision exports were measured misaligned with the text
    // encoders (2026-08-21). SigLIP2's fp32 ONNX is on HF as the verification
    // reference only — the encode leg that would load it applies OpenAI
    // mean/std on top of the baked 2x-1, so an onnx entry here would be junk.
    for (const m of CLIP_IMAGE_MODELS) {
      expect(m.formats.onnx).toBeUndefined()
      expect(m.formats.openvino).toBeDefined()
      expect(m.formats.coreml?.isDirectory).toBe(true)
      expect(m.formats.coreml?.files?.length).toBeGreaterThan(0)
    }
  })

  it('every text entry ships onnx (the encoder path) and openvino', () => {
    for (const m of CLIP_TEXT_MODELS) {
      expect(m.formats.onnx).toBeDefined()
      expect(m.formats.openvino).toBeDefined()
    }
  })
})

describe('the per-model CLIP contract (D649)', () => {
  it('every vision entry carries a clip block that parses, and nothing else does', () => {
    for (const m of CLIP_IMAGE_MODELS) {
      expect(ClipModelMetaSchema.safeParse(m.clip).success).toBe(true)
    }
    for (const m of CLIP_TEXT_MODELS) expect(m.clip).toBeUndefined()
  })

  it('each model names a text encoder that exists and hosts ITS tokenizer beside the onnx', () => {
    for (const image of CLIP_IMAGE_MODELS) {
      const meta = image.clip!
      const text = CLIP_TEXT_MODELS.find((t) => t.id === meta.textModelId)
      expect(text, image.id).toBeDefined()
      expect(text!.formats.onnx!.files).toContain(meta.tokenizerFile)
    }
  })

  it('SigLIP2 hosts its tokenizer under its own name, with a 64-token window', () => {
    // The tokenizer lands in a flat models dir shared by every model; a
    // model-specific name is what keeps a second CLIP model (a user model from
    // Model Studio, say) from overwriting it with a different vocabulary.
    const meta = BUILTIN_CLIP_MODELS.resolve('siglip2-b16-224')?.meta
    expect(meta?.tokenizerFile).toBe(SIGLIP2_TOKENIZER_FILE)
    expect(meta?.contextLength).toBe(64)
  })

  it('SigLIP2 is 768-d in its OWN index with a 64-token window', () => {
    expect(BUILTIN_CLIP_MODELS.resolve('siglip2-b16-224')?.meta).toMatchObject({
      textModelId: 'siglip2-b16-224-text',
      embeddingDim: 768,
      vectorIndex: 'object-clip-siglip2-b16-224',
      contextLength: 64,
      padId: 0,
    })
    expect(BUILTIN_CLIP_MODELS.spaceFor('siglip2-b16-224')).toMatchObject({
      index: 'object-clip-siglip2-b16-224',
      dim: 768,
    })
    expect(BUILTIN_CLIP_MODELS.resolve('siglip2-b16-224')?.inputSize).toBe(224)
  })

  it('every index name is a valid, unique sqlite-vec table name', () => {
    const tables = BUILTIN_CLIP_MODELS.spaces().map((s) => {
      expect(s.index).toMatch(CLIP_VECTOR_INDEX_PATTERN)
      return `vec_${s.index.replace(/[^a-zA-Z0-9_]/g, '_')}`
    })
    for (const t of tables) expect(t).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    expect(new Set(tables).size).toBe(tables.length)
  })

  it('knows exactly one index: the SigLIP2 one', () => {
    expect(BUILTIN_CLIP_MODELS.spaces().map((s) => s.index)).toEqual([
      'object-clip-siglip2-b16-224',
    ])
  })

  it('an unknown id has NO fallback — the old silent MobileCLIP fallback truncated 768-d queries', () => {
    expect(BUILTIN_CLIP_MODELS.resolve('mobileclip-s0')).toBeNull()
    expect(BUILTIN_CLIP_MODELS.resolve('mobileclip-s1')).toBeNull()
    expect(BUILTIN_CLIP_MODELS.resolve('arcface-r100')).toBeNull()
    expect(BUILTIN_CLIP_MODELS.spaceFor('arcface-r100')).toBeNull()
    expect(BUILTIN_CLIP_MODELS.resolve(DEFAULT_CLIP_MODEL)).not.toBeNull()
  })

  it('refuses a catalog where two models share an index at different dimensions', () => {
    const base = CLIP_IMAGE_MODELS[0]!
    expect(() =>
      buildClipModelRegistry([
        base,
        { ...base, id: 'other', clip: { ...base.clip!, embeddingDim: 512 } },
      ]),
    ).toThrow(/object-clip-siglip2-b16-224.*768.*512/)
  })
})

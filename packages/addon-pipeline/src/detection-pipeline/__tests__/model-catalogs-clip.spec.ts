import { describe, it, expect } from 'vitest'
import { CLIP_EMBEDDING_MODELS } from '../registry/model-catalogs.js'

describe('CLIP_EMBEDDING_MODELS catalog', () => {
  it('exports SigLIP2 alone — MobileCLIP S0/S1/S2 left the catalog', () => {
    expect(CLIP_EMBEDDING_MODELS.map((m) => m.id)).toEqual(['siglip2-b16-224'])
  })

  it('SigLIP2 is Apache-2.0 and hosted under clip/siglip2/ (D649)', () => {
    const siglip = CLIP_EMBEDDING_MODELS.find((m) => m.id === 'siglip2-b16-224')
    expect(siglip?.license?.weights).toBe('Apache-2.0')
    expect(siglip?.formats.openvino?.url).toContain('/clip/siglip2/openvino/')
    expect(siglip?.formats.openvino?.files).toEqual(['camstack-siglip2-b16-224-vision.bin'])
    expect(siglip?.formats.coreml?.url).toContain('/clip/siglip2/coreml/')
  })

  it('ships openvino and coreml, and NO onnx vision build', () => {
    // The int8-quantized ONNX vision exports were measured misaligned with the
    // text encoders on 2026-08-21 (matched image↔text cosine ≈ 0.01 vs ≈ 0.22
    // for the fp16 openvino/coreml builds of the SAME checkpoints): the hub's
    // cpu/onnx engine was writing collapsed junk vectors into `object-clip`.
    // No onnx entry ⇒ an onnx-format engine cannot serve the model and the
    // node-local engine fallback rescues clip-embedding onto openvino/coreml
    // (D199). Re-adding onnx requires a NEW, alignment-verified export.
    for (const m of CLIP_EMBEDDING_MODELS) {
      expect(m.formats.onnx).toBeUndefined()
      expect(m.formats.openvino).toBeDefined()
      expect(m.formats.coreml).toBeDefined()
    }
  })

  it('each model has the square input its graph was exported at (SigLIP2 224)', () => {
    const sizes = Object.fromEntries(CLIP_EMBEDDING_MODELS.map((m) => [m.id, m.inputSize]))
    expect(sizes).toEqual({
      'siglip2-b16-224': { width: 224, height: 224 },
    })
  })

  it('each model uses preprocessMode resize', () => {
    for (const m of CLIP_EMBEDDING_MODELS) {
      expect(m.preprocessMode).toBe('resize')
    }
  })

  it('each model uses inputNormalization none (rescale /255 only, no mean/std)', () => {
    for (const m of CLIP_EMBEDDING_MODELS) {
      expect(m.inputNormalization === 'none' || m.inputNormalization === undefined).toBe(true)
    }
  })
})

/**
 * Face-model provenance. The catalog used to carry two models with a licence
 * that was NOT permissive (SCRFD: InsightFace non-commercial; ArcFace: UNKNOWN
 * terms and a ResNet34 behind an `r100` id) — both facts invisible from the
 * catalog unless declared. Both left the catalog; what survives is YuNet (MIT)
 * and AuraFace (Apache-2.0).
 *
 * This spec pins that every remaining entry declares its licence, and that the
 * two non-permissive models are really gone.
 */
import { describe, expect, it } from 'vitest'
import { FACE_DETECTION_MODELS, FACE_EMBEDDING_MODELS } from '../registry/model-catalogs.js'
import { getDefaultModelForFormat, getStepDefinition } from '../registry/step-definitions.js'

describe('face model provenance is declared', () => {
  it('every face-detection model declares a license', () => {
    for (const m of FACE_DETECTION_MODELS) {
      expect(m.license?.weights, `${m.id} must declare its weight licence`).toBeTruthy()
    }
  })

  it('every face-embedding model declares a license', () => {
    for (const m of FACE_EMBEDDING_MODELS) {
      expect(m.license?.weights, `${m.id} must declare its weight licence`).toBeTruthy()
    }
  })

  it('the non-commercial / unknown-licence face models are gone (scrfd-2.5g, arcface-r100)', () => {
    expect(FACE_DETECTION_MODELS.map((m) => m.id)).toEqual(['yunet-2023mar'])
    expect(FACE_EMBEDDING_MODELS.map((m) => m.id)).toEqual(['auraface-r100'])
  })

  it('no remaining face model is non-commercial or UNKNOWN', () => {
    for (const m of [...FACE_DETECTION_MODELS, ...FACE_EMBEDDING_MODELS]) {
      expect(m.license?.nonCommercial, m.id).not.toBe(true)
      expect(m.license?.weights, m.id).not.toBe('UNKNOWN')
    }
  })
})

/**
 * `auraface-r100` is the permissively-licensed successor (fal.ai AuraFace v1,
 * Apache-2.0, a real iResNet-100) and, since D651, the face-embedding DEFAULT:
 * the UNKNOWN-licence `arcface-r100` is no longer the default and has since left
 * the catalog (there is no rollback target). A default flip never strands the gallery on
 * its own: `identity-samples` rows only match samples carrying the probe's
 * `modelId`, and the re-embed pass (`face-reembed-pass.ts`) moves every sample
 * with a stored template into the cluster model's space.
 *
 * The default is per FORMAT too: the three engines this cluster runs (OpenVINO
 * on the Intel nodes, CoreML on the Mac, ONNX as the portable fallback) must
 * each resolve to AuraFace, or one node class would silently embed with the
 * old model — and the cluster rule would then refuse to substitute it.
 */
describe('auraface-r100 is the default', () => {
  const aura = FACE_EMBEDDING_MODELS.find((m) => m.id === 'auraface-r100')

  it('is in the catalog with all three engine formats', () => {
    expect(aura).toBeDefined()
    expect(aura?.formats.onnx?.url).toContain('faceRecognition/auraface/onnx/')
    expect(aura?.formats.openvino?.url).toContain('faceRecognition/auraface/openvino/')
    expect(aura?.formats.coreml?.url).toContain('faceRecognition/auraface/coreml/')
  })

  it('declares Apache-2.0 — the whole reason it exists', () => {
    expect(aura?.license?.weights).toBe('Apache-2.0')
  })

  it('needs landmark alignment like every ArcFace-template embedder', () => {
    expect(aura?.faceAlignment).toBe(true)
    expect(aura?.inputSize).toEqual({ width: 112, height: 112 })
    // The upstream export is NCHW; declaring `nhwc` (as the removed ArcFace
    // entry did) would feed a transposed tensor and produce garbage.
    expect(aura?.inputLayout).toBeUndefined()
  })

  it('is the face-embedding default (D651: the UNKNOWN-licence default is retired)', () => {
    expect(getStepDefinition('face-embedding').defaultModelId).toBe('auraface-r100')
  })

  it.each([
    'onnx',
    'openvino',
    'coreml',
  ] as const)('is the default for the %s format — every engine this cluster runs', (format) => {
    expect(getDefaultModelForFormat('face-embedding', format)).toBe('auraface-r100')
  })

  it('is the ONLY face-embedding entry — arcface-r100 / inception-resnet-v1 are gone', () => {
    expect(getStepDefinition('face-embedding').models.map((m) => m.id)).toEqual(['auraface-r100'])
  })
})

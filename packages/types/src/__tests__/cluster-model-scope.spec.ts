/**
 * A model choice has a SCOPE, and the scope decides who may write it.
 *
 * These tests pin the two properties the whole mechanism rests on:
 *
 *  1. the cluster registry's defaults are byte-for-byte the catalog defaults in
 *     force today, so declaring the scope changes NOTHING at deploy;
 *  2. a cluster-scoped step's model is READ from one flat settings record and a
 *     junk value falls back per-field — never to "some other step's model".
 */
import { describe, expect, it } from 'vitest'
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  CLUSTER_MODEL_SECTION_ID,
  clusterModelSettingKey,
  clusterStepSettingKey,
  DEFAULT_CLUSTER_STEP_MODELS,
  interpretStoredClusterModel,
  invalidClusterStepModelEntries,
  isClusterScopedStep,
  overlayClusterStepSettings,
  pickClusterStepModels,
  pickClusterStepSettings,
  readClusterStepModels,
  readClusterStepSettings,
  resolveClusterStepModelId,
} from '../pipeline/cluster-model-scope.js'

describe('CLUSTER_MODEL_SCOPED_STEPS', () => {
  it('names exactly the two embedding steps — the surfaces that own a vector index', () => {
    expect(CLUSTER_MODEL_SCOPED_STEPS.map((s) => s.stepId)).toEqual([
      'face-embedding',
      'clip-embedding',
    ])
  })

  it('defaults face recognition to AuraFace (D651) and semantic search to SigLIP2 (D649)', () => {
    expect(DEFAULT_CLUSTER_STEP_MODELS).toEqual({
      'face-embedding': 'auraface-r100',
      'clip-embedding': 'siglip2-b16-224',
    })
  })

  it('offers AuraFace alone — ArcFace and Inception ResNet left the catalog', () => {
    const face = CLUSTER_MODEL_SCOPED_STEPS.find((s) => s.stepId === 'face-embedding')
    expect(face?.options.map((o) => o.id)).toEqual(['auraface-r100'])
    expect(face?.defaultModelId).toBe('auraface-r100')
  })

  it('offers SigLIP2 alone — MobileCLIP S1/S2 left the catalog (D649)', () => {
    const clip = CLUSTER_MODEL_SCOPED_STEPS.find((s) => s.stepId === 'clip-embedding')
    expect(clip?.options.map((o) => o.id)).toEqual(['siglip2-b16-224'])
    expect(clip?.defaultModelId).toBe('siglip2-b16-224')
  })

  it('gives every scoped step a unique, step-qualified settings key', () => {
    const keys = CLUSTER_MODEL_SCOPED_STEPS.map((s) => clusterModelSettingKey(s.stepId))
    expect(new Set(keys).size).toBe(keys.length)
    expect(clusterModelSettingKey('face-embedding')).toBe('clusterModel:face-embedding')
  })

  it('recognises a scoped step and refuses to claim any other', () => {
    expect(isClusterScopedStep('face-embedding')).toBe(true)
    expect(isClusterScopedStep('clip-embedding')).toBe(true)
    expect(isClusterScopedStep('object-detection')).toBe(false)
    expect(isClusterScopedStep('plate-ocr')).toBe(false)
  })
})

/**
 * D651 fix round 4: ONE interpretation of the stored value, shared by the
 * runtime (`readClusterStepModels`) and the owner's cap answer
 * (`decideClusterModelChoice`). Before it, the same stored `null` was "the
 * default" to the runner and "invalid" to the owner.
 */
describe('interpretStoredClusterModel', () => {
  it.each([
    ['undefined (key never written)', undefined, { kind: 'absent' }],
    ['null (the form cleared the field)', null, { kind: 'absent' }],
    ['an empty string', '', { kind: 'absent' }],
    ['a catalog id', 'auraface-r100', { kind: 'chosen', modelId: 'auraface-r100' }],
    // The runtime pins an id the catalog does not list verbatim (a custom
    // encoder from `custom-model-registry`), so the interpretation does too.
    [
      'an id outside the dropdown',
      'my-custom-encoder',
      { kind: 'chosen', modelId: 'my-custom-encoder' },
    ],
    ['a number', 42, { kind: 'invalid', value: 42 }],
    ['an object', { id: 'x' }, { kind: 'invalid', value: { id: 'x' } }],
    ['a boolean', true, { kind: 'invalid', value: true }],
  ])('%s', (_label, raw, expected) => {
    expect(interpretStoredClusterModel(raw)).toEqual(expected)
  })
})

describe('invalidClusterStepModelEntries', () => {
  it('names every step whose stored value is neither absent nor an id, with the value', () => {
    expect(
      invalidClusterStepModelEntries({
        'clusterModel:face-embedding': 42,
        'clusterModel:clip-embedding': 'custom-clip-encoder',
      }),
    ).toEqual([{ stepId: 'face-embedding', value: 42 }])
    expect(invalidClusterStepModelEntries({ 'clusterModel:face-embedding': null })).toEqual([])
  })
})

describe('readClusterStepModels', () => {
  it('follows the shared interpretation: absent and invalid fall to the default, chosen is kept', () => {
    for (const raw of [undefined, null, '']) {
      expect(readClusterStepModels({ 'clusterModel:face-embedding': raw })['face-embedding']).toBe(
        'auraface-r100',
      )
    }
    expect(
      readClusterStepModels({ 'clusterModel:face-embedding': 'my-custom-encoder' })[
        'face-embedding'
      ],
    ).toBe('my-custom-encoder')
    expect(readClusterStepModels({ 'clusterModel:face-embedding': 42 })['face-embedding']).toBe(
      'auraface-r100',
    )
  })

  it('reads a chosen model per step', () => {
    expect(
      readClusterStepModels({
        'clusterModel:face-embedding': 'auraface',
        'clusterModel:clip-embedding': 'custom-clip-encoder',
      }),
    ).toEqual({ 'face-embedding': 'auraface', 'clip-embedding': 'custom-clip-encoder' })
  })

  it('falls back PER FIELD — a junk face model must not discard a valid clip model', () => {
    expect(
      readClusterStepModels({
        'clusterModel:face-embedding': 42,
        'clusterModel:clip-embedding': 'custom-clip-encoder',
      }),
    ).toEqual({ 'face-embedding': 'auraface-r100', 'clip-embedding': 'custom-clip-encoder' })
  })

  it('an empty store is the catalog default — never an empty id', () => {
    expect(readClusterStepModels({})).toEqual(DEFAULT_CLUSTER_STEP_MODELS)
  })

  it('an empty string is not a choice', () => {
    expect(readClusterStepModels({ 'clusterModel:face-embedding': '' })['face-embedding']).toBe(
      'auraface-r100',
    )
  })
})

describe('pickClusterStepModels', () => {
  it('walks every section, so a section rename cannot revert the cluster', () => {
    const view = {
      sections: [
        { fields: [{ key: 'unrelated', value: 'x' }] },
        { fields: [{ key: 'clusterModel:face-embedding', value: 'auraface' }] },
      ],
    }
    expect(pickClusterStepModels(view)['face-embedding']).toBe('auraface')
  })

  it('a null payload (addon mid-boot) is the default, never a blank', () => {
    expect(pickClusterStepModels(null)).toEqual(DEFAULT_CLUSTER_STEP_MODELS)
  })

  it('the section id is stable — it names the stored row', () => {
    expect(CLUSTER_MODEL_SECTION_ID).toBe('cluster-step-models')
  })
})

describe('resolveClusterStepModelId', () => {
  it('answers null for a node-scoped step — the caller keeps its own resolution', () => {
    expect(resolveClusterStepModelId('object-detection', DEFAULT_CLUSTER_STEP_MODELS)).toBeNull()
  })

  it('answers the cluster row for a cluster-scoped step', () => {
    expect(resolveClusterStepModelId('face-embedding', { 'face-embedding': 'auraface' })).toBe(
      'auraface',
    )
  })

  it('falls back to the registry default when the row is missing the step', () => {
    expect(resolveClusterStepModelId('clip-embedding', {})).toBe('siglip2-b16-224')
  })
})

describe('cluster step settings', () => {
  it('defaults minLandmarkFaceSize to the runner floor so declaring the row is a no-op', () => {
    expect(readClusterStepSettings({})['face-embedding']?.['minLandmarkFaceSize']).toBe(24)
    expect(pickClusterStepSettings(null)['face-embedding']?.['minLandmarkFaceSize']).toBe(24)
  })

  it('reads a stored value per-field and does not discard a sibling step', () => {
    const row = readClusterStepSettings({
      [clusterStepSettingKey('face-embedding', 'minLandmarkFaceSize')]: 32,
    })
    expect(row['face-embedding']?.['minLandmarkFaceSize']).toBe(32)
  })

  it('overlays the cluster row over leftover per-device settings', () => {
    const overlay = overlayClusterStepSettings(
      'face-embedding',
      { minLandmarkFaceSize: 8, other: true },
      { 'face-embedding': { minLandmarkFaceSize: 32 } },
    )
    expect(overlay).toEqual({ minLandmarkFaceSize: 32, other: true })
  })
})

/**
 * The cluster rule, on the node that has to obey it.
 *
 * The property under test is a REFUSAL, and a refusal is the kind of thing a
 * green suite hides: substituting looks identical from the outside — the step
 * runs, a vector comes back, nothing logs an error. So every case here asserts
 * on which of the three verdicts came out, not on "it produced something".
 */
import { describe, expect, it } from 'vitest'
import type { StepDefinition } from '@camstack/types'
import { makeModelCatalogEntry } from '../../__tests__/support/model-catalog-entry.js'
import { resolveClusterStepModel } from '../cluster-model-resolution.js'

/** A cluster-scoped step whose chosen model ships onnx only. */
const faceEmbedding: StepDefinition = {
  id: 'face-embedding',
  name: 'Face Embedding',
  slot: 'classifier',
  postprocessor: 'arcface',
  extractMode: 'crop-roi',
  inputClasses: ['face'],
  outputClasses: ['identity'],
  models: [
    makeModelCatalogEntry({ id: 'arcface-r100', name: 'ArcFace' }),
    makeModelCatalogEntry({ id: 'auraface', name: 'AuraFace' }),
    makeModelCatalogEntry({
      id: 'arcface-portable',
      name: 'ArcFace portable',
      formats: { onnx: { url: 'u', sizeMB: 1 }, coreml: { url: 'u', sizeMB: 1 } },
    }),
  ],
  defaultModelId: 'arcface-r100',
  modelScope: 'cluster',
  defaultConfidence: 0,
}

/** A node-scoped step, to prove the rule does NOT leak onto the rest of the catalog. */
const objectDetection: StepDefinition = {
  id: 'object-detection',
  name: 'Object Detection',
  slot: 'detector',
  postprocessor: 'yolo',
  extractMode: 'full-frame',
  inputClasses: null,
  outputClasses: ['person'],
  models: [
    makeModelCatalogEntry({
      id: 'yolo26n',
      name: 'YOLO26n',
      formats: { onnx: { url: 'u', sizeMB: 1 }, coreml: { url: 'u', sizeMB: 1 } },
    }),
  ],
  defaultModelId: 'yolo26n',
  defaultConfidence: 0.5,
}

const catalog = new Map([
  [faceEmbedding.id, faceEmbedding],
  [objectDetection.id, objectDetection],
])
const lookup = (stepId: string): StepDefinition | null => catalog.get(stepId) ?? null

const cluster = { 'face-embedding': 'auraface', 'clip-embedding': 'mobileclip-s1' }

describe('resolveClusterStepModel', () => {
  it('leaves a NODE-scoped step alone — the cluster row must never override a per-device pick', () => {
    expect(resolveClusterStepModel('object-detection', cluster, 'coreml', lookup)).toEqual({
      kind: 'node-scoped',
    })
  })

  it('pins the cluster model when this node ships a build of that exact id', () => {
    expect(resolveClusterStepModel('face-embedding', cluster, 'onnx', lookup)).toEqual({
      kind: 'pinned',
      modelId: 'auraface',
    })
  })

  it('REFUSES rather than substituting when the node ships no build of the pinned id', () => {
    const verdict = resolveClusterStepModel('face-embedding', cluster, 'coreml', lookup)
    expect(verdict.kind).toBe('refused')
    if (verdict.kind !== 'refused') return
    expect(verdict.modelId).toBe('auraface')
    expect(verdict.format).toBe('coreml')
    // The refusal must name what the node COULD have run, because that is the
    // whole content of the operator's next question.
    expect(verdict.formatsShipped).toEqual(['onnx'])
  })

  it('does NOT fall back to the step format default that would otherwise be substituted', () => {
    // `arcface-portable` HAS a coreml build. The node-scoped rule would have
    // resolved to it. The cluster rule must not: the two encoders are not
    // interchangeable, which is the entire reason this scope exists.
    const verdict = resolveClusterStepModel('face-embedding', cluster, 'coreml', lookup)
    expect(verdict.kind).toBe('refused')
    expect(JSON.stringify(verdict)).not.toContain('arcface-portable')
  })

  it('treats an unknown step as node-scoped — a custom addon owns its own compat', () => {
    expect(resolveClusterStepModel('custom-thing', cluster, 'onnx', lookup)).toEqual({
      kind: 'node-scoped',
    })
  })

  it('uses the registry default when the cluster row does not name the step', () => {
    expect(resolveClusterStepModel('face-embedding', {}, 'onnx', lookup)).toEqual({
      kind: 'pinned',
      modelId: 'auraface-r100',
    })
  })
})

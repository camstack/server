/**
 * The per-node matrix MIRRORS the cluster model row — it does not own it.
 *
 * The failure this guards is the one CLAUDE.md's D62 rule names: a second knob
 * that writes a store the first one never reads. This repo has shipped that
 * twice. Here the shape would be a `face-embedding` cell showing a leftover
 * per-device `modelId` while the runtime resolves the cluster row — two answers
 * on screen to a question that has exactly one, with the wrong one being the
 * editable one.
 */
import { describe, expect, it } from 'vitest'
import { CLUSTER_MODEL_SCOPED_STEPS, DEFAULT_CLUSTER_STEP_MODELS } from '@camstack/types'
import { clusterScopedStep } from '../ClusterStepModel'

describe('clusterScopedStep', () => {
  it('claims exactly the steps the catalog declares cluster-scoped', () => {
    for (const step of CLUSTER_MODEL_SCOPED_STEPS) {
      expect(clusterScopedStep(step.stepId)?.stepId).toBe(step.stepId)
    }
    expect(clusterScopedStep('object-detection')).toBeNull()
    expect(clusterScopedStep('plate-ocr')).toBeNull()
    expect(clusterScopedStep('face-detection')).toBeNull()
  })

  it('carries the choices and the default the settings form uses — ONE registry, two surfaces', () => {
    const face = clusterScopedStep('face-embedding')
    expect(face?.defaultModelId).toBe(DEFAULT_CLUSTER_STEP_MODELS['face-embedding'])
    expect(face?.options.map((o) => o.id)).toContain('auraface-r100')
    // The label the drawer prints names the index a change strands, because
    // "changed a model" and "stranded the enrolled gallery" are the same act
    // and the operator must see the second one.
    expect(face?.indexName).toContain('gallery')
  })
})

describe('the matrix cell for a cluster-scoped step', () => {
  // The cell state is built inline in `NodeDeviceStepsMatrix`; what is asserted
  // here is the CONTRACT it relies on — that a cluster-scoped step is
  // recognisable without asking the per-device store, so the mirror cannot
  // accidentally fall through to the leftover value.
  it('is identifiable from the step id alone, with no per-device lookup', () => {
    expect(clusterScopedStep('face-embedding')).not.toBeNull()
    expect(clusterScopedStep('clip-embedding')).not.toBeNull()
  })

  it('every cluster step has a default that is one of its own options', () => {
    // A default outside the option list would render an empty select whose
    // first change silently rewrites the cluster — the quietest possible way
    // to strand an index.
    for (const step of CLUSTER_MODEL_SCOPED_STEPS) {
      expect(step.options.map((o) => o.id)).toContain(step.defaultModelId)
    }
  })
})

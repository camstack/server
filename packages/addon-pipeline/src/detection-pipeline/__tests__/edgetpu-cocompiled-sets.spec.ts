/**
 * The published co-compiled Edge TPU sets stay coherent with the catalog (D724).
 *
 * A set member is the SAME model as its catalog entry's Coral build (D710: a
 * build is a format of the survivor, never a new id), so a member naming a
 * model the catalog does not ship for `tflite` would load a file no catalog
 * entry vouches for. Every member file must also have a distinct basename:
 * the pool stores a model at `<modelsDir>/<basename of its URL>`, so two sets
 * sharing one name would overwrite each other's file — and the compiled
 * cache tokens with it.
 */
import { describe, expect, it } from 'vitest'
import { EDGETPU_COCOMPILED_SETS } from '../registry/edgetpu-cocompiled-sets.js'
import { getStepDefinition } from '../registry/step-definitions.js'

describe('published co-compiled sets', () => {
  it('every member is a catalog model with a Coral build, under its own step', () => {
    for (const set of EDGETPU_COCOMPILED_SETS) {
      for (const m of set.members) {
        const entry = getStepDefinition(m.stepId).models.find((e) => e.id === m.modelId)
        expect(entry, `${set.id}: ${m.stepId}/${m.modelId}`).toBeDefined()
        expect(entry?.formats.tflite, `${set.id}: ${m.modelId} has no tflite build`).toBeDefined()
      }
    }
  })

  it('every member file has a basename no other file uses', () => {
    const names = EDGETPU_COCOMPILED_SETS.flatMap((s) =>
      s.members.map((m) => m.url.split('/').pop()),
    )
    expect(new Set(names).size).toBe(names.length)
    for (const set of EDGETPU_COCOMPILED_SETS) {
      for (const m of set.members) {
        expect(m.url).toContain(`/edgetpuSets/${set.id}/${set.id}__`)
      }
    }
  })

  it('a set hosts the root exactly when the root is its FIRST member (cache priority)', () => {
    for (const set of EDGETPU_COCOMPILED_SETS) {
      const hasRoot = set.members.some((m) => m.stepId === 'object-detection')
      expect(set.hostsRoot, set.id).toBe(hasRoot)
      if (hasRoot) expect(set.members[0]?.stepId, set.id).toBe('object-detection')
      // A root set never makes the root stream: it keeps its whole cache.
      if (hasRoot) expect(set.members[0]?.streamedMiB, set.id).toBe(0)
    }
  })

  it('a set has at least two members, each once', () => {
    for (const set of EDGETPU_COCOMPILED_SETS) {
      expect(set.members.length, set.id).toBeGreaterThanOrEqual(2)
      const keys = set.members.map((m) => `${m.stepId}/${m.modelId}`)
      expect(new Set(keys).size, set.id).toBe(keys.length)
    }
  })
})

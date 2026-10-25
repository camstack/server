/**
 * Guards the CLIP object-embedding step wiring at the source of truth (the
 * step definition + the default tree builder):
 *   - `clip-embedding` must scope to the object macro classes so the catalog
 *     tree-builder attaches it UNDER object-detection (per-object crops), not
 *     as a full-frame root.
 *   - the default tree must carry clip as an object-detection child, enabled.
 */
import { describe, it, expect } from 'vitest'
import { buildDefaultStepTree } from '../provider'
import { getStepDefinition } from '../registry/step-definitions'

describe('clip-embedding step definition', () => {
  it('scopes to the object-detection macro classes (person/vehicle/animal)', () => {
    const def = getStepDefinition('clip-embedding')
    expect(def.inputClasses).toEqual(['person', 'vehicle', 'animal'])
    // Object-detection emits exactly these three → clip attaches beneath it.
    const objDet = getStepDefinition('object-detection')
    for (const cls of def.inputClasses ?? []) {
      expect(objDet.outputClasses).toContain(cls)
    }
    expect(def.enabledByDefault).toBe(true)
    expect(def.extractMode).toBe('crop-roi')
    expect(def.defaultMinParentScore).toBe(0.4)
  })
})

describe('buildDefaultStepTree — clip-embedding', () => {
  it('carries clip as an enabled object-detection child, never a root', () => {
    for (const format of ['openvino', 'coreml'] as const) {
      const tree = buildDefaultStepTree(format)
      // clip is not a sibling root of object-detection.
      expect(tree.some((s) => s.addonId === 'clip-embedding')).toBe(false)
      const root = tree.find((s) => s.addonId === 'object-detection')
      const clip = root?.children.find((c) => c.addonId === 'clip-embedding')
      expect(clip).toBeDefined()
      expect(clip!.enabled).toBe(true)
    }
  })

  it('an onnx-format tree omits clip — no onnx vision build exists since the int8 exports were retired', () => {
    // See model-catalogs-clip.spec: the int8 onnx vision encoders were
    // misaligned and poisoned the index via the cpu/onnx fallback engine. A
    // tree built for a pure-onnx engine must not carry a step it cannot serve.
    const tree = buildDefaultStepTree('onnx')
    const root = tree.find((s) => s.addonId === 'object-detection')
    expect(root?.children.some((c) => c.addonId === 'clip-embedding')).toBe(false)
  })
})

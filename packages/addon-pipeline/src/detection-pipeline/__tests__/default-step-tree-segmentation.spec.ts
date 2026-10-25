import { describe, it, expect } from 'vitest'
import { buildDefaultStepTree } from '../provider'

describe('buildDefaultStepTree — segmentation', () => {
  it('builds the onnx default tree without throwing and includes the segmentation child', () => {
    const tree = buildDefaultStepTree('onnx')
    const root = tree.find((s) => s.addonId === 'object-detection')
    const childIds = root?.children.map((c) => c.addonId) ?? []
    expect(childIds).toContain('segmentation')
    expect(childIds).not.toContain('segmentation-refiner')
    expect(childIds).not.toContain('instance-segmentation')
  })
})

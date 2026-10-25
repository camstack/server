import { describe, it, expect } from 'vitest'
import { classifyIntelAccelerators } from '../intel-accelerators.js'

describe('classifyIntelAccelerators', () => {
  it('reports intel iGPU when a renderD node has vendor 0x8086', () => {
    const r = classifyIntelAccelerators({
      listRenderNodes: () => ['/dev/dri/renderD128'],
      readVendor: () => '0x8086\n',
    })
    expect(r.gpu).toEqual({ type: 'intel', name: 'Intel iGPU (renderD128)' })
  })
  it('reports no gpu for a non-Intel render node (AMD 0x1002)', () => {
    const r = classifyIntelAccelerators({
      listRenderNodes: () => ['/dev/dri/renderD128'],
      readVendor: () => '0x1002\n',
    })
    expect(r.gpu).toBeNull()
  })
})

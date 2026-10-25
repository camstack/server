import { describe, it, expect } from 'vitest'
import { classifyAmdAccelerators } from '../amd-accelerators.js'
import { classifyAmdNpu } from '../amd-npu.js'

describe('classifyAmdAccelerators', () => {
  it('reports amd iGPU when a renderD node has vendor 0x1002', () => {
    const r = classifyAmdAccelerators({
      listRenderNodes: () => ['/dev/dri/renderD128'],
      readVendor: () => '0x1002\n',
      readDevice: () => '0x15bf\n',
    })
    expect(r.gpu).toEqual({ type: 'amd', name: 'AMD Radeon 760M (gfx1103)' })
  })

  it('reports a generic amd name when the PCI device id is unknown', () => {
    const r = classifyAmdAccelerators({
      listRenderNodes: () => ['/dev/dri/renderD128'],
      readVendor: () => '0x1002\n',
      readDevice: () => '0xdead\n',
    })
    expect(r.gpu).toEqual({ type: 'amd', name: 'AMD iGPU (renderD128)' })
  })

  it('reports no gpu for an Intel render node (0x8086)', () => {
    const r = classifyAmdAccelerators({
      listRenderNodes: () => ['/dev/dri/renderD128'],
      readVendor: () => '0x8086\n',
      readDevice: () => '0x1234\n',
    })
    expect(r.gpu).toBeNull()
  })
})

describe('classifyAmdNpu', () => {
  const amdCtx = {
    platform: 'linux' as const,
    arch: 'x64' as const,
    amdPresent: true,
  }

  it('reports xdna1 for Phoenix accel PCI 1022:1502', () => {
    const npu = classifyAmdNpu(amdCtx, {
      listDir: (p) =>
        p === '/dev/accel' ? ['accel0'] : p === '/sys/class/accel' ? ['accel0'] : [],
      exists: () => false,
      readFile: (p) => {
        if (p.endsWith('/vendor')) return '0x1022\n'
        if (p.endsWith('/device')) return '0x1502\n'
        return ''
      },
    })
    expect(npu).toEqual({
      type: 'amd-xdna',
      name: 'AMD XDNA1 NPU',
      generation: 'xdna1',
    })
  })

  it('reports xdna2 for Strix accel PCI 1022:17f0', () => {
    const npu = classifyAmdNpu(amdCtx, {
      listDir: (p) =>
        p === '/dev/accel' ? ['accel0'] : p === '/sys/class/accel' ? ['accel0'] : [],
      exists: () => false,
      readFile: (p) => {
        if (p.endsWith('/vendor')) return '0x1022\n'
        if (p.endsWith('/device')) return '0x17f0\n'
        return ''
      },
    })
    expect(npu).toEqual({
      type: 'amd-xdna',
      name: 'AMD XDNA2 NPU',
      generation: 'xdna2',
    })
  })

  it('returns null when amdPresent is false', () => {
    const npu = classifyAmdNpu(
      { ...amdCtx, amdPresent: false },
      {
        listDir: () => ['accel0'],
        exists: () => true,
        readFile: () => '0x1022',
      },
    )
    expect(npu).toBeNull()
  })

  it('returns null when no accel char device exists', () => {
    const npu = classifyAmdNpu(amdCtx, {
      listDir: () => [],
      exists: () => false,
      readFile: () => '',
    })
    expect(npu).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { gridPlanFor } from '../grid-plan.js'
import type { GridInstance } from '../grid-instances.js'

const RECT = { x: 0, y: 0, width: 0.5, height: 0.5 } as const

function instance(cells: GridInstance['cells']): GridInstance {
  return {
    id: 'i1',
    cameraStableId: 'camera-grid-i1',
    name: 'g',
    enabled: true,
    fps: 10,
    publishedProfiles: ['mid', 'low'],
    cells,
  }
}

describe('gridPlanFor', () => {
  it('is null for a grid with no cells — nothing to compose is not an error', () => {
    expect(
      gridPlanFor(instance([]), {
        encoder: 'libx264',
        decodeHwAccel: null,
        canvas: { width: 1920, height: 1080 },
      }),
    ).toBeNull()
  })

  it('maps each distinct source camera to one ffmpeg input ordinal, in cell order', () => {
    const plan = gridPlanFor(
      instance([
        { deviceId: 613, source: RECT, cell: RECT },
        { deviceId: 611, source: RECT, cell: RECT },
      ]),
      { encoder: 'libx264', decodeHwAccel: null, canvas: { width: 1920, height: 1080 } },
    )
    expect(plan?.sourceDeviceIds).toEqual([613, 611])
    expect(plan?.layout.cells.map((cell) => cell.inputIndex)).toEqual([0, 1])
  })

  it('DECODES a camera used by two cells exactly once', () => {
    // Two views of one camera is the interesting case of a composite — a
    // wide shot and a crop of the same street. Decoding it twice would double
    // the most expensive part of the composition for no picture at all.
    const plan = gridPlanFor(
      instance([
        { deviceId: 611, source: { x: 0, y: 0, width: 1, height: 1 }, cell: RECT },
        { deviceId: 611, source: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, cell: RECT },
        { deviceId: 612, source: RECT, cell: RECT },
      ]),
      { encoder: 'libx264', decodeHwAccel: null, canvas: { width: 1920, height: 1080 } },
    )
    expect(plan?.sourceDeviceIds).toEqual([611, 612])
    expect(plan?.layout.cells.map((cell) => cell.inputIndex)).toEqual([0, 0, 1])
  })

  it('carries the canvas, the cadence and the encoder through unchanged', () => {
    const plan = gridPlanFor(instance([{ deviceId: 611, source: RECT, cell: RECT }]), {
      encoder: 'h264_vaapi',
      decodeHwAccel: 'vaapi',
      canvas: { width: 1920, height: 1080 },
    })
    expect(plan?.layout.width).toBe(1920)
    expect(plan?.layout.height).toBe(1080)
    expect(plan?.fps).toBe(10)
    expect(plan?.encoder).toBe('h264_vaapi')
    expect(plan?.decodeHwAccel).toBe('vaapi')
  })

  it('scales the bitrate with the canvas rather than pinning one number for every grid', () => {
    const small = gridPlanFor(instance([{ deviceId: 1, source: RECT, cell: RECT }]), {
      encoder: 'libx264',
      decodeHwAccel: null,
      canvas: { width: 640, height: 360 },
    })
    const large = gridPlanFor(instance([{ deviceId: 1, source: RECT, cell: RECT }]), {
      encoder: 'libx264',
      decodeHwAccel: null,
      canvas: { width: 1920, height: 1080 },
    })
    expect((small?.bitrateKbps ?? 0) < (large?.bitrateKbps ?? 0)).toBe(true)
  })
})

describe('gridPlanFor — the per-profile canvas', () => {
  const instance: GridInstance = {
    id: '11111111-1111-4111-8111-111111111111',
    cameraStableId: 'grid-1',
    name: 'Front',
    enabled: true,
    fps: 10,
    publishedProfiles: ['mid', 'low'],
    cells: [
      {
        deviceId: 611,
        source: { x: 0, y: 0, width: 1, height: 1 },
        cell: { x: 0, y: 0, width: 1, height: 1 },
      },
    ],
  }

  it('composes onto the SCALED canvas, and prices the encode from it', () => {
    const high = gridPlanFor(instance, {
      encoder: 'libx264',
      decodeHwAccel: null,
      canvas: { width: 1920, height: 1080 },
    })
    const low = gridPlanFor(instance, {
      encoder: 'libx264',
      decodeHwAccel: null,
      canvas: { width: 480, height: 270 },
    })
    expect(low?.layout.width).toBe(480)
    expect(low?.layout.height).toBe(270)
    // The saving the profile exists to make. A `low` at the `high` bitrate
    // spends all of it.
    expect(low?.bitrateKbps).toBeLessThan(high?.bitrateKbps ?? 0)
  })

  it('keeps the geometry — normalized rectangles need no second version', () => {
    const low = gridPlanFor(instance, {
      encoder: 'libx264',
      decodeHwAccel: null,
      canvas: { width: 480, height: 270 },
    })
    expect(low?.layout.cells[0]?.cell).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

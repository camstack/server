/**
 * Camera grid and Terminal camera blocks (planning#580): a helper whose camera
 * the composer declares and an ENGINE serves. The spec is the configuration;
 * the compiled composition is a bare `new` Camera with no features.
 */
import { describe, expect, it } from 'vitest'
import { DeviceType } from '../../../device/device-type.js'
import { CompositionSchema } from '../../composition.js'
import { compileHelper } from '../compile.js'
import {
  type GridHelperSpec,
  HelperSpecSchema,
  helperDeviceRefs,
  helperMembers,
  isEngineHostedHelper,
  MAX_GRID_CELLS,
  newGridHelperSpec,
  type TerminalHelperSpec,
} from '../spec.js'

const rect = { x: 0, y: 0, width: 0.5, height: 0.5 }
const grid: GridHelperSpec = {
  kind: 'grid',
  fps: 10,
  publishedProfiles: ['mid', 'low'],
  cells: [
    { source: { addonId: 'provider-rtsp', stableId: 'cam-a' }, region: rect, cell: rect },
    { source: { addonId: 'provider-onvif', stableId: 'cam-b' }, region: rect, cell: rect },
  ],
}
const terminal: TerminalHelperSpec = {
  kind: 'terminal',
  terminalId: '3f1c2a4e-6b7d-4e8f-9a0b-1c2d3e4f5a6b',
}

describe('engine-hosted helper specs', () => {
  it('round-trip through the helper union', () => {
    expect(HelperSpecSchema.parse(grid)).toEqual(grid)
    expect(HelperSpecSchema.parse(terminal)).toEqual(terminal)
  })

  it('refuse a grid over the cell bound and a terminal that is not a uuid', () => {
    const tooMany = {
      ...grid,
      cells: Array.from({ length: MAX_GRID_CELLS + 1 }, () => grid.cells[0]),
    }
    expect(HelperSpecSchema.safeParse(tooMany).success).toBe(false)
    expect(HelperSpecSchema.safeParse({ kind: 'terminal', terminalId: 'nope' }).success).toBe(false)
  })

  it('are engine-hosted, read no members, and name the grid sources as device refs', () => {
    expect(isEngineHostedHelper(grid)).toBe(true)
    expect(isEngineHostedHelper(terminal)).toBe(true)
    expect(helperMembers(grid)).toEqual([])
    expect(helperMembers(terminal)).toEqual([])
    expect(helperDeviceRefs(grid)).toEqual(grid.cells.map((c) => c.source))
    expect(helperDeviceRefs(terminal)).toEqual([])
  })

  it('compile to a new Camera with no features, the spec carried as `helper`', () => {
    for (const spec of [grid, terminal]) {
      const result = compileHelper(spec)
      expect(result.ok).toBe(true)
      if (!result.ok) continue
      expect(result.composition.target).toEqual({ kind: 'new', type: DeviceType.Camera })
      expect(result.composition.features).toEqual([])
      expect(result.composition.helper).toEqual(spec)
      expect(CompositionSchema.safeParse(result.composition).success).toBe(true)
    }
  })
})

describe('a new camera grid', () => {
  it('starts empty, at 10 fps, publishing the mid and low profiles, and compiles', () => {
    const spec = newGridHelperSpec()
    expect(spec).toEqual({
      kind: 'grid',
      fps: 10,
      publishedProfiles: ['mid', 'low'],
      cells: [],
    })
    expect(compileHelper(spec).ok).toBe(true)
  })
})

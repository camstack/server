/**
 * The operator-written grid rows.
 *
 * Config is operator-writable, so a malformed or duplicate row is IGNORED
 * rather than allowed to make declaration reconciliation destructive — the same
 * discipline `readTerminalInstances` uses, and for the same reason: one bad row
 * must not delete every camera the addon declares.
 */
import { describe, expect, it } from 'vitest'
import { readGridInstances } from '../grid-instances.js'

const VALID = {
  id: '3f2a8c1e-0000-4000-8000-000000000001',
  cameraStableId: 'camera-grid-front',
  name: 'Fronte casa',
  enabled: true,
  fps: 10,
  cells: [
    {
      deviceId: 107,
      source: { x: 0, y: 0, width: 1, height: 1 },
      cell: { x: 0, y: 0, width: 0.5, height: 1 },
    },
  ],
}

describe('readGridInstances', () => {
  it('keeps a well-formed row', () => {
    const rows = readGridInstances([VALID])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Fronte casa')
  })

  it('ignores a malformed row instead of failing the whole reconcile', () => {
    const invalid: string[] = []
    const rows = readGridInstances([{ id: 'not-a-uuid' }, VALID], (m) => invalid.push(m))
    expect(rows).toHaveLength(1)
    expect(invalid).toHaveLength(1)
  })

  /** Two rows claiming one camera would make the declaration ambiguous. */
  it('ignores a duplicate stable id', () => {
    const dup = { ...VALID, id: '3f2a8c1e-0000-4000-8000-000000000002' }
    const rows = readGridInstances([VALID, dup])
    expect(rows).toHaveLength(1)
  })

  /**
   * A grid created from the integration page carries ONLY a name. Everything
   * else is laid out afterwards in the camera's own settings, so a row with no
   * cells is the normal freshly-created state and must survive.
   */
  it('keeps a freshly created grid that has no cells yet', () => {
    const rows = readGridInstances([{ ...VALID, cells: [] }])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cells).toEqual([])
  })

  /** A cell pointing at no camera cannot be rendered; the row survives without it. */
  /**
   * A cell with no source device cannot be rendered, and there is no honest way
   * to guess which camera it meant. The whole row is refused rather than
   * silently rendering a grid the operator did not lay out.
   */
  it('refuses the row when a cell names no source device', () => {
    const full = { x: 0, y: 0, width: 1, height: 1 }
    const rows = readGridInstances([
      { ...VALID, cells: [...VALID.cells, { source: full, cell: full }] },
    ])
    expect(rows).toHaveLength(0)
  })
})

import { describe, expect, it } from 'vitest'
import { normalizeGridRows } from '../grid-row-normalization.js'

const mintId = (() => {
  let n = 0
  return () => {
    n += 1
    return `00000000-0000-4000-8000-00000000000${String(n)}`
  }
})()

describe('normalizeGridRows', () => {
  it('mints an id and a PERMANENT stable id for a row the operator just typed a name into', () => {
    const result = normalizeGridRows([{ name: 'Front 2x2' }], mintId)
    expect(result.changed).toBe(true)
    const row = result.rows[0]
    expect(row?.['id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(row?.['cameraStableId']).toBe(`camera-grid-${String(row?.['id'])}`)
    expect(row?.['enabled']).toBe(true)
    expect(row?.['cells']).toEqual([])
  })

  it('leaves a row that is already complete alone, byte for byte', () => {
    const complete = {
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      cameraStableId: 'camera-grid-aaaaaaaa-0000-4000-8000-000000000001',
      name: 'Back',
      enabled: true,
      width: 1920,
      height: 1080,
      fps: 10,
      cells: [],
    }
    const result = normalizeGridRows([complete], mintId)
    expect(result.changed).toBe(false)
    expect(result.rows).toEqual([complete])
  })

  it('never re-mints a stable id for a row that already has one', () => {
    // A stable id is permanent the instant it is minted. Re-deriving it from
    // the NAME would make a rename a new camera with an empty history.
    const result = normalizeGridRows(
      [
        {
          id: 'aaaaaaaa-0000-4000-8000-000000000001',
          cameraStableId: 'camera-grid-legacy',
          name: 'Renamed',
        },
      ],
      mintId,
    )
    expect(result.rows[0]?.['cameraStableId']).toBe('camera-grid-legacy')
  })

  it('drops a row with no usable name rather than declaring a nameless camera', () => {
    const result = normalizeGridRows([{ name: '   ' }, {}], mintId)
    expect(result.rows).toEqual([])
    expect(result.changed).toBe(true)
  })
})

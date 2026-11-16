/**
 * Library → Exports `?camera=`: a valid id narrows the list, anything else is
 * every camera, and the picker lists the cameras the exports belong to plus
 * the picked one.
 */
import { describe, expect, it } from 'vitest'
import { exportCameraIds, exportsOfCamera, parseExportCamera } from '../export-camera-filter'

interface Row {
  readonly id: string
  readonly deviceId: number
}

function record(id: string, deviceId: number): Row {
  return { id, deviceId }
}

const ROWS = [record('a', 101), record('b', 102), record('c', 101)]

describe('export camera filter', () => {
  it('parses a numeric camera id and nothing else', () => {
    expect(parseExportCamera('101')).toBe(101)
    expect(parseExportCamera(null)).toBeNull()
    expect(parseExportCamera('abc')).toBeNull()
    expect(parseExportCamera('')).toBeNull()
  })

  it('narrows to one camera, or keeps every export', () => {
    expect(exportsOfCamera(ROWS, 101).map((r) => r.id)).toEqual(['a', 'c'])
    expect(exportsOfCamera(ROWS, null)).toHaveLength(3)
  })

  it('lists the cameras with exports plus the picked one', () => {
    expect(exportCameraIds(ROWS, null)).toEqual([101, 102])
    expect(exportCameraIds(ROWS, 200)).toEqual([101, 102, 200])
  })
})

import {
  coordsForOsdCorner,
  formatOsdCoords,
  isOsdCorner,
  OSD_CORNERS,
  OSD_POSITION_MAX,
  readOsdPosition,
} from '@apocaliss92/nodelink-js'
import { describe, expect, it } from 'vitest'

/**
 * The overlay-position vocabulary, pinned to what real cameras reported.
 *
 * Every value below was READ from a live camera through the raw-read debug
 * surface (`getOsdDatetime`, cmd_id 44) — none of it is invented:
 *
 *  - device 3825 "Camera stanza caldaia" (hub child, channel 3), whose
 *    operator had configured the channel name BOTTOM-RIGHT, the timestamp
 *    TOP-RIGHT and the watermark ON:
 *      osdChannelName { topLeftX: 65536, topLeftY: 65536, enWatermark: true }
 *      osdDatetime    { topLeftX: 65536, topLeftY: 1 }
 *  - device 107 "Cameretta Carol" (channel 0):
 *      osdChannelName { topLeftX: 1,     topLeftY: 65536 }   → bottom-left
 *      osdDatetime    { topLeftX: 1,     topLeftY: 1 }       → top-left
 *  - device 108 "Bedroom" (channel 0):
 *      osdChannelName { topLeftX: 0,     topLeftY: 0 }       → top-left
 *      osdDatetime    { topLeftX: 1,     topLeftY: 1 }       → top-left
 *
 * So each axis is a NORMALISED 16.16 coordinate: the start edge is 0 (some
 * firmwares echo 1) and the far edge is 65536 (= 1.0). That is the whole
 * vocabulary, and it is why a position control can finally be offered.
 */

describe('readOsdPosition — the camera vocabulary, decoded', () => {
  it('device 3825: channel name at (65536, 65536) is bottom-right', () => {
    expect(readOsdPosition(65_536, 65_536)).toEqual({ kind: 'corner', corner: 'bottom-right' })
  })

  it('device 3825: timestamp at (65536, 1) is top-right', () => {
    expect(readOsdPosition(65_536, 1)).toEqual({ kind: 'corner', corner: 'top-right' })
  })

  it('device 107: channel name at (1, 65536) is bottom-left', () => {
    expect(readOsdPosition(1, 65_536)).toEqual({ kind: 'corner', corner: 'bottom-left' })
  })

  it('devices 107/108: (1, 1) and (0, 0) are both top-left — 0 and 1 are the same edge', () => {
    expect(readOsdPosition(1, 1)).toEqual({ kind: 'corner', corner: 'top-left' })
    expect(readOsdPosition(0, 0)).toEqual({ kind: 'corner', corner: 'top-left' })
  })

  it('a coordinate that is on neither edge is CUSTOM, never rounded to a corner', () => {
    // Silently snapping a hand-placed overlay to the nearest corner would
    // make the form claim a position the camera does not hold.
    expect(readOsdPosition(30_000, 40_000)).toEqual({ kind: 'custom', x: 30_000, y: 40_000 })
  })

  it('a fact the camera never reported stays UNKNOWN (D337) — never a default corner', () => {
    expect(readOsdPosition(null, null)).toEqual({ kind: 'unknown' })
    expect(readOsdPosition(undefined, undefined)).toEqual({ kind: 'unknown' })
    // One axis missing is still not a position.
    expect(readOsdPosition(65_536, null)).toEqual({ kind: 'unknown' })
  })
})

describe('coordsForOsdCorner — only values a camera was observed to hold', () => {
  it('round-trips every corner through readOsdPosition', () => {
    for (const corner of OSD_CORNERS) {
      const coords = coordsForOsdCorner(corner)
      expect(readOsdPosition(coords.x, coords.y)).toEqual({ kind: 'corner', corner })
    }
  })

  /**
   * The START edge we WRITE moved from `0` to `1` in nodelink 0.7.3.
   *
   * A packet capture of the Reolink app on 2026-09-19 (Home Hub, Magicam on
   * channel 3) shows it sweeping all four corners and writing top-left as
   * `(0,0)` on one save and `(1,1)` on the next — both took effect, so `0` is
   * not broken and the reader still accepts it (see the test above). We write
   * what the app writes, and nothing more is claimed than that.
   */
  it('the far edge is exactly the value the cameras reported (65536), never a guessed maximum', () => {
    expect(OSD_POSITION_MAX).toBe(65_536)
    expect(coordsForOsdCorner('bottom-right')).toEqual({ x: 65_536, y: 65_536 })
    expect(coordsForOsdCorner('top-left')).toEqual({ x: 1, y: 1 })
    expect(coordsForOsdCorner('top-right')).toEqual({ x: 65_536, y: 1 })
    expect(coordsForOsdCorner('bottom-left')).toEqual({ x: 1, y: 65_536 })
  })
})

describe('isOsdCorner — the write path only accepts the offered vocabulary', () => {
  it('accepts the four corners and nothing else', () => {
    for (const corner of OSD_CORNERS) expect(isOsdCorner(corner)).toBe(true)
    expect(isOsdCorner('custom')).toBe(false)
    expect(isOsdCorner('Lower-Right')).toBe(false)
    expect(isOsdCorner('')).toBe(false)
    expect(isOsdCorner(undefined)).toBe(false)
    expect(isOsdCorner(65_536)).toBe(false)
  })
})

describe('formatOsdCoords', () => {
  it('shows the raw pair so an operator can report an unmapped value', () => {
    expect(formatOsdCoords(30_000, 40_000)).toBe('x=30000, y=40000')
  })
})

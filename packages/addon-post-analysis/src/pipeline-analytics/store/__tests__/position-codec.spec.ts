/**
 * How a track's `positions[]` is stored (D471).
 *
 * ## The measurement
 *
 * `pipeline-analytics:tracks` is 211.6 MB of a 1 117 MB settings database, and
 * `positions` is **94.9 % of it** — 186.5 MB over 30 459 tracks, 162 bytes per
 * position. Measured on a copy of the live DB, per column.
 *
 * A position looked like this:
 *
 *   {"x":2827.2000000000003,"y":611.4,"timestamp":1788253537934,
 *    "bbox":{"x":2725.2000000000003,"y":394.8,"w":204,"h":433.2}}
 *
 * Eighteen characters for a coordinate in PIXELS. That tail is floating-point
 * representation noise, serialised in full and persisted 1.7 million times.
 *
 * Measured on 20 130 real positions, projected onto the table:
 *
 *   as stored today          186 MB   162 B/position
 *   rounded to integers      136 MB   (-27 %)
 *   base64(gzip(today))       35 MB   (-81 %)
 *   both                      29 MB   (-84 %)
 *
 * ## Why rounding is safe, and why it would NOT have been before D399
 *
 * `TrackPosition.source` says which detector pass measured a box. Before D399
 * added it, the ONLY way to tell a full-frame box from a native-resolution
 * recovery box was that full-frame boxes are exact multiples of 1.2 while
 * recovery boxes are full-precision floats — so rounding would have destroyed
 * the distinction. It no longer carries information: `source` does.
 *
 * ## Why base64, one day after D462 removed it
 *
 * Column types are `TEXT | INTEGER | REAL | JSON | BOOLEAN` — there is no BLOB,
 * and teaching the settings backend one is not worth doing in the subsystem
 * that caused a six-hour outage today (D468). base64 costs ~9 MB against raw
 * bytes and still leaves the column five times smaller than the plain JSON.
 * D462's base64 was pure overhead on a wire that could carry bytes; this one
 * buys a 5x reduction on a wire that cannot. Different trade, stated so nobody
 * has to reconstruct it.
 */
import { describe, expect, it } from 'vitest'
import {
  decodePositions,
  encodePositions,
  geometryOnlyPositions,
  roundBbox,
  roundPosition,
} from '../position-codec.js'

const pos = (x: number, y: number, t: number) => ({
  x,
  y,
  timestamp: t,
  bbox: { x: x - 100, y: y - 200, w: 204, h: 433.2 },
  source: 'frame' as const,
})

describe('roundPosition', () => {
  it('drops the float tail from pixel coordinates', () => {
    const r = roundPosition(pos(2827.2000000000003, 611.4, 1788253537934))
    expect(r.x).toBe(2827)
    expect(r.y).toBe(611)
    expect(r.bbox.h).toBe(433)
  })

  it('leaves the timestamp alone — it is not a pixel', () => {
    const r = roundPosition(pos(1, 2, 1788253537934))
    expect(r.timestamp).toBe(1788253537934)
  })

  it('keeps `source`, which is what tells a recovery box from a full-frame one', () => {
    // Before D399 that distinction lived in the FRACTIONAL PART. Rounding is
    // only safe because it no longer does.
    expect(roundPosition(pos(1.2, 2.4, 5)).source).toBe('frame')
  })
})

describe('encodePositions / decodePositions', () => {
  const sample = [pos(2827.2000000000003, 611.4, 1), pos(2800.9, 600.1, 2)]

  it('round-trips', () => {
    const back = decodePositions(encodePositions(sample))
    expect(back).toHaveLength(2)
    expect(back[0]?.timestamp).toBe(1)
    expect(back[1]?.x).toBe(2801)
  })

  it('rounds on the way in, so the stored bytes carry no float tail', () => {
    const encoded = encodePositions(sample)
    const back = decodePositions(encoded)
    expect(back[0]?.x).toBe(2827)
  })

  it('is much smaller than the plain JSON it replaces', () => {
    const plain = JSON.stringify(sample).length
    expect(encodePositions(sample).length).toBeLessThan(plain)
  })

  it('still reads a row written BEFORE this change — a plain array', () => {
    // No migration: every existing row is a plain JSON array and must keep
    // working, for as long as it is never rewritten.
    const back = decodePositions(sample)
    expect(back).toHaveLength(2)
    expect(back[0]?.x).toBeCloseTo(2827.2, 1)
  })

  it('reads a plain array that arrived as a JSON STRING', () => {
    expect(decodePositions(JSON.stringify(sample))).toHaveLength(2)
  })

  it('answers an empty array for anything it cannot read, never throws', () => {
    // A stored value this cannot parse must not take down a track read: the
    // timeline draws a track with no trail, which is visible, rather than the
    // page failing, which is not.
    expect(decodePositions(undefined)).toEqual([])
    expect(decodePositions(null)).toEqual([])
    expect(decodePositions('not base64 and not json')).toEqual([])
    expect(decodePositions(42)).toEqual([])
  })

  it('an empty input encodes to something that decodes back to empty', () => {
    expect(decodePositions(encodePositions([]))).toEqual([])
  })
})

describe('geometryOnlyPositions', () => {
  const p = {
    x: 2827,
    y: 611,
    timestamp: 1788253537934,
    bbox: { x: 2725, y: 394, w: 204, h: 433 },
    source: 'frame' as const,
  }

  it('keeps the bbox, which is all the zone filter reads', () => {
    const [out] = geometryOnlyPositions([p])
    expect(out?.bbox).toEqual(p.bbox)
  })

  it('drops what the receiver throws away — 59 % of the payload', () => {
    const before = JSON.stringify([p]).length
    const after = JSON.stringify(geometryOnlyPositions([p])).length
    expect(after).toBeLessThan(before)
  })

  it('is still a valid position array — the client parses it unchanged', () => {
    // `parsePositionBoxes` only requires `bbox`; the rest of the shape is kept
    // so no consumer has to learn a second form.
    const [out] = geometryOnlyPositions([p])
    expect(typeof out?.x).toBe('number')
    expect(typeof out?.timestamp).toBe('number')
  })
})

describe('roundBbox', () => {
  it('drops the float tail — the same one positions had', () => {
    expect(
      roundBbox({ x: 1413.6000000000001, y: 43.2, w: 1089.6000000000001, h: 398.40000000000003 }),
    ).toEqual({ x: 1414, y: 43, w: 1090, h: 398 })
  })

  it('leaves a row with no bbox exactly as it was', () => {
    expect(roundBbox(null)).toBeNull()
    expect(roundBbox(undefined)).toBeUndefined()
  })

  it('keeps unrelated fields, so nothing downstream loses them', () => {
    const out = roundBbox({ x: 1.6, y: 2.4, w: 3, h: 4, label: 'person' })
    expect(out).toEqual({ x: 2, y: 2, w: 3, h: 4, label: 'person' })
  })
})

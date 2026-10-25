/**
 * The server-side zone test reads the positions column THROUGH the decoder.
 *
 * This is the branch D471 would have broken silently. `rowMatchesZone` used to
 * open with:
 *
 *   const positions = data['positions']
 *   if (!Array.isArray(positions)) return true      // "cannot be tested" → PASS
 *
 * Once positions are stored compressed that column is a STRING, so every row
 * would have taken the pass branch: the server-side zone prefilter would have
 * been OFF while every symptom said it was on — the timeline would simply show
 * more tracks than the drawn zone contains, which nobody reads as a bug.
 *
 * Nothing in the 6 105-test suite failed when the encoder was wired in. That is
 * the point of this file.
 */
import { describe, expect, it } from 'vitest'
import { encodePositions } from '../position-codec.js'
import { rowMatchesZone, type TrackPosition } from '../track-store.js'

const FRAME = { frameWidth: 1000, frameHeight: 1000 }
const at = (x: number, y: number): TrackPosition => ({
  x,
  y,
  timestamp: 1,
  bbox: { x, y, w: 10, h: 10 },
})

/** Left-hand strip of the frame, normalised. */
const LEFT_ZONE = { kind: 'rect' as const, x: 0, y: 0, width: 0.2, height: 1 }

describe('rowMatchesZone with compressed positions', () => {
  it('MATCHES a track that really is inside the zone', () => {
    const row = { ...FRAME, positions: encodePositions([at(50, 500), at(60, 500)]) }
    expect(rowMatchesZone(row, LEFT_ZONE)).toBe(true)
  })

  it('REJECTS a track outside it — the branch that used to pass everything', () => {
    const row = { ...FRAME, positions: encodePositions([at(900, 500), at(910, 500)]) }
    expect(
      rowMatchesZone(row, LEFT_ZONE),
      'the encoded column was read as "cannot be tested" and passed',
    ).toBe(false)
  })

  it('still rejects a PLAIN-array row written before D471', () => {
    // No migration: old rows keep their array and must keep being filtered.
    const row = { ...FRAME, positions: [at(900, 500)] }
    expect(rowMatchesZone(row, LEFT_ZONE)).toBe(false)
  })

  it('passes a row it genuinely cannot test, rather than hiding it', () => {
    expect(rowMatchesZone({ ...FRAME, positions: 'garbage' }, LEFT_ZONE)).toBe(true)
    expect(rowMatchesZone({ positions: encodePositions([at(50, 500)]) }, LEFT_ZONE)).toBe(true)
  })
})

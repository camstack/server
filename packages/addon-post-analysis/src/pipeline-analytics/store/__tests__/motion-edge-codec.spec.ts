/**
 * How a motion episode's rising-edge offsets are stored (D475).
 *
 * Mirrors `position-codec.spec.ts` (D471) — same discipline: a decoder that
 * throws on a corrupt or legacy value would take out the whole event read
 * path, so "cannot read this" must decode to an empty array, never a throw.
 */
import { describe, expect, it } from 'vitest'
import { decodeMotionEdges, encodeMotionEdges } from '../motion-edge-codec.js'

describe('encodeMotionEdges / decodeMotionEdges', () => {
  it('round-trips a sequence of offsets', () => {
    const edges = [0, 1204, 8391]
    const back = decodeMotionEdges(encodeMotionEdges(edges))
    expect(back).toEqual(edges)
  })

  it('the first offset is always 0 — round-trips that too', () => {
    const back = decodeMotionEdges(encodeMotionEdges([0]))
    expect(back).toEqual([0])
  })

  it('round-trips an empty episode (no edges recorded yet)', () => {
    expect(decodeMotionEdges(encodeMotionEdges([]))).toEqual([])
  })

  it('is compact — small integers, not a naive JSON array on the wire', () => {
    const edges = [0, 1204, 8391, 14732]
    const encoded = encodeMotionEdges(edges)
    expect(encoded.startsWith('me1:')).toBe(true)
  })

  it('answers an empty array for anything it cannot read, never throws', () => {
    expect(decodeMotionEdges(undefined)).toEqual([])
    expect(decodeMotionEdges(null)).toEqual([])
    expect(decodeMotionEdges('not base64 and not json')).toEqual([])
    expect(decodeMotionEdges(42)).toEqual([])
    expect(decodeMotionEdges({})).toEqual([])
  })

  it('a legacy row with no edges column decodes to empty, never mistaken for an open episode', () => {
    // The open/closed question is answered by `durationMs`, never by this
    // column: a legacy row has neither, and must not be read as "open".
    expect(decodeMotionEdges(undefined)).toEqual([])
  })

  it('reads a plain JSON array (defensive — the sqlite backend may hand back a parsed JSON column)', () => {
    expect(decodeMotionEdges([0, 500])).toEqual([0, 500])
  })

  it('drops non-numeric / non-finite garbage from an otherwise-parseable array', () => {
    const encoded = encodeMotionEdges([0, 100])
    // Simulate a corrupted decode by feeding a plain array with junk mixed in.
    expect(decodeMotionEdges([0, 'nope', Number.NaN, 200])).toEqual([0, 200])
    expect(decodeMotionEdges(encoded)).toEqual([0, 100])
  })
})

import { describe, it, expect } from 'vitest'
import { splitAnnexBToNals } from '../nal-utils'

// Pins the Annex-B NAL splitter that the recorded-playback push path
// (Session.pushRecordedAccessUnit) relies on to turn a demuxed access unit
// into the individual NAL buffers writeVideoNals expects.
describe('splitAnnexBToNals (recorded-push contract)', () => {
  it('splits a concatenated Annex-B buffer into individual NAL buffers (start codes stripped)', () => {
    const buf = Buffer.from([0, 0, 0, 1, 0x40, 0xaa, 0, 0, 0, 1, 0x42, 0xbb])
    const nals = splitAnnexBToNals(buf)
    expect(nals.length).toBe(2)
    expect(nals[0]).toEqual(Buffer.from([0x40, 0xaa]))
    expect(nals[1]).toEqual(Buffer.from([0x42, 0xbb]))
  })
  it('handles 3-byte start codes', () => {
    const buf = Buffer.from([0, 0, 1, 0x40, 0xaa])
    expect(splitAnnexBToNals(buf)).toEqual([Buffer.from([0x40, 0xaa])])
  })
  it('returns empty for a buffer with no start codes', () => {
    expect(splitAnnexBToNals(Buffer.from([0x40, 0xaa]))).toEqual([])
  })
})

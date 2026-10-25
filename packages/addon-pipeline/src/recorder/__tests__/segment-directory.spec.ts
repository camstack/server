/**
 * The `CSD1` wire format, round-tripped.
 *
 * Both halves live in one module so they cannot drift, and these sweep the
 * varint boundaries because that is where a hand-rolled encoding breaks: a
 * segment start is ~1.78e12 ms, which is six varint bytes, and a 4K segment is
 * ~8.8 MB, which is four.
 */
import { describe, it, expect } from 'vitest'
import { decodeDirectory, encodeDirectory, type DirectoryRow } from '../segment-directory.js'

const base = { profile: 'low', hydrated: true, asOfMs: 1_785_300_000_000 }

describe('CSD1', () => {
  it('round-trips a realistic day', () => {
    const rows: DirectoryRow[] = []
    let t = 1_785_276_000_000
    for (let i = 0; i < 3000; i++) {
      rows.push({ startMs: t, durMs: 7989, bytes: 50_000 + (i % 97) })
      t += 8000
    }
    const bytes = encodeDirectory({ ...base, rows })
    const back = decodeDirectory(bytes)
    expect(back.rows).toEqual(rows)
    expect(back.profile).toBe('low')
    expect(back.hydrated).toBe(true)
    expect(back.asOfMs).toBe(base.asOfMs)
  })

  it('costs about 20 KB for a camera-day', () => {
    // The number that justifies the format: a 3,049-segment day took 1,745 ms
    // to transfer and parse as HLS playlists.
    const rows: DirectoryRow[] = []
    let t = 1_785_276_000_000
    for (let i = 0; i < 3000; i++) {
      rows.push({ startMs: t, durMs: 7989, bytes: 50_000 })
      t += 8000
    }
    const size = encodeDirectory({ ...base, rows }).length
    expect(size).toBeLessThan(30_000)
    expect(size / rows.length).toBeLessThan(10)
  })

  it('survives the varint boundaries either side of a byte step', () => {
    for (const n of [0, 1, 127, 128, 129, 16_383, 16_384, 2_097_151, 2_097_152, 268_435_455]) {
      const rows = [{ startMs: 1_785_276_000_000, durMs: n, bytes: n }]
      expect(decodeDirectory(encodeDirectory({ ...base, rows })).rows).toEqual(rows)
    }
  })

  it('carries an epoch and a 4K segment size without losing precision', () => {
    const rows = [{ startMs: 1_785_276_000_000, durMs: 11_983, bytes: 8_814_000 }]
    expect(decodeDirectory(encodeDirectory({ ...base, rows })).rows).toEqual(rows)
  })

  it('round-trips an EMPTY window, which is a real answer', () => {
    const back = decodeDirectory(encodeDirectory({ ...base, rows: [] }))
    expect(back.rows).toEqual([])
    expect(back.hydrated).toBe(true)
  })

  it('carries `hydrated:false` — the difference between a gap and an unread window', () => {
    // The whole point of Phase 0 travelling to the client: an empty answer that
    // has not been looked at must never render as "no footage".
    const back = decodeDirectory(encodeDirectory({ ...base, hydrated: false, rows: [] }))
    expect(back.hydrated).toBe(false)
  })

  it('reports the profile actually served, which may not be the one asked for', () => {
    const back = decodeDirectory(encodeDirectory({ ...base, profile: 'mid', rows: [] }))
    expect(back.profile).toBe('mid')
  })

  it('round-trips per-row mfra tables (v2), absent rows staying absent', () => {
    // The seek-in-one-round-trip payload: a row that carries its sync-sample
    // table lets the client skip the mfra tail fetch entirely.
    const rows: DirectoryRow[] = [
      {
        startMs: 1_785_276_000_000,
        durMs: 7989,
        bytes: 72_905,
        mfra: {
          trackId: 1,
          mfraOffset: 72_100,
          samples: [
            { timeTicks: 0, moofOffset: 4096 },
            { timeTicks: 51_200, moofOffset: 24_000 },
            { timeTicks: 102_400, moofOffset: 47_500 },
          ],
        },
      },
      // A pre-boot segment: no table, and the decode must not invent one.
      { startMs: 1_785_276_008_000, durMs: 7989, bytes: 50_000 },
    ]
    const back = decodeDirectory(encodeDirectory({ ...base, rows }))
    expect(back.rows).toEqual(rows)
    expect(back.rows[1]?.mfra).toBeUndefined()
  })

  it('a table costs tens of bytes, not hundreds', () => {
    const bare = encodeDirectory({
      ...base,
      rows: [{ startMs: 1_785_276_000_000, durMs: 7989, bytes: 72_905 }],
    }).length
    const withTable = encodeDirectory({
      ...base,
      rows: [
        {
          startMs: 1_785_276_000_000,
          durMs: 7989,
          bytes: 72_905,
          mfra: {
            trackId: 1,
            mfraOffset: 72_100,
            samples: [
              { timeTicks: 0, moofOffset: 4096 },
              { timeTicks: 51_200, moofOffset: 24_000 },
              { timeTicks: 102_400, moofOffset: 47_500 },
            ],
          },
        },
      ],
    }).length
    expect(withTable - bare).toBeLessThan(40)
  })

  it('rejects bytes from another endpoint rather than parsing them', () => {
    expect(() => decodeDirectory(new Uint8Array([1, 2, 3, 4, 5, 6]))).toThrow(/bad magic/)
  })

  it('rejects a future version instead of guessing its layout', () => {
    const bytes = encodeDirectory({ ...base, rows: [] })
    bytes[4] = 99
    expect(() => decodeDirectory(bytes)).toThrow(/unsupported version/)
  })

  it('refuses a truncated payload rather than returning half a window', () => {
    const rows = [{ startMs: 1_785_276_000_000, durMs: 7989, bytes: 50_000 }]
    const bytes = encodeDirectory({ ...base, rows })
    expect(() => decodeDirectory(bytes.subarray(0, bytes.length - 2))).toThrow()
  })
})

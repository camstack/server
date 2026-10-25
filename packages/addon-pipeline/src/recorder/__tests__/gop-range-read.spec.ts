import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { demuxSegmentFullJs } from '../../stream-broker/recorded/segment-demux-js'
import { type RangeReadable, readGopRange, readGopWindowRange } from '../gop-range-read'
import { parseMfra } from '../mfra-index'

/**
 * The D31 letter, applied to the D42 feeder path: a scrub asks for ONE GOP, so
 * the recorder reads the segment's `mfra` tail, the `moov` head and the single
 * `moof`+`mdat` covering the instant — never the whole file. These specs run
 * against a REAL recorded segment (two fragments + mfra), and the range reader
 * is instrumented so "never the whole file" is asserted in bytes, not believed.
 *
 * Fixture facts (probed once, pinned here): video track 1 at timescale 90000;
 * tfra entries { t=0, moof@1370 } and { t=352260 (3914 ms), moof@87665 };
 * mfra starts at 88547; file is 88676 bytes; moov head ends at 1370.
 */

const FIXTURE = path.join(__dirname, '../../stream-broker/recorded/__tests__/fixtures/sample.m4s')

interface InstrumentedFile extends RangeReadable {
  readonly reads: Array<{ offset: number; length: number }>
  readonly totalBytesRead: () => number
}

function openFixture(): { file: InstrumentedFile; bytes: Uint8Array } {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const reads: Array<{ offset: number; length: number }> = []
  const file: InstrumentedFile = {
    size: bytes.length,
    reads,
    totalBytesRead: () => reads.reduce((n, r) => n + r.length, 0),
    read: async (offset, length) => {
      reads.push({ offset, length })
      return bytes.subarray(offset, offset + length)
    },
  }
  return { file, bytes }
}

const SEG = { segmentStartMs: 500_000, segmentDurMs: 4_000 }

describe('readGopRange — mfra byte-range GOP read (D31 on the feeder path)', () => {
  it('uses a finalize-time seeded index without reading the file tail', async () => {
    const { file, bytes } = openFixture()
    const cold = await readGopRange(file, { ...SEG, epochMs: 503_950 })
    expect(cold).not.toBeNull()
    const tailRead = file.reads[0]
    expect(tailRead).toBeDefined()

    const tail = bytes.subarray(tailRead!.offset, tailRead!.offset + tailRead!.length)
    const seededIndex = parseMfra(tail, bytes.length)
    const { file: seededFile } = openFixture()
    const seeded = await readGopRange(seededFile, { ...SEG, epochMs: 503_950, seededIndex })

    expect(seeded?.gopStartMs).toBe(cold?.gopStartMs)
    expect(seededFile.reads).toHaveLength(2)
    expect(seededFile.reads.some((read) => read.offset + read.length === bytes.length)).toBe(false)
  })

  it('an epoch in the FIRST fragment returns head + fragment 1, demuxable standalone', async () => {
    const { file } = openFixture()
    const gop = await readGopRange(file, { ...SEG, epochMs: 501_200 })
    expect(gop).not.toBeNull()
    expect(gop!.gopStartMs).toBe(500_000)
    expect(gop!.gopDurMs).toBe(3_914) // to the next tfra entry
    const aus = await demuxSegmentFullJs(gop!.data)
    expect(aus).not.toBeNull()
    expect(aus!.length).toBe(39) // fragment 1 only — the trailing fragment's AU is absent
    expect(aus![0]!.keyframe).toBe(true)
    expect(aus![0]!.ptsMs).toBe(0) // anchored: the fragment is its own timeline
  })

  it('an epoch in the SECOND fragment returns head + fragment 2 — and never touches fragment 1 mdat', async () => {
    const { file } = openFixture()
    const gop = await readGopRange(file, { ...SEG, epochMs: 503_950 })
    expect(gop).not.toBeNull()
    expect(gop!.gopStartMs).toBe(503_914) // 500 000 + 352260/90000
    expect(gop!.gopDurMs).toBe(86) // remainder of the segment window
    const aus = await demuxSegmentFullJs(gop!.data)
    expect(aus).not.toBeNull()
    expect(aus!.length).toBe(1)
    // THE byte-range property: fragment 1 spans [1370, 87665) — 86 KB of the
    // 88.7 KB file. Serving the second fragment must not have read it.
    for (const r of file.reads) {
      const end = r.offset + r.length
      expect(r.offset >= 87_665 || end <= 1_370 || r.offset >= file.size - 2_048).toBe(true)
    }
    expect(file.totalBytesRead()).toBeLessThan(6_000) // tail + head + 882-byte fragment
  })

  it('reports the bytes it read, and the fragment fetch excludes the mfra tail', async () => {
    const { file } = openFixture()
    const gop = await readGopRange(file, { ...SEG, epochMs: 503_950 })
    expect(gop!.bytesRead).toBe(file.totalBytesRead())
    // The fragment range ends at the mfra offset, not the end of file — the
    // index must never ride along with every final-GOP fetch.
    const fragRead = file.reads.find((r) => r.offset === 87_665)
    expect(fragRead).toBeDefined()
    expect(fragRead!.offset + fragRead!.length).toBe(88_547)
  })

  it('an epoch before the segment start clamps onto the first fragment', async () => {
    const { file } = openFixture()
    const gop = await readGopRange(file, { ...SEG, epochMs: 499_000 })
    expect(gop!.gopStartMs).toBe(500_000)
  })

  it('maxBytes widens the read to every fragment that fits, in ONE range read', async () => {
    // frag1 = 86 295 B, frag2 = 882 B; a budget covering both (segments-60s
    // Task 1: a byte budget over tfra converts into a SET of fragments).
    const { file } = openFixture()
    const gop = await readGopRange(file, { ...SEG, epochMs: 501_200, maxBytes: 1_000_000 })
    expect(gop).not.toBeNull()
    expect(gop!.gopStartMs).toBe(500_000)
    expect(gop!.gopDurMs).toBe(4_000) // fragment 1 + fragment 2 = the whole segment window
    expect(gop!.reachesSegmentEnd).toBe(true)
    expect(gop!.oversizeFragment).toBe(false)
    const aus = await demuxSegmentFullJs(gop!.data)
    expect(aus).not.toBeNull()
    expect(aus!.length).toBe(40) // both fragments' AUs, not just fragment 1's 39

    // Exactly one fragment-range read covering [1370, 88547) — never two
    // separate reads for two fragments that sit back to back on disk.
    const fragRead = file.reads.find((r) => r.offset === 1_370)
    expect(fragRead).toBeDefined()
    expect(fragRead!.length).toBe(88_547 - 1_370)
  })

  it('maxBytes too small for both fragments serves only the first, and says it did not reach the end', async () => {
    const { file } = openFixture()
    // frag1 alone = 86 295 B; frag1+frag2 = 87 177 B.
    const gop = await readGopRange(file, { ...SEG, epochMs: 501_200, maxBytes: 87_000 })
    expect(gop).not.toBeNull()
    expect(gop!.gopDurMs).toBe(3_914) // fragment 1 only, same as the unbudgeted read
    expect(gop!.reachesSegmentEnd).toBe(false)
    expect(gop!.oversizeFragment).toBe(false)
  })

  it('maxBytes smaller than a single fragment still serves it whole — never an empty range', async () => {
    const { file } = openFixture()
    const gop = await readGopRange(file, { ...SEG, epochMs: 501_200, maxBytes: 500 })
    expect(gop).not.toBeNull()
    expect(gop!.gopDurMs).toBe(3_914)
    expect(gop!.oversizeFragment).toBe(true)
    const aus = await demuxSegmentFullJs(gop!.data)
    expect(aus!.length).toBe(39) // fragment 1's own AUs — the read was not dropped
  })

  it('bytes that are not a recorded segment return null (caller falls back to the whole file)', async () => {
    const junk = new Uint8Array(4096).fill(7)
    const file: RangeReadable = {
      size: junk.length,
      read: async (offset, length) => junk.subarray(offset, offset + length),
    }
    const gop = await readGopRange(file, { ...SEG, epochMs: 500_100 })
    expect(gop).toBeNull()
  })
})

/**
 * readGopWindowRange — the replay's window read: a TIME range instead of
 * one instant or a byte budget. Same fixture, same two fragments (frag1
 * [1370, 87665) covers 0-3914 ms of the segment, frag2 [87665, 88547)
 * covers the remaining 86 ms).
 */
describe('readGopWindowRange — mfra byte-range WINDOW read (the replay primitive)', () => {
  it('a window fully inside fragment 1 returns head + fragment 1 only', async () => {
    const { file } = openFixture()
    const gop = await readGopWindowRange(file, {
      ...SEG,
      fromMs: 501_200,
      toMs: 502_200,
      maxBytes: 1_000_000,
    })
    expect(gop).not.toBeNull()
    expect(gop!.gopStartMs).toBe(500_000)
    expect(gop!.gopDurMs).toBe(3_914)
    expect(gop!.reachesWindowEnd).toBe(true)
    const aus = await demuxSegmentFullJs(gop!.data)
    expect(aus).not.toBeNull()
    expect(aus!.length).toBe(39)
  })

  it('a window spanning both fragments returns head + BOTH fragments, in one range read', async () => {
    const { file } = openFixture()
    const gop = await readGopWindowRange(file, {
      ...SEG,
      fromMs: 501_200,
      toMs: 503_999,
      maxBytes: 1_000_000,
    })
    expect(gop).not.toBeNull()
    expect(gop!.gopStartMs).toBe(500_000)
    expect(gop!.gopDurMs).toBe(4_000) // both fragments = the whole segment window
    expect(gop!.reachesWindowEnd).toBe(true)
    const aus = await demuxSegmentFullJs(gop!.data)
    expect(aus).not.toBeNull()
    expect(aus!.length).toBe(40) // both fragments' AUs

    // ONE contiguous range read for both fragments, same as the maxBytes
    // property already proven for readGopRange.
    const fragRead = file.reads.find((r) => r.offset === 1_370)
    expect(fragRead).toBeDefined()
    expect(fragRead!.length).toBe(88_547 - 1_370)
  })

  it('a safety maxBytes cap too small to cover the window truncates and SAYS SO', async () => {
    const { file } = openFixture()
    // frag1 alone = 86 295 B; frag1+frag2 = 87 177 B.
    const gop = await readGopWindowRange(file, {
      ...SEG,
      fromMs: 501_200,
      toMs: 503_999,
      maxBytes: 87_000,
    })
    expect(gop).not.toBeNull()
    expect(gop!.gopDurMs).toBe(3_914) // fragment 1 only — truncated before the window end
    expect(gop!.reachesWindowEnd).toBe(false) // the window was NOT satisfied, unlike the case above
    const aus = await demuxSegmentFullJs(gop!.data)
    expect(aus!.length).toBe(39)
  })

  it('a window landing entirely in fragment 2 anchors there, not at the segment start', async () => {
    const { file } = openFixture()
    const gop = await readGopWindowRange(file, {
      ...SEG,
      fromMs: 503_950,
      toMs: 503_999,
      maxBytes: 1_000_000,
    })
    expect(gop).not.toBeNull()
    expect(gop!.gopStartMs).toBe(503_914)
    expect(gop!.gopDurMs).toBe(86)
    const aus = await demuxSegmentFullJs(gop!.data)
    expect(aus!.length).toBe(1)
  })

  it('bytes that are not a recorded segment return null (caller falls back to the whole segment)', async () => {
    const junk = new Uint8Array(4096).fill(7)
    const file: RangeReadable = {
      size: junk.length,
      read: async (offset, length) => junk.subarray(offset, offset + length),
    }
    const gop = await readGopWindowRange(file, {
      ...SEG,
      fromMs: 500_100,
      toMs: 501_000,
      maxBytes: 1_000_000,
    })
    expect(gop).toBeNull()
  })
})

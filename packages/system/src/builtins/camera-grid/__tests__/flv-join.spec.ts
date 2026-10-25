/**
 * Joining an FLV stream that is already running.
 *
 * MPEG-TS is self-describing — a reader can attach mid-stream and find its
 * bearings at the next PAT/PMT. FLV is not: the 9-byte signature, the
 * `onMetaData` script tag and the AVC sequence header appear ONCE, at the top
 * of the stream. A second consumer attaching to a live composition gets bytes
 * from the middle of a tag and ffmpeg answers
 * `Invalid data found when processing input` — measured on the hub the moment
 * the grid switched to FLV.
 *
 * So the join point keeps the three things that describe the stream and hands
 * them to every new reader, then starts that reader at the next KEYFRAME on a
 * tag boundary.
 */
import { describe, expect, it } from 'vitest'
import { FlvJoinPoint } from '../flv-join.js'

const FLV_HEADER = Buffer.from([
  0x46, 0x4c, 0x56, 0x01, 0x01, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00,
])

function tag(type: number, body: Buffer): Buffer {
  const head = Buffer.alloc(11)
  head.writeUInt8(type, 0)
  head.writeUIntBE(body.length, 1, 3)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(body.length + 11)
  return Buffer.concat([head, body, tail])
}

const SCRIPT = tag(18, Buffer.from([0x02, 0x00, 0x0a, 0x6f, 0x6e, 0x4d, 0x65, 0x74, 0x61]))
/** `0x17` = keyframe + AVC, `0x00` = sequence header. */
const AVC_CONFIG = tag(9, Buffer.from([0x17, 0x00, 0x00, 0x00, 0x00, 0x01, 0x64]))
/** `0x17` + `0x01` = keyframe NALU. */
const KEYFRAME = tag(9, Buffer.from([0x17, 0x01, 0x00, 0x00, 0x00, 0xaa]))
/** `0x27` = inter frame. */
const INTER = tag(9, Buffer.from([0x27, 0x01, 0x00, 0x00, 0x00, 0xbb]))
const AUDIO = tag(8, Buffer.from([0xaf, 0x01, 0xcc]))

describe('FlvJoinPoint', () => {
  it('holds a reader until the stream has described itself AND a keyframe arrives', () => {
    const join = new FlvJoinPoint()
    const reader = join.join()
    join.accept(FLV_HEADER)
    join.accept(SCRIPT)
    join.accept(AVC_CONFIG)
    // Still nothing: a reader starting on an inter frame decodes garbage, and
    // an AVC sequence header is not a picture.
    join.accept(INTER)
    expect(reader.pending).toBe(true)
    expect(reader.take()).toBeNull()

    join.accept(KEYFRAME)
    expect(reader.pending).toBe(false)
    const opened = reader.take()
    expect(opened?.subarray(0, 3).toString()).toBe('FLV')
    expect(opened?.includes(SCRIPT)).toBe(true)
    expect(opened?.includes(AVC_CONFIG)).toBe(true)
    expect(opened?.includes(KEYFRAME)).toBe(true)
  })

  it('serves a LATE reader the same preamble, at the next keyframe', () => {
    const join = new FlvJoinPoint()
    const first = join.join()
    join.accept(Buffer.concat([FLV_HEADER, SCRIPT, AVC_CONFIG, KEYFRAME]))
    first.take()

    const late = join.join()
    join.accept(INTER)
    // The first reader keeps flowing; the late one is still waiting.
    expect(first.take()?.equals(INTER)).toBe(true)
    expect(late.pending).toBe(true)
    expect(late.take()).toBeNull()

    join.accept(KEYFRAME)
    expect(late.pending).toBe(false)
    const forLate = late.take()
    expect(forLate?.subarray(0, 3).toString()).toBe('FLV')
    expect(forLate?.includes(AVC_CONFIG)).toBe(true)
    expect(forLate?.includes(KEYFRAME)).toBe(true)
  })

  it('reassembles a tag SPLIT across two chunks', () => {
    const join = new FlvJoinPoint()
    const reader = join.join()
    const stream = Buffer.concat([FLV_HEADER, SCRIPT, AVC_CONFIG, KEYFRAME])
    const cut = stream.length - 4
    join.accept(stream.subarray(0, cut))
    expect(reader.take()).toBeNull()
    join.accept(stream.subarray(cut))
    expect(reader.take()?.includes(KEYFRAME)).toBe(true)
  })

  it('passes audio tags through once a reader is live', () => {
    const join = new FlvJoinPoint()
    const reader = join.join()
    join.accept(Buffer.concat([FLV_HEADER, SCRIPT, AVC_CONFIG, KEYFRAME]))
    reader.take()
    join.accept(AUDIO)
    expect(reader.take()?.equals(AUDIO)).toBe(true)
  })

  it('keeps the LATEST sequence header — a restarted encoder changes it', () => {
    const join = new FlvJoinPoint()
    const first = join.join()
    join.accept(Buffer.concat([FLV_HEADER, SCRIPT, AVC_CONFIG, KEYFRAME]))
    first.take()
    const newConfig = tag(9, Buffer.from([0x17, 0x00, 0x00, 0x00, 0x00, 0x01, 0x2a]))
    join.accept(newConfig)
    const late = join.join()
    join.accept(KEYFRAME)
    expect(late.take()?.includes(newConfig)).toBe(true)
  })

  it('a closed reader is owed nothing and costs nothing', () => {
    const join = new FlvJoinPoint()
    const reader = join.join()
    join.accept(Buffer.concat([FLV_HEADER, SCRIPT, AVC_CONFIG, KEYFRAME]))
    reader.close()
    join.accept(INTER)
    expect(reader.take()).toBeNull()
  })
})

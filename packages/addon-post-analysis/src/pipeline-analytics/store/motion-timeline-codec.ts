/**
 * How a motion episode's region timeline becomes bytes, and back.
 *
 * One sample is the regions of one analyzer frame inside one second of the
 * episode (`MotionTimelineSample`). Binary layout, little endian:
 *
 *   sample = t:u32 (ms from the episode start) · n:u8 · n × (x,y,w,h : u16)
 *
 * Boxes are analyzer pixels (320x180 class), so a u16 holds them with room to
 * spare; they are rounded to ints. A sample with 6 boxes is 53 bytes raw,
 * 71 as base64 (the settings-store column types have no BLOB). No gzip: at
 * this size its header costs more than it saves.
 *
 * A MALFORMED stored value decodes to `null` ("no timeline"), never a throw
 * and never `[]` — one row's garbage must not take out the event read path,
 * and an absent column (a row written before this one) reads the same way.
 */
import type { MotionTimelineSample } from '@camstack/types'

const ENCODED_PREFIX = 'mt1:'
const SAMPLE_HEADER_BYTES = 5
const BOX_BYTES = 8
const U16_MAX = 0xffff

function clampU16(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(U16_MAX, Math.max(0, Math.round(v)))
}

export function encodeMotionTimeline(samples: readonly MotionTimelineSample[]): string {
  let size = 0
  for (const s of samples) size += SAMPLE_HEADER_BYTES + Math.min(s.boxes.length, 255) * BOX_BYTES
  const buf = Buffer.alloc(size)
  let o = 0
  for (const s of samples) {
    const n = Math.min(s.boxes.length, 255)
    buf.writeUInt32LE(Math.min(0xffffffff, Math.max(0, Math.round(s.t))), o)
    buf.writeUInt8(n, o + 4)
    o += SAMPLE_HEADER_BYTES
    for (let i = 0; i < n; i++) {
      const b = s.boxes[i]
      if (b === undefined) continue
      buf.writeUInt16LE(clampU16(b.x), o)
      buf.writeUInt16LE(clampU16(b.y), o + 2)
      buf.writeUInt16LE(clampU16(b.w), o + 4)
      buf.writeUInt16LE(clampU16(b.h), o + 6)
      o += BOX_BYTES
    }
  }
  return ENCODED_PREFIX + buf.toString('base64')
}

/** `null` for an absent, foreign or malformed value — see the file header. */
export function decodeMotionTimeline(value: unknown): readonly MotionTimelineSample[] | null {
  if (typeof value !== 'string' || !value.startsWith(ENCODED_PREFIX)) return null
  const buf = Buffer.from(value.slice(ENCODED_PREFIX.length), 'base64')
  const out: MotionTimelineSample[] = []
  let o = 0
  while (o < buf.length) {
    if (o + SAMPLE_HEADER_BYTES > buf.length) return null
    const t = buf.readUInt32LE(o)
    const n = buf.readUInt8(o + 4)
    o += SAMPLE_HEADER_BYTES
    if (o + n * BOX_BYTES > buf.length) return null
    const boxes = []
    for (let i = 0; i < n; i++) {
      boxes.push({
        x: buf.readUInt16LE(o),
        y: buf.readUInt16LE(o + 2),
        w: buf.readUInt16LE(o + 4),
        h: buf.readUInt16LE(o + 6),
      })
      o += BOX_BYTES
    }
    out.push({ t, boxes })
  }
  return out.length > 0 ? out : null
}

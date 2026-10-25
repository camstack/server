import { describe, it, expect } from 'vitest'
import { codecStringFromFragment } from '../codec-probe.js'

/** Serialize one ISO-BMFF box: 32-bit size + 4-char type + payload parts. */
function box(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
  const size = 8 + payload.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(size)
  new DataView(out.buffer).setUint32(0, size)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let off = 8
  for (const p of payload) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** VisualSampleEntry fixed fields BEFORE the child boxes: 6 reserved + 2
 *  data_reference_index + 70 bytes of pre_defined/width/height/…/depth. The
 *  probe skips them wholesale, so zeroes are fine. */
const VISUAL_SAMPLE_ENTRY_PREFIX = new Uint8Array(78)

/** stsd FullBox payload head: version(1)+flags(3)+entry_count(4). */
function stsdHead(entryCount: number): Uint8Array {
  const head = new Uint8Array(8)
  new DataView(head.buffer).setUint32(4, entryCount)
  return head
}

/** Wrap a codec sample entry into ftyp+moov(trak(mdia(minf(stbl(stsd))))). */
function fragmentWith(sampleEntry: Uint8Array): Uint8Array {
  const stsd = box('stsd', stsdHead(1), sampleEntry)
  const moov = box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd)))))
  const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x35])) // 'iso5'
  return concat(ftyp, moov)
}

/** avcC: configurationVersion, profile_idc, constraint flags, level_idc (+ tail). */
function avcCBox(profile: number, constraints: number, level: number): Uint8Array {
  return box(
    'avcC',
    new Uint8Array([1, profile, constraints, level, 0xff, 0xe1, 0x00, 0x00, 0x01, 0x00, 0x00]),
  )
}

/** hvcC head: version, profile_space/tier/profile_idc, 4 compat bytes, 6
 *  constraint bytes, level_idc (+ zero tail). */
function hvcCBox(input: {
  profileSpace: number
  tier: number
  profileIdc: number
  compatFlags: number
  constraints: readonly number[]
  levelIdc: number
}): Uint8Array {
  const head = new Uint8Array(23)
  head[0] = 1
  head[1] =
    ((input.profileSpace & 0x03) << 6) | ((input.tier & 0x01) << 5) | (input.profileIdc & 0x1f)
  new DataView(head.buffer).setUint32(2, input.compatFlags >>> 0)
  for (let i = 0; i < 6; i++) head[6 + i] = input.constraints[i] ?? 0
  head[12] = input.levelIdc
  return box('hvcC', head)
}

describe('codecStringFromFragment', () => {
  it('builds an RFC 6381 avc1 string from an avc1/avcC sample entry', () => {
    // High profile (0x64), constraints 0x00, level 4.0 (0x28) → avc1.640028
    const entry = box('avc1', VISUAL_SAMPLE_ENTRY_PREFIX, avcCBox(0x64, 0x00, 0x28))
    expect(codecStringFromFragment(fragmentWith(entry))).toBe('avc1.640028')
  })

  it('builds an hev1 string from a hev1/hvcC sample entry', () => {
    // Main profile (idc 1, compat 0x60000000 → reversed "6"), main tier,
    // level 3.1 (93), constraint byte 0xB0 → hev1.1.6.L93.B0
    const entry = box(
      'hev1',
      VISUAL_SAMPLE_ENTRY_PREFIX,
      hvcCBox({
        profileSpace: 0,
        tier: 0,
        profileIdc: 1,
        compatFlags: 0x60000000,
        constraints: [0xb0, 0, 0, 0, 0, 0],
        levelIdc: 93,
      }),
    )
    expect(codecStringFromFragment(fragmentWith(entry))).toBe('hev1.1.6.L93.B0')
  })

  it('keeps the hvc1 sample-entry code as the string prefix', () => {
    const entry = box(
      'hvc1',
      VISUAL_SAMPLE_ENTRY_PREFIX,
      hvcCBox({
        profileSpace: 0,
        tier: 1,
        profileIdc: 2,
        compatFlags: 0x20000000, // reversed → 0x00000004 → "4"
        constraints: [0, 0, 0, 0, 0, 0],
        levelIdc: 120,
      }),
    )
    // High tier → 'H'; all-zero constraint bytes are omitted entirely.
    expect(codecStringFromFragment(fragmentWith(entry))).toBe('hvc1.2.4.H120')
  })

  it('returns undefined for garbage bytes', () => {
    expect(codecStringFromFragment(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeUndefined()
    expect(codecStringFromFragment(new Uint8Array(0))).toBeUndefined()
  })

  it('returns undefined when the moov carries no recognized video entry', () => {
    const entry = box('mp4a', VISUAL_SAMPLE_ENTRY_PREFIX)
    expect(codecStringFromFragment(fragmentWith(entry))).toBeUndefined()
  })

  it('returns undefined when the moov is truncated by the bounded prefix read', () => {
    const entry = box('avc1', VISUAL_SAMPLE_ENTRY_PREFIX, avcCBox(0x64, 0x00, 0x28))
    const whole = fragmentWith(entry)
    expect(codecStringFromFragment(whole.subarray(0, whole.length - 20))).toBeUndefined()
  })
})

/**
 * Minimal MP4 bytes for the pacing-check specs: `ftyp` + `moov(mvhd)` with a
 * chosen duration — the exact boxes `readMp4DurationMs` walks, in the faststart
 * layout the export engine writes (`-movflags +faststart`, moov first after
 * ftyp).
 */

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  return out
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export interface TestMp4Input {
  readonly durationMs: number
  /** mvhd movie timescale (units per second). */
  readonly timescale?: number
  /** Emit the 64-bit (version 1) mvhd layout. */
  readonly version1?: boolean
}

/** `ftyp` + `moov(mvhd)` bytes whose movie duration is `durationMs`. */
export function buildTestMp4(input: TestMp4Input): Uint8Array {
  const timescale = input.timescale ?? 1000
  const duration = Math.round((input.durationMs / 1000) * timescale)
  let mvhdPayload: Uint8Array
  if (input.version1 === true) {
    mvhdPayload = new Uint8Array(4 + 8 + 8 + 4 + 8)
    const view = new DataView(mvhdPayload.buffer)
    view.setUint8(0, 1) // version
    view.setUint32(20, timescale)
    view.setBigUint64(24, BigInt(duration))
  } else {
    mvhdPayload = new Uint8Array(4 + 4 + 4 + 4 + 4)
    const view = new DataView(mvhdPayload.buffer)
    view.setUint32(12, timescale)
    view.setUint32(16, duration)
  }
  const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x35, 0, 0, 0, 0]))
  const moov = box('moov', box('mvhd', mvhdPayload))
  return concatBytes([ftyp, moov])
}

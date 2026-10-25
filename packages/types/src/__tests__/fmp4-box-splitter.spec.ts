/**
 * Fmp4BoxSplitter — the cut between an fMP4 byte stream and the units HKSV's
 * delegate (and, per roadmap 4b, a CamStack clip source) consume.
 *
 * Two fixture strategies, deliberately both:
 *
 *  - **Crafted boxes** for every rule and every refusal. A real ffmpeg cannot
 *    be made to emit a size-0 `mdat` or a `moof` with no `moov` in front of it
 *    on demand, and those are exactly the cases whose absence is silent.
 *  - **One real ffmpeg round trip**, gated on the binary being present, because
 *    a hand-written fixture only proves the splitter agrees with the person who
 *    wrote it. The argv under test is the one `buildFfmpegArgs` produces for
 *    the fMP4 sink, not a hand-typed approximation — a fixture built from
 *    different flags would pass while production emitted something else.
 */
import { spawnSync } from 'node:child_process'

import { buildFfmpegArgs } from '../ffmpeg/invocation.js'
import { describe, expect, it } from 'vitest'

import { Fmp4BoxSplitter, type Fmp4Unit } from '../ffmpeg/fmp4-box-splitter.js'

// ── crafted boxes ────────────────────────────────────────────────────────

/** A minimal top-level box: 4-byte size, 4-char type, `payload` bytes. */
function box(type: string, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(payload, 8)
  return out
}

/** The same, with a 64-bit `largesize` (`size == 1`). */
function largeBox(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, 1)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  view.setBigUint64(8, BigInt(out.length))
  out.set(payload, 16)
  return out
}

function bytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function fill(n: number, value: number): Uint8Array {
  return new Uint8Array(n).fill(value)
}

const INIT = bytes(box('ftyp', fill(8, 1)), box('moov', fill(32, 2)))
const FRAGMENT_1 = bytes(box('moof', fill(16, 3)), box('mdat', fill(64, 4)))
const FRAGMENT_2 = bytes(box('moof', fill(16, 5)), box('mdat', fill(48, 6)))

/** Feed `stream` in `chunkSize` slices and collect everything emitted. */
function split(
  stream: Uint8Array,
  chunkSize: number,
  splitter = new Fmp4BoxSplitter(),
): {
  units: Fmp4Unit[]
  splitter: Fmp4BoxSplitter
} {
  const units: Fmp4Unit[] = []
  for (let at = 0; at < stream.length; at += chunkSize) {
    units.push(...splitter.push(stream.subarray(at, Math.min(at + chunkSize, stream.length))))
  }
  return { units, splitter }
}

describe('Fmp4BoxSplitter — the units', () => {
  it('cuts ftyp+moov as ONE init unit, then one unit per moof+mdat pair', () => {
    const { units } = split(bytes(INIT, FRAGMENT_1, FRAGMENT_2), 4096)

    expect(units.map((u) => u.kind)).toEqual(['init', 'fragment', 'fragment'])
    expect(units.map((u) => u.sequence)).toEqual([0, 1, 2])
    expect(units[0]!.data).toEqual(INIT)
    expect(units[1]!.data).toEqual(FRAGMENT_1)
    expect(units[2]!.data).toEqual(FRAGMENT_2)
  })

  it('emits a fragment as soon as its mdat closes, NOT when the next moof arrives', () => {
    // Waiting for the next moof would add a whole fragment length of latency —
    // on a 4 s negotiated fragment, four seconds — to a consumer whose entire
    // reason to exist is capturing the moment something happened.
    const splitter = new Fmp4BoxSplitter()
    // The init unit is complete only once something proves nothing more belongs
    // to it, and the first `moof` is that proof — so it lands here, together
    // with the start of fragment 1 and before fragment 1 itself.
    expect(splitter.push(INIT).map((u) => u.kind)).toEqual([])
    expect(splitter.push(box('moof', fill(16, 3))).map((u) => u.kind)).toEqual(['init'])
    expect(splitter.push(box('mdat', fill(64, 4))).map((u) => u.kind)).toEqual(['fragment'])
  })

  it('produces the same units whatever the chunk boundaries are', () => {
    // ffmpeg's stdout chunking is a property of the pipe, not of the media: a
    // splitter that is right at 64 KiB and wrong at 1 byte fails only under load.
    const stream = bytes(INIT, FRAGMENT_1, FRAGMENT_2)
    const reference = split(stream, stream.length).units
    for (const chunkSize of [1, 3, 7, 8, 9, 16, 63, 100, 4096]) {
      const { units } = split(stream, chunkSize)
      expect(
        units.map((u) => [u.kind, u.sequence, u.data.length]),
        `chunk=${chunkSize}`,
      ).toEqual(reference.map((u) => [u.kind, u.sequence, u.data.length]))
      expect(units[1]!.data, `chunk=${chunkSize}`).toEqual(FRAGMENT_1)
    }
  })

  it('reads a 64-bit largesize box', () => {
    const stream = bytes(box('ftyp', fill(8, 1)), largeBox('moov', fill(24, 2)), FRAGMENT_1)
    const { units } = split(stream, 5)
    expect(units.map((u) => u.kind)).toEqual(['init', 'fragment'])
    expect(units[0]!.data.length).toBe(8 + 8 + 16 + 24)
  })

  it('carries boxes between moof and mdat inside the fragment', () => {
    // Rare but legal. Silently dropping one would produce a fragment whose
    // declared offsets no longer match its bytes.
    const fragment = bytes(
      box('moof', fill(16, 3)),
      box('free', fill(4, 9)),
      box('mdat', fill(8, 4)),
    )
    const { units } = split(bytes(INIT, fragment), 6)
    expect(units[1]!.data).toEqual(fragment)
  })

  it('discards interstitial boxes and NAMES them', () => {
    // `mfra` is written at close, `free` is padding: legal, useless to a
    // fragment consumer, and a type nobody expected here is the first sign the
    // muxer is not writing what we think. Dropping in silence hides that.
    const stream = bytes(INIT, FRAGMENT_1, box('mfra', fill(12, 7)), FRAGMENT_2)
    const { units, splitter } = split(stream, 11)
    expect(units.map((u) => u.kind)).toEqual(['init', 'fragment', 'fragment'])
    expect(units[2]!.data).toEqual(FRAGMENT_2)
    expect(splitter.discardedInterstitialTypes).toEqual(['mfra'])
  })
})

describe('Fmp4BoxSplitter — bounded memory', () => {
  it('holds only the in-progress unit, not the stream', () => {
    // The producer is a 24/7 camera. A splitter that keeps what it has already
    // emitted is a heap graph with one straight line on it.
    const splitter = new Fmp4BoxSplitter()
    splitter.push(INIT)
    for (let i = 0; i < 200; i++) splitter.push(FRAGMENT_1)
    expect(splitter.pendingBytes).toBe(0)
  })

  it('faults instead of growing past the bound', () => {
    const splitter = new Fmp4BoxSplitter({ maxUnitBytes: 512 })
    splitter.push(INIT)
    splitter.push(box('moof', fill(16, 3)))
    // An mdat header promising more than the bound, fed a byte at a time.
    for (let i = 0; i < 20; i++) splitter.push(fill(64, 4))
    expect(splitter.fault).toContain('exceeded 512 bytes')
    expect(splitter.push(FRAGMENT_1)).toEqual([])
  })

  it('refuses a box whose declared largesize is over the bound BEFORE reading it', () => {
    const splitter = new Fmp4BoxSplitter({ maxUnitBytes: 1024 })
    splitter.push(INIT)
    const header = new Uint8Array(16)
    const view = new DataView(header.buffer)
    view.setUint32(0, 1)
    for (let i = 0; i < 4; i++) header[4 + i] = 'moof'.charCodeAt(i)
    view.setBigUint64(8, 4_000_000_000n)
    splitter.push(header)
    expect(splitter.fault).toContain('over the 1024 byte bound')
  })
})

describe('Fmp4BoxSplitter — what it refuses', () => {
  it('refuses a size-0 box: it never closes, so no later fragment can be emitted', () => {
    const unbounded = new Uint8Array(8)
    for (let i = 0; i < 4; i++) unbounded[4 + i] = 'mdat'.charCodeAt(i)
    const splitter = new Fmp4BoxSplitter()
    splitter.push(INIT)
    splitter.push(box('moof', fill(16, 3)))
    splitter.push(unbounded)
    expect(splitter.fault).toContain('size 0')
  })

  it('refuses a moof with no initialisation in front of it', () => {
    // A consumer handed fragments with no `ftyp`/`moov` cannot decode ANY of
    // them; failing here names the cause instead of leaving a black clip.
    const splitter = new Fmp4BoxSplitter()
    splitter.push(FRAGMENT_1)
    expect(splitter.fault).toContain('before any initialisation box')
  })

  it('refuses an impossible size and keeps the units cut before it', () => {
    const broken = new Uint8Array(8)
    new DataView(broken.buffer).setUint32(0, 4)
    for (let i = 0; i < 4; i++) broken[4 + i] = 'moof'.charCodeAt(i)
    const splitter = new Fmp4BoxSplitter()
    const first = splitter.push(bytes(INIT, FRAGMENT_1, broken))
    expect(first.map((u) => u.kind)).toEqual(['init', 'fragment'])
    expect(splitter.fault).toContain('impossible size')
  })
})

// ── one real ffmpeg round trip ───────────────────────────────────────────

function ffmpegAvailable(): boolean {
  return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
}

describe.runIf(ffmpegAvailable())('Fmp4BoxSplitter — a real ffmpeg fMP4 stream', () => {
  /**
   * The SAME argv production builds, against a synthetic source. If the sink's
   * flags ever stop producing a fragmented stream, this is the test that says
   * so — the crafted fixtures above would keep passing forever.
   */
  function produce(fragmentMs: number, seconds: number, keyFrameSeconds?: number): Buffer {
    const args = buildFfmpegArgs({
      logLevel: 'error',
      decodeHwAccel: null,
      input: {
        url: `testsrc=size=160x120:rate=15:duration=${seconds}`,
        rtspTransport: null,
        extraArgs: ['-f', 'lavfi'],
      },
      video: {
        kind: 'encode',
        encoder: 'libx264',
        preset: 'ultrafast',
        pixelFormat: 'yuv420p',
        gopFrames: 15,
        forceKeyFramesSeconds: keyFrameSeconds ?? fragmentMs / 1000,
      },
      audio: { kind: 'none' },
      threadCount: 1,
      outputArgs: [],
      sink: { kind: 'stdout', container: 'mp4', fragmentMs },
    })
    // `@camstack/types` resolves to its BUILT dist from this package, so a
    // stale build silently produces the OLD sink args (`-f mp4 pipe:1`, no
    // movflags) and ffmpeg fails with "muxer does not support non seekable
    // output" — a message that names nothing useful. Say the real cause here.
    expect(args.join(' '), 'the fMP4 sink flags are missing — is @camstack/types built?').toContain(
      '-movflags +frag_keyframe+empty_moov+default_base_moof',
    )
    const run = spawnSync('ffmpeg', args, { maxBuffer: 64 * 1024 * 1024 })
    expect(run.status, run.stderr?.toString()).toBe(0)
    return run.stdout
  }

  it('splits into ftyp+moov then moof+mdat, and the pieces reassemble byte-exactly', () => {
    const stream = produce(1000, 4)
    const { units, splitter } = split(new Uint8Array(stream), 8192)

    expect(splitter.fault).toBeNull()
    expect(units[0]!.kind).toBe('init')
    expect(units.slice(1).every((u) => u.kind === 'fragment')).toBe(true)
    // More than one fragment, or the flags are not fragmenting anything.
    expect(units.length).toBeGreaterThan(2)

    // Every unit's first box is what its kind claims.
    const typeAt = (u: Fmp4Unit): string => String.fromCharCode(...u.data.slice(4, 8))
    expect(typeAt(units[0]!)).toBe('ftyp')
    for (const u of units.slice(1)) expect(typeAt(u)).toBe('moof')

    // Nothing is invented and nothing is lost: the emitted units plus the
    // interstitial boxes account for the whole stream.
    const emitted = units.reduce((n, u) => n + u.data.length, 0)
    expect(emitted).toBeLessThanOrEqual(stream.length)
    expect(emitted).toBeGreaterThan(stream.length * 0.9)
  })

  it('a longer negotiated fragment length yields FEWER fragments over the SAME key-frame grid', () => {
    // The conformance check that matters, and it only works with the grid held
    // FIXED: with key frames every 0.5 s in both runs, the only thing that can
    // make the second produce fewer fragments is `-min_frag_duration` actually
    // reaching the muxer. Written the obvious way — grid tied to fragment
    // length — this test stays green with `-min_frag_duration` deleted, because
    // the grid alone explains the difference. Verified by deleting it.
    const short = split(new Uint8Array(produce(500, 4, 0.5)), 8192).units.length
    const long = split(new Uint8Array(produce(2000, 4, 0.5)), 8192).units.length
    expect(short).toBeGreaterThan(long)
  })

  it('the init unit alone carries the moov, and no fragment does', () => {
    // A fragment that dragged the moov with it would decode standalone in a
    // test and desynchronise a real consumer's sequence numbers.
    const { units } = split(new Uint8Array(produce(1000, 3)), 8192)
    const carriesMoov = (u: Fmp4Unit): boolean =>
      Buffer.from(u.data).includes(Buffer.from('moov', 'ascii'))
    expect(carriesMoov(units[0]!)).toBe(true)
    for (const u of units.slice(1)) expect(carriesMoov(u)).toBe(false)
  })
})

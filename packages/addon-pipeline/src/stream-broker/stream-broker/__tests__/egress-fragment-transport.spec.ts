/**
 * The FRAGMENTS transport, end to end through the manager: acquire → ffmpeg
 * argv → splitter → plane → subscriber, with a fake spawn instead of ffmpeg.
 *
 * The three things a reader will want to check are all here and all asserted
 * against the REAL path (no `createChild` override, so `createFragmentChild`
 * and `Fmp4FragmentChild` run):
 *
 *  - the argv actually carries the fMP4 sink and the key-frame grid;
 *  - the transport is in the sharing key, so a fragment consumer and a dial
 *    consumer with identical encode parameters get different children;
 *  - the child's failures behave like the other two transports' (software
 *    retry, liveness removal), because those are the two bugs that made the
 *    push transport dark.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import { FakeFfmpegChild, makeSpawnFn } from '../../../__tests__/support/spawn-fake-child.js'
import {
  EgressTranscodeManager,
  type EgressTranscodeManagerOptions,
} from '../egress-transcode-manager.js'
import type { Fmp4Packet } from '@camstack/types/node'

// ── fakes ────────────────────────────────────────────────────────────────

class FragmentFakeChild extends FakeFfmpegChild {
  /**
   * Whether SIGTERM makes the process exit IMMEDIATELY. A real one does not:
   * ffmpeg flushes and exits some milliseconds later, which is precisely the
   * window in which the software retry is already live and the corpse's exit
   * arrives to report a death that no longer applies.
   */
  exitOnKill = true

  constructor() {
    super(false)
  }

  override kill(): boolean {
    this.killed = true
    if (this.exitOnKill) this.emit('exit', null, 'SIGTERM')
    return true
  }
}

function logger(): IScopedLogger {
  const log: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  } as unknown as IScopedLogger
  return log
}

/** A minimal top-level box. */
function box(type: string, payloadBytes: number, fillValue = 7): Uint8Array {
  const out = new Uint8Array(8 + payloadBytes)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.fill(fillValue, 8)
  return out
}

function concat(...parts: readonly Uint8Array[]): Buffer {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = Buffer.alloc(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const INIT_BYTES = concat(box('ftyp', 8), box('moov', 24))
const FRAGMENT_BYTES = concat(box('moof', 16), box('mdat', 64))

interface Harness {
  readonly manager: EgressTranscodeManager
  readonly children: FragmentFakeChild[]
  readonly argvs: string[][]
  readonly log: IScopedLogger
}

function harness(over: Partial<EgressTranscodeManagerOptions> = {}): Harness {
  const children: FragmentFakeChild[] = []
  const argvs: string[][] = []
  const log = logger()
  const manager = new EgressTranscodeManager({
    logger: log,
    cameraStreamLookup: () =>
      [
        {
          camStreamId: 'native:main',
          deviceId: 101,
          kind: 'rtsp',
          url: 'rtsp://cam/main',
          codec: 'h265',
          resolution: { width: 3840, height: 2160 },
        },
      ] as never,
    resolveProfileSource: () => 'native:main',
    rtspEntryLookup: (brokerId) => ({
      url: `rtsp://127.0.0.1:8554/tok-${brokerId}`,
    }),
    ffmpegConfig: () => ({
      binaryPath: 'ffmpeg',
      hwAccel: 'copy',
      threadCount: 0,
    }),
    resolveDecodeHwAccel: async (_deviceId, override) => override ?? 'vaapi',
    acquireChannel: (brokerId) => ({
      restreamer: { pushPacket: () => {} },
      consumerUrl: `rtsp://127.0.0.1:8554/egress-${brokerId}`,
      release: () => {},
    }),
    releaseGraceMs: 0,
    spawnFn: makeSpawnFn({ spawnArgs: argvs }, () => {
      const child = new FragmentFakeChild()
      children.push(child)
      return child
    }),
    ...over,
  })
  return { manager, children, argvs, log }
}

/** The encode half of a fragment request. 720p h264 off a 4K h265 source. */
function encodeRequest(): Parameters<EgressTranscodeManager['acquire']>[0] {
  return {
    deviceId: 101,
    source: { kind: 'profile', profile: 'high' },
    encode: {
      video: {
        codec: 'h264',
        width: 1280,
        height: 720,
        fps: 15,
        gopFrames: 60,
      },
      audio: { codec: 'aac' },
    },
  }
}

/** Feed the child bytes on the next tick — `start()` resolves on the init unit. */
function feed(child: FragmentFakeChild, ...chunks: readonly Buffer[]): void {
  queueMicrotask(() => {
    for (const chunk of chunks) child.stdout.write(chunk)
  })
}

/**
 * Wait until spawn number `index` has happened. An acquire awaits the source
 * lookup, the hwaccel resolution and (for a push child) a publish before it
 * spawns, so "one microtask" is not a spawn barrier and a test written that way
 * hangs on whichever await is added next.
 */
async function childAt(h: Harness, index: number): Promise<FragmentFakeChild> {
  for (let i = 0; i < 100 && h.children.length <= index; i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
  const child = h.children[index]
  if (child === undefined) throw new Error(`no child spawned at index ${index}`)
  return child
}

// ── the argv ─────────────────────────────────────────────────────────────

describe('acquireFragments — the argv', () => {
  it('spawns the fMP4 sink with the key-frame grid at the negotiated length', async () => {
    const h = harness()
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    await acquiring

    const argv = h.argvs[0]!.join(' ')
    expect(argv).toContain('-movflags +frag_keyframe+empty_moov+default_base_moof')
    // 90 % of the negotiated length, NOT the length itself: a camera whose GOP
    // equals it emits fragments at DOUBLE the requested length (measured, D84).
    // The constant and the measurement live in `@camstack/types`
    // `ffmpeg/invocation.ts` — this asserts the sink actually carries it.
    expect(argv).toContain('-min_frag_duration 3600000')
    expect(argv).toContain('-force_key_frames expr:gte(t,n_forced*4)')
    expect(h.argvs[0]!.slice(-3)).toEqual(['-f', 'mp4', 'pipe:1'])
  })

  it('carries the audio IN-BAND as AAC — HKSV has no second plane to graft one onto', async () => {
    // The reason the recorder's segments cannot serve HKSV: they are libopus.
    const h = harness()
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    await acquiring

    const argv = h.argvs[0]!.join(' ')
    expect(argv).toContain('-c:a aac')
    // Token-exact: `-analyzeduration` (the input probe bound) contains "-an".
    expect(argv.split(' ')).not.toContain('-an')
    expect(argv).not.toContain('libopus')
  })

  it('mints NO restreamer channel and NO published cam stream', async () => {
    // Both would be objects nothing feeds and nobody can reach — the shape that
    // left one dead `egress:*` entry per failed session in the broker registry.
    const acquired: string[] = []
    const published: string[] = []
    const h = harness({
      acquireChannel: (brokerId) => {
        acquired.push(brokerId)
        return {
          restreamer: { pushPacket: () => {} },
          consumerUrl: 'rtsp://x',
          release: () => {},
        }
      },
      publishPushStream: async (input) => {
        published.push(input.camStreamId)
        return null
      },
    })
    const acquiring = h.manager.acquireFragments({
      // Even with `publishLocally` set, which a caller might copy from another
      // request: a fragment child has no cam stream to publish.
      encode: { ...encodeRequest(), publishLocally: true },
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    await acquiring

    expect(acquired).toEqual([])
    expect(published).toEqual([])
  })
})

// ── sharing ──────────────────────────────────────────────────────────────

describe('acquireFragments — sharing and refcount', () => {
  it('shares ONE child between two consumers of the same fragment length', async () => {
    // Roadmap 4b's requirement in one assertion: HKSV and the clip source
    // attach to the same fragmenter, not to two ffmpeg children per camera.
    const h = harness()
    const first = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    const a = await first
    const b = await h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })

    expect(h.children).toHaveLength(1)
    expect(b.pipelineKey).toBe(a.pipelineKey)
    expect(b.plane).toBe(a.plane)
  })

  it('never shares with a DIAL child of identical encode parameters', async () => {
    const h = harness()
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    const frag = await acquiring

    const dialing = h.manager.acquire(encodeRequest())
    feed(await childAt(h, 1), Buffer.from([0, 0, 0, 1, 0x65]))
    const dial = await dialing

    expect(dial.pipelineKey).not.toBe(frag.pipelineKey)
    expect(h.children).toHaveLength(2)
  })

  it('kills the child and ends the plane when the last holder releases', async () => {
    const h = harness()
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    const handle = await acquiring

    await h.manager.release({ pipelineKey: handle.pipelineKey })
    await new Promise((r) => setTimeout(r, 5))
    expect(h.children[0]!.killed).toBe(true)
    // A consumer parked on the generator must be released, not left waiting on
    // a producer that no longer exists.
    expect(handle.plane.isEnded).toBe(true)
  })
})

// ── the media ────────────────────────────────────────────────────────────

describe('acquireFragments — the media reaches a subscriber', () => {
  it('resolves only once the INIT segment has been cut, then delivers fragments', async () => {
    // Resolving on the first BYTE would hand back a handle whose plane may
    // never produce a unit — the "handle nothing feeds" failure, in a new place.
    const h = harness()
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    const child = await childAt(h, 0)

    let resolved = false
    void acquiring.then(() => {
      resolved = true
    })
    child.stdout.emit('data', concat(box('ftyp', 8)))
    await new Promise((r) => setTimeout(r, 0))
    expect(resolved).toBe(false)

    child.stdout.emit('data', concat(box('moov', 24), FRAGMENT_BYTES))
    const handle = await acquiring
    expect(resolved).toBe(true)

    const sub = handle.plane.subscribe({ tag: 'hksv/101' })
    const packets: Fmp4Packet[] = []
    const drained = (async () => {
      for await (const p of sub.packets()) packets.push(p)
    })()
    child.stdout.emit('data', FRAGMENT_BYTES)
    child.emit('exit', 0, null)
    await drained

    // The retained init first (the subscriber attached after it was cut), then
    // the live fragment, with the last one marked.
    expect(packets.map((p) => p.kind)).toEqual(['init', 'fragment'])
    expect(packets[packets.length - 1]!.isLast).toBe(true)
  })

  it('reports fragmentLengthEnforced=false when the child ends up COPYING', async () => {
    // A copy has no encoder to pin a key-frame grid on, so `fragmentMs` becomes
    // a floor set by the source GOP. A consumer that promised its peer a
    // fragment length has to be able to tell the two apart.
    const h = harness()
    const request = encodeRequest()
    const acquiring = h.manager.acquireFragments({
      encode: {
        ...request,
        // Every constraint the 4K h265 source already satisfies ⇒ smart copy.
        encode: { video: { codec: 'h265' }, audio: { codec: 'aac' } },
      },
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    const handle = await acquiring

    expect(handle.fragmentLengthEnforced).toBe(false)
    expect(h.argvs[0]!.join(' ')).not.toContain('-force_key_frames')
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.stringContaining('dictated by the SOURCE GOP'),
      expect.anything(),
    )
  })
})

// ── the failures the other two transports taught us ──────────────────────

describe('acquireFragments — failure behaviour', () => {
  it('retries once in SOFTWARE when the hardware child produces no fragment', async () => {
    const h = harness()
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    // The live vaapi failure: the child exits ~2 s in having produced nothing.
    ;(await childAt(h, 0)).emit('exit', 244, null)
    feed(await childAt(h, 1), INIT_BYTES, FRAGMENT_BYTES)
    const handle = await acquiring

    expect(h.argvs).toHaveLength(2)
    expect(h.argvs[0]!.join(' ')).toContain('-hwaccel vaapi')
    expect(h.argvs[1]!.join(' ')).not.toContain('-hwaccel')
    // What ACTUALLY ran, not what was asked for.
    expect(handle.decodeHwAccel).toBeNull()
  })

  it('does NOT end the plane when a child that TIMED OUT exits under SIGTERM', async () => {
    // The hardware child hangs rather than exiting, the first-unit timeout
    // fires, and killing it produces an exit — while the software retry is
    // already the live producer. Reported as a death, that exit ends the plane
    // the retry is filling, and the consumer sees a stream that stopped for no
    // reason. The `generation` counter alone does NOT cover this: the retry has
    // not spawned yet when the kill's exit arrives, so the generation matches.
    const h = harness({ fragmentFirstUnitTimeoutMs: 10 })
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    await childAt(h, 0)
    feed(await childAt(h, 1), INIT_BYTES, FRAGMENT_BYTES)
    const handle = await acquiring

    expect(h.children[0]!.killed).toBe(true)
    expect(handle.plane.isEnded).toBe(false)
  })

  it('does NOT end the plane when the superseded child exits LATE, after the retry is live', async () => {
    // Same corpse, arriving after the retry spawned and started producing.
    // ffmpeg takes milliseconds to die on SIGTERM, so "the old child is already
    // gone" is not a property to bet a clip on.
    const h = harness({ fragmentFirstUnitTimeoutMs: 20 })
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    const first = await childAt(h, 0)
    first.exitOnKill = false
    feed(await childAt(h, 1), INIT_BYTES, FRAGMENT_BYTES)
    const handle = await acquiring

    first.emit('exit', null, 'SIGTERM')
    expect(handle.plane.isEnded).toBe(false)
  })

  it('fails the acquire when the child dies before any fragment on BOTH attempts', async () => {
    const h = harness()
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    ;(await childAt(h, 0)).emit('exit', 244, null)
    ;(await childAt(h, 1)).emit('exit', 1, null)
    await expect(acquiring).rejects.toThrow(/exited before any fragment/)
  })

  it('REMOVES the entry when a live child dies — the next acquire spawns fresh', async () => {
    const h = harness()
    const first = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    const a = await first

    h.children[0]!.emit('exit', 1, null)
    await new Promise((r) => setTimeout(r, 0))
    expect(a.plane.isEnded).toBe(true)

    const second = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    feed(await childAt(h, 1), INIT_BYTES, FRAGMENT_BYTES)
    const b = await second
    expect(b.plane).not.toBe(a.plane)
    expect(h.children).toHaveLength(2)
  })

  it('ends the plane and says so when the output stops parsing as fMP4', async () => {
    // A splitter fault is not recoverable — it cannot resynchronise mid-box —
    // so every consumer has to be released rather than left parked forever.
    const h = harness()
    const acquiring = h.manager.acquireFragments({
      encode: encodeRequest(),
      fragmentMs: 4000,
    })
    feed(await childAt(h, 0), INIT_BYTES, FRAGMENT_BYTES)
    const handle = await acquiring

    const broken = Buffer.alloc(8)
    broken.writeUInt32BE(4, 0)
    broken.write('moof', 4, 'ascii')
    h.children[0]!.stdout.emit('data', broken)
    await new Promise((r) => setTimeout(r, 0))

    expect(handle.plane.isEnded).toBe(true)
    expect(h.log.error).toHaveBeenCalledWith(
      expect.stringContaining('stopped parsing as fMP4'),
      expect.anything(),
    )
  })
})

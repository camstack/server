/**
 * The broker half of `streamBroker.acquireEgressTranscode` — sharing, refcount
 * and the boundaries where a refcount goes wrong.
 *
 * D67 declared this method, shipped its schema, its sharing key and its
 * immutability rule, and codegen'd the router — with **no body**. This is the
 * body, and these are the properties it has to have:
 *
 *  - **Exact-match sharing, never fuzzy.** Identical arguments reach one child.
 *    Different arguments reach different children, and that is fine. A quantised
 *    ladder that merged NEARLY-identical requests would make the stream a
 *    consumer receives depend on who else is watching and in what order they
 *    arrived — unpredictable in exactly the way a debugging session cannot
 *    tolerate.
 *  - **An immutable handle.** There is no `reconfigure`; a consumer whose
 *    requirements change releases and re-acquires. That is what stops one
 *    consumer's downgrade dragging its co-tenants to 360p, which is what
 *    Alexa's shared `derived:alexa-<id>` did.
 *  - **A refcount that survives the two races.** The last release racing an
 *    acquire, and a re-acquire inside the stop grace.
 */

import type {
  CameraStream,
  EgressTranscodeRequest,
  EncodedPacket,
  IScopedLogger,
  PushAudioInfo,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import {
  type EgressChild,
  type EgressChildSpec,
  type EgressPushSink,
  EgressTranscodeManager,
  type EgressTranscodeManagerOptions,
  normaliseSourceCodec,
  type PushReader,
  type PushReaderCallbacks,
} from '../egress-transcode-manager.js'

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

const STREAM: CameraStream = {
  camStreamId: 'native:main',
  deviceId: 101,
  kind: 'rtsp',
  url: 'rtsp://cam/main',
  codec: 'h265',
  resolution: { width: 3840, height: 2160 },
} as unknown as CameraStream

/** A fake child that records its lifecycle instead of spawning ffmpeg. */
interface FakeChild extends EgressChild {
  readonly startCalls: number
  readonly stopped: boolean
}

function harness(over: Partial<EgressTranscodeManagerOptions> = {}): {
  manager: EgressTranscodeManager
  children: FakeChild[]
  log: IScopedLogger
  releaseStart: () => void
} {
  const children: FakeChild[] = []
  const log = logger()
  /** Held promises so a test can suspend a start mid-flight. */
  const gates: Array<() => void> = []

  const options: EgressTranscodeManagerOptions = {
    logger: log,
    cameraStreamLookup: () => [STREAM],
    resolveProfileSource: () => 'native:main',
    rtspEntryLookup: (brokerId) => ({ url: `rtsp://127.0.0.1:8554/tok-${brokerId}` }),
    ffmpegConfig: () => ({ binaryPath: 'ffmpeg', hwAccel: 'copy', threadCount: 0 }),
    // Mirrors `resolveEgressDecodeHwAccel`: an operator/consumer override is
    // final and needs no probe; otherwise the decoder addon's answer.
    resolveDecodeHwAccel: async (_deviceId, override) => override ?? 'vaapi',
    acquireChannel: (brokerId) => ({
      restreamer: { pushPacket: () => {} },
      consumerUrl: `rtsp://127.0.0.1:8554/egress-${brokerId}`,
      release: () => {},
    }),
    releaseGraceMs: 0,
    createChild: (spec) => {
      let stopped = false
      let startCalls = 0
      const child: FakeChild = {
        get startCalls() {
          return startCalls
        },
        get stopped() {
          return stopped
        },
        start: async () => {
          startCalls += 1
          await new Promise<void>((resolve) => gates.push(resolve))
          return spec.consumerUrl
        },
        stop: async () => {
          stopped = true
        },
        decodeHwAccel: () => spec.invocation.decodeHwAccel,
      }
      children.push(child)
      return child
    },
    ...over,
  }
  return {
    manager: new EgressTranscodeManager(options),
    children,
    log,
    releaseStart: () => {
      for (const g of gates.splice(0)) g()
    },
  }
}

/** A harness whose children start immediately (the common case). */
function fast(over: Partial<EgressTranscodeManagerOptions> = {}): ReturnType<typeof harness> {
  const children: FakeChild[] = []
  const log = logger()
  const h = harness({
    ...over,
    logger: over.logger ?? log,
    // A test that supplies its OWN child factory keeps it — overwriting it here
    // is how the "fails to start" case silently passed against a healthy fake.
    createChild:
      over.createChild ??
      ((spec) => {
        let stopped = false
        let startCalls = 0
        const child: FakeChild = {
          get startCalls() {
            return startCalls
          },
          get stopped() {
            return stopped
          },
          start: async () => {
            startCalls += 1
            return spec.consumerUrl
          },
          stop: async () => {
            stopped = true
          },
          decodeHwAccel: () => spec.invocation.decodeHwAccel,
        }
        children.push(child)
        return child
      }),
  })
  return { ...h, children }
}

/** A recording {@link EgressPushSink} — the local publication, without a broker. */
function pushSink(over: { onRelease?: () => void } = {}): EgressPushSink & {
  readonly packets: EncodedPacket[]
  readonly audioInfos: PushAudioInfo[]
  readonly codecs: string[]
} {
  const packets: EncodedPacket[] = []
  const audioInfos: PushAudioInfo[] = []
  const codecs: string[] = []
  return {
    packets,
    audioInfos,
    codecs,
    push: (packet) => packets.push(packet),
    audioInfo: (info) => audioInfos.push(info),
    videoCodec: (codec) => codecs.push(codec),
    release: async () => over.onRelease?.(),
  }
}

function request(over: Partial<EgressTranscodeRequest> = {}): EgressTranscodeRequest {
  return {
    deviceId: 101,
    source: { kind: 'profile', profile: 'high' },
    encode: { video: { codec: 'h264', width: 1280, height: 720 }, audio: 'passthrough' },
    ...over,
  }
}

describe('normaliseSourceCodec — the one comparison for a codec string', () => {
  it('collapses every spelling of the same codec', () => {
    // The push sink compares the PMT-identified codec against the DECLARED one
    // through this, so two spellings of one codec must not read as a mismatch
    // (a warn nobody can act on) and a real mismatch must not hide behind a
    // spelling (a black picture nobody can explain).
    for (const spelling of ['h265', 'H.265', 'hevc', 'hvc1', 'hev1', 'HEVC']) {
      expect(normaliseSourceCodec(spelling), spelling).toBe('h265')
    }
    expect(normaliseSourceCodec('h264')).toBe('h264')
    expect(normaliseSourceCodec('H.264')).toBe('h264')
  })
})

describe('EgressTranscodeManager — exact-match sharing', () => {
  it('gives two identical requests ONE child and one pipelineKey', async () => {
    const h = fast()
    const a = await h.manager.acquire(request())
    const b = await h.manager.acquire(request())

    expect(a.pipelineKey).toBe(b.pipelineKey)
    expect(h.children).toHaveLength(1)
    expect(h.children[0]!.startCalls).toBe(1)
  })

  it('gives two DIFFERENT requests two children — never a merge', async () => {
    // 720p and 1080p are "nearly identical" and are deliberately NOT merged.
    // Merging them is what makes the stream you receive a function of who else
    // is watching; the operator accepted N processes over that.
    const h = fast()
    const a = await h.manager.acquire(request())
    const b = await h.manager.acquire(
      request({
        encode: { video: { codec: 'h264', width: 1920, height: 1080 }, audio: 'passthrough' },
      }),
    )

    expect(a.pipelineKey).not.toBe(b.pipelineKey)
    expect(h.children).toHaveLength(2)
  })

  it('shares across a differing hostname and tag, and host-substitutes per caller', async () => {
    // `hostname` rewrites only the DIAL address of a restreamer that is the
    // same object either way; folding it into the key would fork the child once
    // per consuming node. `tag` is attribution for the broker panel.
    const h = fast()
    const local = await h.manager.acquire(request({ tag: 'alexa/s1' }))
    const remote = await h.manager.acquire(request({ tag: 'hap/s2', hostname: '10.0.0.9' }))

    expect(remote.pipelineKey).toBe(local.pipelineKey)
    expect(h.children).toHaveLength(1)
    expect(local.url).toContain('127.0.0.1')
    expect(remote.url).toContain('10.0.0.9')
    expect(remote.url).not.toContain('127.0.0.1')
  })

  it('shares an omitted optional with its explicit default', async () => {
    const h = fast()
    const omitted = await h.manager.acquire(request())
    const explicit = await h.manager.acquire(request({ rateControl: 'relaxed' }))
    expect(explicit.pipelineKey).toBe(omitted.pipelineKey)
    expect(h.children).toHaveLength(1)
  })

  it('single-flights concurrent acquires for the same key onto ONE child', async () => {
    const h = harness()
    const first = h.manager.acquire(request())
    const second = h.manager.acquire(request())
    // Both acquires must have REACHED `start()` before it is released — the
    // second one only proves single-flight if it arrived while the first was
    // genuinely in flight.
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    h.releaseStart()
    const [a, b] = await Promise.all([first, second])

    expect(a.pipelineKey).toBe(b.pipelineKey)
    expect(h.children).toHaveLength(1)
    expect(h.children[0]!.startCalls).toBe(1)
  })
})

describe('EgressTranscodeManager — refcount', () => {
  it('keeps the child alive while another holder remains', async () => {
    const h = fast()
    const a = await h.manager.acquire(request())
    await h.manager.acquire(request())

    expect(await h.manager.release({ pipelineKey: a.pipelineKey })).toEqual({
      released: true,
      refcount: 1,
    })
    expect(h.children[0]!.stopped).toBe(false)
  })

  it('stops the child when the LAST holder releases', async () => {
    const h = fast()
    const a = await h.manager.acquire(request())
    expect(await h.manager.release({ pipelineKey: a.pipelineKey })).toEqual({
      released: true,
      refcount: 0,
    })
    await vi.waitFor(() => expect(h.children[0]!.stopped).toBe(true))
  })

  it('reports an unknown key rather than throwing', async () => {
    // A stale handle from before an addon respawn is a normal event, not a
    // fault — and a release that throws would leave the CALLER's own bookkeeping
    // inconsistent on a path it cannot retry.
    const h = fast()
    expect(await h.manager.release({ pipelineKey: 'egress:nope' })).toEqual({
      released: false,
      refcount: 0,
    })
  })

  it('never drives a refcount below zero on a double release', async () => {
    const h = fast()
    const a = await h.manager.acquire(request())
    await h.manager.release({ pipelineKey: a.pipelineKey })
    expect(await h.manager.release({ pipelineKey: a.pipelineKey })).toEqual({
      released: false,
      refcount: 0,
    })
  })

  it('REVIVES an entry re-acquired inside the stop grace, without respawning', async () => {
    // The window between "the last holder released" and "the child is killed"
    // is exactly when a consumer that released to change one parameter comes
    // back. Killing and respawning there costs a full source dial and a
    // keyframe wait for nothing.
    const h = fast({ releaseGraceMs: 10_000 })
    const a = await h.manager.acquire(request())
    await h.manager.release({ pipelineKey: a.pipelineKey })

    const b = await h.manager.acquire(request())
    expect(b.pipelineKey).toBe(a.pipelineKey)
    expect(h.children).toHaveLength(1)
    expect(h.children[0]!.stopped).toBe(false)
    expect(h.children[0]!.startCalls).toBe(1)
  })

  it('does NOT hand out a handle to a child whose stop is already in flight', () => {
    // The boundary case D67 names: the last releaser racing an acquire. The
    // shutdown removes the entry from the map SYNCHRONOUSLY, before it awaits
    // `stop()` — so an acquire that lands inside that await either finds a live
    // entry (and revives it) or finds none (and spawns a fresh child). It can
    // never share a corpse. A `delete` moved after the await reopens exactly
    // that window, and this test is what closes it.
    let releaseStop: () => void = () => {}
    const stopping = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    const started: string[] = []
    let entered = 0
    const h = fast({
      releaseGraceMs: 0,
      createChild: (spec) => {
        started.push(spec.brokerId)
        return {
          start: async () => spec.consumerUrl,
          stop: async () => {
            entered += 1
            await stopping
          },
          decodeHwAccel: () => null,
        }
      },
    })

    return (async () => {
      const a = await h.manager.acquire(request())
      await h.manager.release({ pipelineKey: a.pipelineKey })
      // Wait until `stop()` has been ENTERED but not resolved — the window.
      await vi.waitFor(() => expect(entered).toBe(1))

      const b = await h.manager.acquire(request())
      // A second child, not a reference to the one being torn down.
      expect(started).toHaveLength(2)
      expect(b.url).toContain(started[1]!)
      releaseStop()
    })()
  })

  it('lets a later acquire RETRY after a child failed to start', () => {
    // The in-flight map must be cleared on REJECTION too. Left behind, the
    // settled-rejected promise is re-awaited by every later acquire and one bad
    // spawn — a camera that was booting, a source not yet dialed — becomes
    // permanent for the life of the broker. Asserting only that the second
    // acquire also rejects would pass either way; the discriminating shape is
    // that the second acquire SUCCEEDS once the underlying cause clears.
    let attempts = 0
    const h = fast({
      createChild: (spec) => ({
        start: async () => {
          attempts += 1
          if (attempts === 1) throw new Error('no output within 8000ms')
          return spec.consumerUrl
        },
        stop: async () => {},
        decodeHwAccel: () => null,
      }),
    })

    return (async () => {
      await expect(h.manager.acquire(request())).rejects.toThrow(/no output/)
      const second = await h.manager.acquire(request())
      expect(second.url).toBeTruthy()
      expect(attempts).toBe(2)
    })()
  })

  it('stops every child on shutdownAll — an addon respawn releases everything', async () => {
    // The one mitigation available for a holder that dies without releasing:
    // the refcount does not outlive the process that owns it.
    const h = fast()
    await h.manager.acquire(request())
    await h.manager.acquire(
      request({
        encode: { video: { codec: 'h264', width: 640, height: 360 }, audio: 'passthrough' },
      }),
    )
    await h.manager.shutdownAll()
    expect(h.children.map((c) => c.stopped)).toEqual([true, true])
  })
})

describe('EgressTranscodeManager — what the handle reports', () => {
  it('returns the decode backend the child ACTUALLY ran with', async () => {
    // A consumer that asked for hardware and got software must be able to see
    // that without reading the broker's logs.
    const h = fast()
    const got = await h.manager.acquire(request())
    expect(got.decodeHwAccel).toBe('vaapi')
  })

  it('reports SOFTWARE honestly when the decoder could not answer', async () => {
    const h = fast({ resolveDecodeHwAccel: async () => null })
    const got = await h.manager.acquire(request())
    expect(got.decodeHwAccel).toBeNull()
  })

  it('honours an explicit decodeHwAccel override and keys on it', async () => {
    const h = fast()
    const auto = await h.manager.acquire(request())
    const pinned = await h.manager.acquire(request({ decodeHwAccel: 'qsv' }))
    expect(pinned.pipelineKey).not.toBe(auto.pipelineKey)
    expect(pinned.decodeHwAccel).toBe('qsv')
  })

  it('reports transcoded + the encoder + the negotiated geometry', async () => {
    const h = fast()
    const got = await h.manager.acquire(request())
    expect(got.transcoded).toBe(true)
    expect(got.videoCodec).toBe('H264')
    expect(got.resolution).toEqual({ width: 1280, height: 720 })
    expect(got.encoder).toBe('libx264')
  })
})

describe('EgressTranscodeManager — what it refuses, and what it says out loud', () => {
  it('refuses a profile with no assigned source rather than picking another', async () => {
    const h = fast({ resolveProfileSource: () => null })
    await expect(h.manager.acquire(request())).rejects.toThrow(/no assigned source/)
  })

  it('refuses a source whose broker has not been dialed', async () => {
    const h = fast({ rtspEntryLookup: () => null })
    await expect(h.manager.acquire(request())).rejects.toThrow(/not dialed/)
  })

  it('WIRES the audio sidecar when a consumer asks for a codec it can carry', async () => {
    // This test used to assert the opposite — that an Opus request was dropped
    // with a warning — and that expectation was the whole limitation. The
    // sidecar machinery existed in TranscodeEgress the entire time (UDP RTP
    // receiver, SDP graft) and had never run, because this manager forced
    // `passthrough`. Alexa on the primitive would otherwise have had video and
    // silence, which is exactly the derived path it replaces.
    const specs: EgressChildSpec[] = []
    const h = fast({
      createChild: (spec: EgressChildSpec) => {
        specs.push(spec)
        return {
          start: async () => 'rtsp://127.0.0.1/fake-egress',
          stop: async () => {},
          decodeHwAccel: () => null,
        }
      },
    })
    await h.manager.acquire(
      request({
        encode: {
          video: { codec: 'h264', width: 1280, height: 720 },
          audio: { codec: 'opus', bitrateKbps: 64 },
        },
      }),
    )
    expect(specs[0]?.audio).toEqual({ codec: 'opus' })
  })

  it('leaves the sidecar OFF for a passthrough request', async () => {
    // The video-only path is the one with live hours behind it; asking for no
    // audio must not start binding UDP ports.
    const specs: EgressChildSpec[] = []
    const h = fast({
      createChild: (spec: EgressChildSpec) => {
        specs.push(spec)
        return {
          start: async () => 'rtsp://127.0.0.1/fake-egress',
          stop: async () => {},
          decodeHwAccel: () => null,
        }
      },
    })
    await h.manager.acquire(request())
    expect(specs[0]?.audio).toBeUndefined()
  })

  it('still SAYS SO when a codec has no sidecar mapping', async () => {
    // Dropping is still legitimate for a codec the sidecar cannot emit — it is
    // announcing it silently that is not. Silence reads as "never happened".
    const log = logger()
    const h = fast({ logger: log })
    await h.manager.acquire(
      request({
        encode: {
          video: { codec: 'h264', width: 1280, height: 720 },
          audio: { codec: 'pcma', bitrateKbps: 64 },
        },
      }),
    )
    const warn = vi.mocked(log.warn)
    expect(warn).toHaveBeenCalled()
    const [message, payload] = warn.mock.calls[0]!
    expect(String(message)).toMatch(/audio/i)
    // Every line about a device carries the numeric id under the SAME key.
    expect((payload as { tags?: Record<string, unknown> }).tags).toMatchObject({ deviceId: 101 })
  })

  it('releases the PUBLICATION as well as the channel when the child fails to start', async () => {
    // Only `channel.release()` used to run here, so a start that threw left the
    // cam stream published forever: the broker's registry grew an `egress:*`
    // entry per failed Echo session, each one a stream a consumer could be
    // handed and nothing would ever feed.
    let released = 0
    let channelReleases = 0
    const h = fast({
      publishPushStream: async () => pushSink({ onRelease: () => (released += 1) }),
      acquireChannel: (brokerId) => ({
        restreamer: { pushPacket: () => {} },
        consumerUrl: `rtsp://127.0.0.1:8554/egress-${brokerId}`,
        release: () => (channelReleases += 1),
      }),
      createChild: () => ({
        start: async () => {
          throw new Error('no output within 8000ms')
        },
        stop: async () => {},
        decodeHwAccel: () => null,
      }),
    })
    await expect(h.manager.acquire(request({ publishLocally: true }))).rejects.toThrow(/no output/)
    expect(released).toBe(1)
    // The channel is not minted at all for a push child (see the push suite),
    // so this asserts the fix does not depend on which resource existed.
    expect(channelReleases).toBe(0)
  })

  it('tags the acquire and release lines with the device', async () => {
    const log = logger()
    const h = fast({ logger: log })
    const got = await h.manager.acquire(request())
    await h.manager.release({ pipelineKey: got.pipelineKey })

    const tagged = vi
      .mocked(log.info)
      .mock.calls.filter(
        (c) => (c[1] as { tags?: Record<string, unknown> } | undefined)?.tags?.['deviceId'] === 101,
      )
    expect(tagged.length).toBeGreaterThanOrEqual(2)
  })
})

/**
 * The PUSH child — `publishLocally: true`.
 *
 * This is the transport Alexa uses, and the one that was silently broken on the
 * live hub: `-hwaccel vaapi` fails to create a device INSIDE the stream-broker
 * runner (`code=244`, "Device creation failed: -12"), the reader has no retry of
 * its own, and the child died two seconds after spawn with `packetsOut=0`. The
 * dial path never showed it because `TranscodeEgress` retries in software.
 */
describe('EgressTranscodeManager — the push child', () => {
  interface FakeReader extends PushReader {
    readonly args: readonly string[]
    readonly callbacks: PushReaderCallbacks
    destroyed: boolean
  }

  /** A packet the fake reader hands to the sink — shape only, no real media. */
  const PACKET: EncodedPacket = {
    type: 'video',
    data: Buffer.from([0, 0, 0, 1, 0x65]),
    pts: 0,
    dts: 0,
    keyframe: true,
    codec: 'h264',
  }

  function pushHarness(over: Partial<EgressTranscodeManagerOptions> = {}): {
    manager: EgressTranscodeManager
    readers: FakeReader[]
    sink: ReturnType<typeof pushSink>
    log: IScopedLogger
    channelsAcquired: number
  } {
    const readers: FakeReader[] = []
    const sink = pushSink()
    const log = logger()
    const state = { channelsAcquired: 0 }
    const manager = new EgressTranscodeManager({
      logger: log,
      cameraStreamLookup: () => [STREAM],
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
      acquireChannel: (brokerId) => {
        state.channelsAcquired += 1
        return {
          restreamer: { pushPacket: () => {} },
          consumerUrl: `rtsp://127.0.0.1:8554/egress-${brokerId}`,
          release: () => {},
        }
      },
      releaseGraceMs: 0,
      publishPushStream: async () => sink,
      pushFirstPacketTimeoutMs: 50,
      createPushReader: (input) => {
        const reader: FakeReader = {
          args: input.args,
          callbacks: input.callbacks,
          destroyed: false,
          connect: () => {},
          destroy: () => {
            reader.destroyed = true
          },
        }
        readers.push(reader)
        return reader
      },
      ...over,
    })
    return {
      manager,
      readers,
      sink,
      log,
      get channelsAcquired() {
        return state.channelsAcquired
      },
    }
  }

  it('retries in SOFTWARE when the hardware child dies before producing a packet', async () => {
    // The live failure, exactly: vaapi device creation fails inside the broker
    // runner, ffmpeg exits code=244 at ~2s with packetsOut=0, and nothing
    // respawned it — so the Echo got "answered but NO source media" and closed.
    const h = pushHarness()
    const acquire = h.manager.acquire(request({ publishLocally: true }))

    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    expect(h.readers[0]!.args).toContain('-hwaccel')
    h.readers[0]!.callbacks.onError?.(
      new Error('egress push exited (code=244): Device creation failed: -12'),
    )

    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    // The retry is SOFTWARE: no `-hwaccel` at all, which is what
    // `buildInputArgs` emits for a null backend.
    expect(h.readers[1]!.args).not.toContain('-hwaccel')
    h.readers[1]!.callbacks.onEncodedPacket(PACKET)

    const got = await acquire
    // The handle must not report the backend that FAILED. A consumer that asked
    // for hardware and silently got software is the exact failure D67 exists to
    // make loud.
    expect(got.decodeHwAccel).toBeNull()
    expect(got.camStreamId).not.toBeNull()
    expect(h.sink.packets).toHaveLength(1)
  })

  it('retries the SAME decode when the INPUT was not there — the GPU was never asked', async () => {
    // Measured on device 106 (2026-09-13): the first child died on
    // `Error opening input` against a lazy publisher that had not woken yet —
    // and the first spawn IS what wakes it. Falling back to software cured
    // nothing and cost every Alexa session on that camera its hardware decode.
    const h = pushHarness({ inputRetryDelayMs: 0 })
    const acquire = h.manager.acquire(request({ publishLocally: true }))

    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    expect(h.readers[0]!.args).toContain('-hwaccel')
    h.readers[0]!.callbacks.onError?.(
      new Error(
        'egress push exited (code=183): [in#0] Error opening input: Invalid data found when processing input',
      ),
    )

    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    // The retry keeps the HARDWARE decode. This is the whole point.
    expect(h.readers[1]!.args).toContain('-hwaccel')
    h.readers[1]!.callbacks.onEncodedPacket(PACKET)

    const got = await acquire
    expect(got.decodeHwAccel).toBe('vaapi')
    expect(h.sink.packets).toHaveLength(1)
  })

  it('falls to SOFTWARE when the input is still not there on the retry', async () => {
    // One retry, not a loop: a second failure is a source that is genuinely
    // absent, and the software fallback is the honest last word.
    const h = pushHarness({ inputRetryDelayMs: 0 })
    const acquire = h.manager.acquire(request({ publishLocally: true }))
    const inputGone = new Error('egress push exited (code=183): Error opening input')

    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onError?.(inputGone)
    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    h.readers[1]!.callbacks.onError?.(inputGone)

    await vi.waitFor(() => expect(h.readers).toHaveLength(3))
    expect(h.readers[2]!.args).not.toContain('-hwaccel')
    h.readers[2]!.callbacks.onEncodedPacket(PACKET)

    const got = await acquire
    expect(got.decodeHwAccel).toBeNull()
  })

  it('a BACKEND failure is not retried on the same decode — it goes straight to software', async () => {
    // `Device creation failed` IS the decoder's fault. Re-dialling the same
    // backend would just pay the same death twice.
    const h = pushHarness({ inputRetryDelayMs: 0 })
    const acquire = h.manager.acquire(request({ publishLocally: true }))

    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onError?.(
      new Error('egress push exited (code=244): Device creation failed: -12'),
    )
    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    expect(h.readers[1]!.args).not.toContain('-hwaccel')
    h.readers[1]!.callbacks.onEncodedPacket(PACKET)
    await acquire
  })

  it('announces the software fallback at warn, tagged with the device', async () => {
    const h = pushHarness()
    const acquire = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onError?.(new Error('Device creation failed: -12'))
    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    h.readers[1]!.callbacks.onEncodedPacket(PACKET)
    await acquire

    const warn = vi.mocked(h.log.warn).mock.calls.find((c) => /software/i.test(String(c[0])))
    expect(warn).toBeDefined()
    const warnPayload = warn?.[1] as { tags?: Record<string, unknown> } | undefined
    expect(warnPayload?.tags).toMatchObject({ deviceId: 101 })
  })

  it('fails the acquire when the SOFTWARE attempt dies too — never a silent corpse', async () => {
    const h = pushHarness()
    const acquire = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onError?.(new Error('Device creation failed: -12'))
    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    h.readers[1]!.callbacks.onError?.(new Error('Invalid data found when processing input'))

    await expect(acquire).rejects.toThrow(/Invalid data/)
  })

  it('does NOT mint a restreamer channel for a push child', async () => {
    // The channel's url was returned and never fed — `sink.push` was the only
    // consumer of the demuxed packets. After the sharing key learned about the
    // transport, no dial consumer can reach a push child at all, so the
    // restreamer was a registered listen-server object serving nobody.
    const h = pushHarness()
    const acquire = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onEncodedPacket(PACKET)
    const got = await acquire

    expect(h.channelsAcquired).toBe(0)
    expect(got.url).not.toMatch(/^rtsp:/)
    expect(got.url).toContain(String(got.camStreamId))
  })

  it('carries AUDIO in-band as AAC, and says so when the request named another codec', async () => {
    // Opus is MPEG-TS `stream_type 0x06` and the demuxer maps only 0x0f (aac),
    // 0x03/0x04 (mp2) and 0x81 (ac3) — an in-band Opus frame dies at the
    // demuxer. AAC reaches the broker's own audio plane, which decodes it and
    // re-encodes whatever the session negotiated (Opus, for both Alexa and the
    // browser). The sidecar is a DIAL-path mechanism: its SDP graft only means
    // something to a consumer that dials the restreamer.
    const h = pushHarness()
    const acquire = h.manager.acquire(
      request({
        publishLocally: true,
        encode: {
          video: { codec: 'h264', width: 1280, height: 720 },
          audio: { codec: 'opus', bitrateKbps: 64 },
        },
      }),
    )
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    const args = h.readers[0]!.args
    expect(args).not.toContain('-an')
    expect(args.join(' ')).toContain('-c:a aac')
    h.readers[0]!.callbacks.onEncodedPacket(PACKET)
    await acquire

    const info = vi.mocked(h.log.info).mock.calls.find((c) => /in-band/i.test(String(c[0])))
    expect(info).toBeDefined()
    const infoPayload = info?.[1] as { tags?: Record<string, unknown> } | undefined
    expect(infoPayload?.tags).toMatchObject({ deviceId: 101 })
  })

  it('leaves the audio plane OFF for a passthrough request', async () => {
    const h = pushHarness()
    const acquire = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    expect(h.readers[0]!.args).toContain('-an')
    h.readers[0]!.callbacks.onEncodedPacket(PACKET)
    await acquire
  })

  it('forwards the demuxed audio info to the published stream', async () => {
    const h = pushHarness()
    const acquire = h.manager.acquire(
      request({
        publishLocally: true,
        encode: {
          video: { codec: 'h264', width: 1280, height: 720 },
          audio: { codec: 'aac' },
        },
      }),
    )
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onEncodedPacket(PACKET)
    await acquire
    h.readers[0]!.callbacks.onAudioInfo({
      codec: 'aac',
      sampleRate: 48000,
      channels: 1,
    })
    expect(h.sink.audioInfos).toHaveLength(1)
  })

  it('REMOVES the entry when a started child dies — the next acquire spawns fresh', async () => {
    // Nothing used to un-register a dead child, so every later acquire shared a
    // corpse until the refcount drained: one bad spawn made the camera dark for
    // every session that followed.
    const h = pushHarness()
    const first = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onEncodedPacket(PACKET)
    await first

    // Dead AFTER going live — the retry window is closed, this is a corpse.
    h.readers[0]!.callbacks.onError?.(new Error('egress push exited (code=8)'))

    const second = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    h.readers[1]!.callbacks.onEncodedPacket(PACKET)
    await second
  })

  it('does not treat the hardware→software retry as a death', async () => {
    // The retry rides the same failure callback the liveness removal listens
    // to. A healthy software child must not be evicted by the hardware attempt
    // that preceded it.
    const h = pushHarness()
    const acquire = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onError?.(new Error('Device creation failed: -12'))
    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    h.readers[1]!.callbacks.onEncodedPacket(PACKET)
    const a = await acquire

    const b = await h.manager.acquire(request({ publishLocally: true }))
    expect(b.pipelineKey).toBe(a.pipelineKey)
    expect(h.readers).toHaveLength(2)
  })

  it('COPIES a source that already satisfies the request, and reports it honestly', async () => {
    // The operator's ask: h264 requested on an h264 source with nothing else to
    // satisfy is a passthrough, not a re-encode. `forceReencode: true` used to
    // be unconditional, so this stream paid an encoder for nothing.
    const h = pushHarness({
      cameraStreamLookup: () => [
        { ...STREAM, codec: 'h264', resolution: { width: 1280, height: 720 } },
      ],
    })
    const acquire = h.manager.acquire(
      request({
        publishLocally: true,
        encode: { video: { codec: 'h264' }, audio: 'passthrough' },
      }),
    )
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    expect(h.readers[0]!.args.join(' ')).toContain('-c:v copy')
    h.readers[0]!.callbacks.onEncodedPacket(PACKET)
    const got = await acquire

    expect(got.encoder).toBe('copy')
    // `transcoded` and the geometry describe what the CONSUMER receives — a
    // copy delivers the source's own frames, so reporting the request's
    // numbers would be a resolution nothing produced.
    expect(got.transcoded).toBe(false)
    expect(got.resolution).toEqual({ width: 1280, height: 720 })
  })

  it('keeps the bitstream filter on the COPY branch', async () => {
    // `dump_extra` exists precisely to re-inline the parameter sets a remux
    // leaves in extradata — the copy branch's whole problem. A copy that drops
    // it is the SPS/PPS-only-in-SDP defect that kept HomeKit black.
    const h = pushHarness({
      cameraStreamLookup: () => [
        { ...STREAM, codec: 'h264', resolution: { width: 1280, height: 720 } },
      ],
    })
    const acquire = h.manager.acquire(
      request({
        publishLocally: true,
        bitstreamFilter: 'dump_extra',
        encode: { video: { codec: 'h264' }, audio: 'passthrough' },
      }),
    )
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    const argv = h.readers[0]!.args.join(' ')
    expect(argv).toContain('-c:v copy')
    expect(argv).toContain('-bsf:v dump_extra')
    h.readers[0]!.callbacks.onEncodedPacket(PACKET)
    await acquire
  })

  it('still ENCODES the same source once the request names a constraint nobody measured', async () => {
    // Alexa's request. `profile`, `level` and `bitrateKbps` are not carried by
    // any CameraStream, so they can never be proven satisfied — which is the
    // right answer, not a gap: a 4K main stream does not happen to be Baseline
    // 3.1 at 2500 kbps.
    const h = pushHarness({
      cameraStreamLookup: () => [
        { ...STREAM, codec: 'h264', resolution: { width: 1280, height: 720 } },
      ],
    })
    const acquire = h.manager.acquire(
      request({
        publishLocally: true,
        encode: {
          video: {
            codec: 'h264',
            profile: 'baseline',
            level: '3.1',
            bitrateKbps: 2500,
          },
          audio: 'passthrough',
        },
      }),
    )
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    expect(h.readers[0]!.args.join(' ')).toContain('-c:v libx264')
    h.readers[0]!.callbacks.onEncodedPacket(PACKET)
    const got = await acquire
    expect(got.transcoded).toBe(true)
  })

  it('IGNORES a late failure from the child the retry replaced', async () => {
    // The hardware attempt reporting after the software one went live must not
    // evict a healthy entry. `destroy()` normally silences the superseded
    // reader first — "normally" is not a property to bet an Echo session on,
    // and the liveness removal is precisely the machinery that turns a stale
    // callback into a dead camera.
    const h = pushHarness()
    const acquire = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onError?.(new Error('Device creation failed: -12'))
    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    h.readers[1]!.callbacks.onEncodedPacket(PACKET)
    const a = await acquire

    // The corpse speaks again, after the replacement is live.
    h.readers[0]!.callbacks.onError?.(new Error('egress push exited (code=244)'))

    const b = await h.manager.acquire(request({ publishLocally: true }))
    expect(b.pipelineKey).toBe(a.pipelineKey)
    expect(h.readers).toHaveLength(2)
  })

  it('tells the broker to forget a decode backend that failed to create a device', async () => {
    // The manager's hwaccel memo answers `vaapi` for 60s. Without this, every
    // child in that window pays the two-second death before its retry.
    const failed: string[] = []
    const h = pushHarness({
      onDecodeHwAccelFailed: (backend) => failed.push(backend),
    })
    const acquire = h.manager.acquire(request({ publishLocally: true }))
    await vi.waitFor(() => expect(h.readers).toHaveLength(1))
    h.readers[0]!.callbacks.onError?.(new Error('Device creation failed: -12'))
    await vi.waitFor(() => expect(h.readers).toHaveLength(2))
    h.readers[1]!.callbacks.onEncodedPacket(PACKET)
    await acquire
    expect(failed).toEqual(['vaapi'])
  })
})

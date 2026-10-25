/**
 * The delegate contract.
 *
 * Driven against a REAL `Fmp4FragmentPlane`, not a fake generator: the two
 * behaviours worth testing — `isLast` and the close-not-gap policy — are
 * properties of the plane, and a fake would only prove the delegate agrees with
 * whoever wrote the fake. That is the exact shape of the pre-seeding fake this
 * repo has already been bitten by twice.
 *
 * The failure every test here exists to prevent is D50's: a generator that
 * returns without ever setting `RecordingPacket.isLast`, which hap-nodejs
 * answers with a ~12 s timeout on every request, forever.
 */

import type { IScopedLogger } from '@camstack/types'
import type { Fmp4Subscription } from '@camstack/types/node'
import { Fmp4FragmentPlane } from '@camstack/types/node'
import type { CameraRecordingConfiguration } from '@homebridge/hap-nodejs'
import { HDSProtocolError } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import type { HapControllerCensus } from '../controller-census.js'
import type { ClipTee, ClipTeeFactory } from '../recording-delegate.js'
import { HksvRecordingDelegate, type RecordingFragmentSource } from '../recording-delegate.js'

const DEVICE_ID = 101

interface LogLine {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
}

interface LogPayload {
  readonly meta?: Record<string, unknown>
}

function logger(sink: LogLine[] = []): IScopedLogger {
  const record =
    (level: LogLine['level']) =>
    (message: string, payload?: LogPayload): void => {
      sink.push({ level, message, meta: payload?.meta ?? {} })
    }
  const log = {
    debug: () => {},
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    child: () => log,
    withTags: () => log,
  }
  // Documented type boundary: `IScopedLogger` is the kernel's full injected
  // surface; a delegate only ever calls these six.
  return log as unknown as IScopedLogger
}

/** A source backed by a real plane the test drives directly. */
class TestSource implements RecordingFragmentSource {
  readonly plane: Fmp4FragmentPlane
  running = true
  audioActive: boolean
  stops: string[] = []
  starts = 0

  constructor(audioActive = true, prebuffer = { windowMs: 8_000, maxBytes: 1_000_000 }) {
    this.audioActive = audioActive
    this.plane = new Fmp4FragmentPlane(undefined, prebuffer)
  }

  get isRunning(): boolean {
    return this.running
  }
  async start(): Promise<void> {
    this.starts += 1
    this.running = true
  }
  async stop(reason: string): Promise<void> {
    this.stops.push(reason)
    this.running = false
    this.plane.dispose()
  }
  async setAudioActive(active: boolean): Promise<void> {
    this.audioActive = active
  }
  readonly subscribeTags: string[] = []
  subscribe(tag: string, queueCapacity?: number): Fmp4Subscription | null {
    if (!this.running) return null
    this.subscribeTags.push(tag)
    return this.plane.subscribe({ tag, withPrebuffer: true, queueCapacity })
  }
  prebufferSpanMs(): number {
    return this.plane.prebufferStats().spanMs
  }
}

function configuration(fragmentLength = 4_000): CameraRecordingConfiguration {
  // Only the fields the delegate reads. A full TLV-shaped fixture would assert
  // nothing extra and would rot against hap-nodejs' enums.
  const cfg = {
    prebufferLength: 4_000,
    eventTriggerTypes: [1],
    mediaContainerConfiguration: { type: 0, fragmentLength },
    videoCodec: { type: 0, parameters: {}, resolution: [1280, 720, 10] },
    audioCodec: { type: 0, bitrate: 32, samplerate: 2 },
  }
  return cfg as unknown as CameraRecordingConfiguration
}

/** A home with one admin controller connected — the healthy case. */
const ADMIN_CONNECTED: HapControllerCensus = {
  serverPublished: true,
  connections: 1,
  adminConnections: 1,
  nonAdminConnections: 0,
  unverifiedConnections: 0,
  pairedControllers: 2,
  pairedAdmins: 1,
}

interface Harness {
  readonly delegate: HksvRecordingDelegate
  readonly sources: TestSource[]
  readonly logs: LogLine[]
  audioActive: boolean
}

function harness(
  advertisedFragmentMs = 4_000,
  census: HapControllerCensus = ADMIN_CONNECTED,
  now: () => number = Date.now,
  openClipTee?: ClipTeeFactory,
): Harness {
  const sources: TestSource[] = []
  const state = { audioActive: true }
  const logs: LogLine[] = []
  const delegate = new HksvRecordingDelegate({
    logger: logger(logs),
    deviceId: DEVICE_ID,
    advertisedFragmentMs,
    now,
    describeControllers: () => census,
    isAudioActive: () => state.audioActive,
    ...(openClipTee === undefined ? {} : { openClipTee }),
    // The fake takes what production PASSES it. A fake that ignored
    // `audioActive` and defaulted to `true` made this suite green while the
    // delegate could have dropped the value entirely — the same shape as the
    // pre-seeding fake recorded in the private session log.
    createSource: ({ audioActive }) => {
      const source = new TestSource(audioActive)
      sources.push(source)
      return source
    },
  })
  return {
    delegate,
    sources,
    logs,
    get audioActive() {
      return state.audioActive
    },
    set audioActive(v: boolean) {
      state.audioActive = v
    },
  }
}

/** Enable recording the way hap-nodejs does: configuration, then active. */
async function enable(h: Harness, fragmentLength = 4_000): Promise<TestSource> {
  h.delegate.updateRecordingConfiguration(configuration(fragmentLength))
  h.delegate.updateRecordingActive(true)
  await Promise.resolve()
  await Promise.resolve()
  const source = h.sources[0]
  if (source === undefined) throw new Error('no source was created')
  return source
}

function unit(
  kind: 'init' | 'fragment',
  sequence: number,
): {
  kind: 'init' | 'fragment'
  sequence: number
  data: Uint8Array
} {
  return { kind, sequence, data: new Uint8Array([sequence]) }
}

describe('HksvRecordingDelegate — the prebuffer lifecycle', () => {
  it('starts the prebuffer only when BOTH active and a configuration are present', async () => {
    const h = harness()
    h.delegate.updateRecordingActive(true)
    await Promise.resolve()
    // Active alone starts nothing: hap-nodejs explicitly does NOT guarantee a
    // configuration exists when active flips on.
    expect(h.sources).toHaveLength(0)

    h.delegate.updateRecordingConfiguration(configuration())
    await Promise.resolve()
    await Promise.resolve()
    expect(h.sources).toHaveLength(1)
    expect(h.delegate.prebufferRunning).toBe(true)
  })

  it('stops the prebuffer when iOS turns recording off — no permanent ffmpeg for nothing', async () => {
    const h = harness()
    const source = await enable(h)
    h.delegate.updateRecordingActive(false)
    await Promise.resolve()
    await Promise.resolve()
    expect(source.stops).toHaveLength(1)
    expect(h.delegate.prebufferRunning).toBe(false)
  })

  it('stops the prebuffer when the selected configuration is CLEARED', async () => {
    // A factory reset. HAP: disable the pipeline even if recording is active.
    const h = harness()
    const source = await enable(h)
    h.delegate.updateRecordingConfiguration(undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(source.stops).toHaveLength(1)
  })

  it('pushes RecordingAudioActive down to the source on every reconcile', async () => {
    const h = harness()
    await enable(h)
    h.audioActive = false
    h.delegate.updateRecordingActive(false)
    h.delegate.updateRecordingActive(true)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    // A fragment carrying audio when iOS asked for none violates HAP, and there
    // is no second plane to strip it on.
    expect(h.sources.at(-1)?.audioActive).toBe(false)
  })
})

describe('HksvRecordingDelegate — recording on with no configuration', () => {
  const NO_ADMIN_CONNECTED: HapControllerCensus = {
    serverPublished: true,
    connections: 1,
    adminConnections: 0,
    nonAdminConnections: 1,
    unverifiedConnections: 0,
    pairedControllers: 2,
    pairedAdmins: 1,
  }

  const WARNING =
    'hksv: recording is ON but NO connected controller holds admin — the recording configuration can never arrive'

  it('says so when the only connected controller cannot write the configuration', () => {
    // `SelectedCameraRecordingConfiguration` is `adminOnlyAccess: [WRITE]`, so a
    // non-admin home hub is refused with INSUFFICIENT_PRIVILEGES inside
    // hap-nodejs — no characteristic warning, nothing above `debug`. Camera 101
    // sat like this from 2026-08-07 22:34 with `Active` true, no configuration
    // and not one line naming a cause.
    const h = harness(4_000, NO_ADMIN_CONNECTED)
    h.delegate.updateRecordingActive(true)
    expect(h.logs.filter((l) => l.level === 'warn' && l.message === WARNING)).toHaveLength(1)
  })

  it('stays quiet while an admin IS connected — the hub simply has not written yet', () => {
    // Active-before-configuration is the normal first half of the handshake.
    const h = harness()
    h.delegate.updateRecordingActive(true)
    expect(h.logs.some((l) => l.message === WARNING)).toBe(false)
  })

  it('stays quiet once the configuration has arrived', () => {
    const h = harness(4_000, NO_ADMIN_CONNECTED)
    h.delegate.updateRecordingConfiguration(configuration())
    h.delegate.updateRecordingActive(true)
    expect(h.logs.some((l) => l.message === WARNING)).toBe(false)
  })
})

describe('HksvRecordingDelegate — handleRecordingStreamRequest', () => {
  it('yields the init packet first, then fragments, and marks exactly ONE isLast', async () => {
    const h = harness()
    const source = await enable(h)
    source.plane.publish(unit('init', 0))
    source.plane.publish(unit('fragment', 1))

    const packets: { size: number; isLast: boolean }[] = []
    const pump = (async () => {
      for await (const p of h.delegate.handleRecordingStreamRequest(7)) {
        packets.push({ size: p.data.length, isLast: p.isLast })
      }
    })()
    source.plane.publish(unit('fragment', 2))
    source.plane.end()
    await pump

    expect(packets).toHaveLength(3)
    expect(packets.filter((p) => p.isLast)).toHaveLength(1)
    expect(packets.at(-1)?.isLast).toBe(true)
  })

  it('serves the PREBUFFER — the fragments from before the trigger', async () => {
    const h = harness()
    const source = await enable(h)
    source.plane.publish(unit('init', 0))
    source.plane.publish(unit('fragment', 1))
    source.plane.publish(unit('fragment', 2))
    // The trigger happens HERE. Without a prebuffer the clip would start now.

    const sizes: number[] = []
    const pump = (async () => {
      for await (const p of h.delegate.handleRecordingStreamRequest(7)) sizes.push(p.data[0] ?? -1)
    })()
    source.plane.publish(unit('fragment', 3))
    source.plane.end()
    await pump

    expect(sizes).toEqual([0, 1, 2, 3])
  })

  it('measures the fragment cadence BETWEEN fragments — never from the subscribe', async () => {
    // The overrun warning is D84's only detector for "the camera GOP is longer
    // than we advertised", and the operator's remedy for it is a camera-side
    // change. It MUST NOT fire on a cold start: the fragment child spawns,
    // connects RTSP and waits for a key frame before the first fragment exists,
    // and seeding the gap counter with the subscribe time charges all of that
    // to the first fragment. Live on camera 101 at 2026-08-08 12:11 that read
    // `longestFragmentGapMs=6073` against a perfectly regular 4 s cadence.
    const clock = { t: 0 }
    const h = harness(4_000, ADMIN_CONNECTED, () => clock.t)
    const source = await enable(h)
    source.plane.publish(unit('init', 0))
    source.plane.publish(unit('fragment', 1))
    source.plane.publish(unit('fragment', 2))
    source.plane.publish(unit('fragment', 3))

    let seen = 0
    const pump = (async () => {
      for await (const _ of h.delegate.handleRecordingStreamRequest(7)) {
        seen += 1
        // 6 s for the child to produce anything, then a metronomic 4 s.
        clock.t += seen === 1 ? 6_000 : 4_000
      }
    })()
    source.plane.end()
    await pump

    const finished = h.logs.find((l) => l.message === 'hksv: recording stream finished')
    expect(finished?.meta['longestFragmentGapMs']).toBe(4_000)
    // The startup latency is not thrown away — it is its own number.
    expect(finished?.meta['msToFirstFragmentMs']).toBe(6_000)
    expect(
      h.logs.some((l) => l.message === 'hksv: fragments arrived LONGER than the advertised length'),
    ).toBe(false)
  })

  it('still reports an overrun when the fragments THEMSELVES are too long', async () => {
    const clock = { t: 0 }
    const h = harness(4_000, ADMIN_CONNECTED, () => clock.t)
    const source = await enable(h)
    source.plane.publish(unit('init', 0))
    source.plane.publish(unit('fragment', 1))
    source.plane.publish(unit('fragment', 2))

    let seen = 0
    const pump = (async () => {
      for await (const _ of h.delegate.handleRecordingStreamRequest(7)) {
        seen += 1
        clock.t += seen === 1 ? 1_000 : 8_000
      }
    })()
    source.plane.end()
    await pump

    expect(
      h.logs.some((l) => l.message === 'hksv: fragments arrived LONGER than the advertised length'),
    ).toBe(true)
  })

  it('REFUSES rather than yielding nothing when there is no prebuffer', async () => {
    // The D50 failure exactly: a generator that returns without `isLast` puts
    // the controller into a ~12 s timeout on every request, all day.
    const h = harness()
    await expect(async () => {
      for await (const _ of h.delegate.handleRecordingStreamRequest(7)) {
        /* unreachable */
      }
    }).rejects.toBeInstanceOf(HDSProtocolError)
  })

  it('REFUSES when the source is running but the plane hands back nothing', async () => {
    const h = harness()
    const source = await enable(h)
    source.plane.dispose()
    // A disposed plane returns an already-ended subscription that delivers zero
    // packets — indistinguishable, from the delegate, from a dead camera.
    await expect(async () => {
      for await (const _ of h.delegate.handleRecordingStreamRequest(7)) {
        /* may yield nothing */
      }
    }).rejects.toBeInstanceOf(HDSProtocolError)
  })

  it('marks a TRUNCATED clip last rather than returning unmarked', async () => {
    // The plane closes a slow consumer instead of gapping it (D80): a gapped
    // fMP4 is corrupt, not short. iOS must get a playable short clip, and above
    // all it must not get a stream that never ends.
    const h = harness()
    const source = await enable(h)
    source.plane.publish(unit('init', 0))

    const packets: { isLast: boolean }[] = []
    const started = { resolve: (): void => {} }
    const gate = new Promise<void>((r) => {
      started.resolve = r
    })
    const pump = (async () => {
      for await (const p of h.delegate.handleRecordingStreamRequest(7)) {
        packets.push({ isLast: p.isLast })
        started.resolve()
        // Never drains: the next publishes overflow the queue.
        await gate
        await new Promise((r) => setTimeout(r, 5))
      }
    })()
    await gate
    for (let i = 1; i <= 12; i++) source.plane.publish(unit('fragment', i))
    await pump

    expect(packets.filter((p) => p.isLast)).toHaveLength(1)
    expect(packets.at(-1)?.isLast).toBe(true)
  })

  it('returns without yielding when the stream is aborted', async () => {
    const h = harness()
    const source = await enable(h)
    source.plane.publish(unit('init', 0))
    const controller = new AbortController()
    controller.abort()

    const packets: unknown[] = []
    for await (const p of h.delegate.handleRecordingStreamRequest(7, controller.signal)) {
      packets.push(p)
    }
    expect(packets).toHaveLength(0)
  })

  it('closeRecordingStream ends the running generator', async () => {
    const h = harness()
    const source = await enable(h)
    source.plane.publish(unit('init', 0))

    const packets: unknown[] = []
    const first = { resolve: (): void => {} }
    const gate = new Promise<void>((r) => {
      first.resolve = r
    })
    const pump = (async () => {
      for await (const p of h.delegate.handleRecordingStreamRequest(7)) {
        packets.push(p)
        first.resolve()
      }
    })()
    await gate
    // NORMAL — iOS deciding it has enough. HAP: the generator must return
    // WITHOUT yielding anything further, so not even the end-of-stream marker.
    h.delegate.closeRecordingStream(7, 0)
    await pump
    expect(packets).toHaveLength(1)
  })
})

describe('HksvRecordingDelegate — dispose', () => {
  it('stops the prebuffer when the accessory goes away', async () => {
    const h = harness()
    const source = await enable(h)
    await h.delegate.dispose()
    expect(source.stops).toEqual(['accessory disposed'])
  })
})

/**
 * The tee, from the delegate's side.
 *
 * The property these pin is the one that outranks the feature: this plane is
 * serving the operator's real home RIGHT NOW, so a clip tee that cannot be
 * built, or blows up while being built, must leave the HKSV stream exactly as
 * it was. The byte-for-byte version of that claim lives in
 * `clip-writer.spec.ts`, against a real plane; what is asserted here is that
 * the delegate never lets the tee near its own subscription or its own
 * failure path.
 */
describe('HksvRecordingDelegate — the clip tee', () => {
  interface TeeCall {
    readonly streamId: number
    readonly tag: string
    finished: number
    acknowledged: number
  }

  function recordingTee(calls: TeeCall[], throws = false): ClipTeeFactory {
    return (request) => {
      if (throws) throw new Error('the clip store is on a full disk')
      const call: TeeCall = {
        streamId: request.streamId,
        tag: request.subscription.tag,
        finished: 0,
        acknowledged: 0,
      }
      calls.push(call)
      const tee: ClipTee = {
        finish: () => {
          call.finished += 1
        },
        acknowledge: () => {
          call.acknowledged += 1
        },
      }
      return tee
    }
  }

  async function streamOnce(h: Harness, source: TestSource): Promise<number> {
    source.plane.publish(unit('init', 0))
    let packets = 0
    const pump = (async () => {
      for await (const _ of h.delegate.handleRecordingStreamRequest(11)) packets += 1
    })()
    await Promise.resolve()
    source.plane.publish(unit('fragment', 1))
    source.plane.end('test')
    await pump
    return packets
  }

  it("opens a SECOND subscription for the tee — never the delegate's own", async () => {
    const calls: TeeCall[] = []
    const h = harness(4_000, ADMIN_CONNECTED, Date.now, recordingTee(calls))
    const source = await enable(h)
    const packets = await streamOnce(h, source)

    expect(packets).toBeGreaterThan(0)
    expect(source.subscribeTags).toHaveLength(2)
    expect(source.subscribeTags[0]).toMatch(/^hksv\//)
    expect(source.subscribeTags[1]).toMatch(/^clip\//)
    expect(calls[0]?.tag).toMatch(/^clip\//)
    // Ended with the stream, so the tee's file is closed and its subscription
    // released — a tee left open would fill and be closed as a slow consumer.
    expect(calls[0]?.finished).toBe(1)
  })

  it('records the clip as ACKNOWLEDGED when iOS says it landed', async () => {
    const calls: TeeCall[] = []
    const h = harness(4_000, ADMIN_CONNECTED, Date.now, recordingTee(calls))
    const source = await enable(h)
    await streamOnce(h, source)
    h.delegate.acknowledgeStream(11)
    expect(calls[0]?.acknowledged).toBe(1)
  })

  it('keeps recording when the tee factory THROWS — the failure is logged, not propagated', async () => {
    const control = harness()
    const controlSource = await enable(control)
    const controlPackets = await streamOnce(control, controlSource)

    const h = harness(4_000, ADMIN_CONNECTED, Date.now, recordingTee([], true))
    const source = await enable(h)
    const packets = await streamOnce(h, source)

    expect(packets).toBe(controlPackets)
    const warned = h.logs.find((l) => l.level === 'warn' && /clip tee/i.test(l.message))
    expect(warned).toBeDefined()
  })

  it('records nothing and changes nothing when no tee is wired', async () => {
    const h = harness()
    const source = await enable(h)
    const packets = await streamOnce(h, source)
    expect(packets).toBeGreaterThan(0)
    expect(source.subscribeTags).toHaveLength(1)
  })
})

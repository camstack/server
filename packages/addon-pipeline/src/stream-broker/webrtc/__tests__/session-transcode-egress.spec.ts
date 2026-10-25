/**
 * The session half of the migration: a transcoding session ACQUIRES its
 * encoded stream from the primitive and RELEASES it on teardown.
 *
 * The failure this guards is a leak, and it is the one boundary D67 says the
 * primitive cannot close for itself: "a holder that dies without releasing
 * leaks a child until the broker process restarts. There is no lease TTL, on
 * purpose." Every holder must release on its OWN failure paths — including the
 * one where the acquire raced the close.
 */
import { describe, expect, it } from 'vitest'
import type { EncodedPacket } from '@camstack/types'

import { AdaptiveSession } from '../session.js'
import { asLogger, type FrameSource, type MediaFrame } from '../types.js'
import type { TranscodeEgressLeg } from '../transcode-egress-leg.js'
import { WEBRTC_FALLBACK_PROFILE } from '../webrtc-fallback-profile.js'

/** Poll until `predicate` holds, or fail loudly rather than hang the runner. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

/**
 * A source that yields nothing and whose `return()` ENDS it — the session's
 * audio plane while nothing is speaking.
 *
 * Written by hand rather than as an `async function*` parked on a timer: the
 * feed loop holds a pending `next()`, an async generator queues `return()`
 * BEHIND it, and a generator that never yields therefore deadlocks `close()`.
 * That is a property of the fake, not of the session — the real source's
 * `return()` releases its queue and ends the loop, which is what this models.
 */
function idleSource(): FrameSource {
  let end: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
    end = resolve
  })
  async function* generator(): AsyncGenerator<MediaFrame, void, unknown> {
    await ended
    yield* []
  }
  const src = generator()
  return Object.assign(src, {
    return: async () => {
      end()
      return { value: undefined, done: true as const }
    },
  })
}

interface LegSpy {
  readonly leg: TranscodeEgressLeg
  readonly releases: number
  readonly detaches: number
  readonly attached: boolean
  emit(packet: EncodedPacket): void
}

function legSpy(): LegSpy {
  let releases = 0
  let detaches = 0
  let sink: ((packet: EncodedPacket) => void) | null = null
  const leg: TranscodeEgressLeg = {
    camStreamId: 'egress:101:abc',
    pipelineKey: 'egress:key-1',
    encoder: 'libx264',
    decodeHwAccel: 'vaapi',
    attachVideo: (onPacket) => {
      sink = onPacket
      return () => {
        detaches += 1
        sink = null
      }
    },
    release: async () => {
      releases += 1
    },
  }
  return {
    leg,
    get releases() {
      return releases
    },
    get detaches() {
      return detaches
    },
    get attached() {
      return sink !== null
    },
    emit: (packet) => sink?.(packet),
  }
}

interface Harness {
  readonly session: AdaptiveSession
  readonly spy: LegSpy
  readonly acquires: { profile: unknown; sessionId: string }[]
  readonly errors: string[]
  /** Let a held acquire resolve — models the child's first-packet wait. */
  finishAcquire(): void
}

function makeSession(
  over: { acquire?: boolean; acquireFails?: boolean; hold?: boolean } = {},
): Harness {
  const spy = legSpy()
  const acquires: { profile: unknown; sessionId: string }[] = []
  const errors: string[] = []
  const gates: Array<() => void> = []
  const logger = asLogger({
    error: (msg: string) => {
      errors.push(msg)
    },
  })
  const session = new AdaptiveSession({
    sessionId: 'session-a',
    deviceId: 101,
    source: idleSource(),
    // H.265 source on an H.264-negotiating browser — `needsTranscode` is true.
    sourceCodec: 'H265',
    transcodeProfile: WEBRTC_FALLBACK_PROFILE,
    logger,
    ...(over.acquire === false
      ? {}
      : {
          acquireTranscodeEgress: async (input) => {
            acquires.push({ profile: input.profile, sessionId: input.sessionId })
            if (over.acquireFails === true) throw new Error('no source dialed')
            if (over.hold === true) await new Promise<void>((resolve) => gates.push(resolve))
            return spy.leg
          },
        }),
  })
  return {
    session,
    spy,
    acquires,
    errors,
    finishAcquire: () => {
      for (const gate of gates.splice(0)) gate()
    },
  }
}

describe('AdaptiveSession transcode leg — acquired from the primitive', () => {
  it('acquires ONE egress with the session transcode profile', async () => {
    const { session, acquires, spy } = makeSession()
    session.startFeedingFrames()
    await until(() => spy.attached, 'the leg to attach')
    expect(acquires).toEqual([{ profile: WEBRTC_FALLBACK_PROFILE, sessionId: 'session-a' }])
    await session.close()
  })

  it('RELEASES the handle when the session closes — nothing else can', async () => {
    const { session, spy } = makeSession()
    session.startFeedingFrames()
    await until(() => spy.attached, 'the leg to attach')
    await session.close()
    expect(spy.releases).toBe(1)
    expect(spy.detaches).toBe(1)
  })

  it('releases exactly once even when close is called twice', async () => {
    const { session, spy } = makeSession()
    session.startFeedingFrames()
    await until(() => spy.attached, 'the leg to attach')
    await session.close()
    await session.close()
    expect(spy.releases).toBe(1)
  })

  it('releases a handle that landed AFTER the session already closed', async () => {
    // The acquire blocks until the child produces its first packet (8s + one
    // software retry). A viewer that gives up inside that window would
    // otherwise leak a child with no holder alive to release it.
    const { session, spy } = makeSession()
    session.startFeedingFrames()
    await session.close()
    await until(() => spy.releases === 1, 'the handle to be released')
    expect(spy.attached).toBe(false)
  })

  it('a failed acquire closes the session LOUDLY instead of showing black', async () => {
    const { session, errors } = makeSession({ acquireFails: true })
    session.startFeedingFrames()
    await until(() => errors.length > 0, 'a named error')
    expect(errors.join(' ').toLowerCase()).toContain('transcode')
  })

  it('says so when nothing wired the primitive, rather than feeding silence', async () => {
    const { session, errors } = makeSession({ acquire: false })
    session.startFeedingFrames()
    await until(() => errors.length > 0, 'a named error')
  })
})

/**
 * The child has to be SPAWNING while ICE and DTLS are still handshaking.
 *
 * `needsTranscode` is decided at the answer — the "Codec negotiated" line
 * carries it — but the acquire only started after the DTLS wait, so on camera
 * 101 the leg began ~2 s after the session was created and attached ~5 s after
 * that. A browser watchdog re-offers every ~5 s, so the viewer had already gone
 * by the time the media existed, and the next session started from a cold
 * child again: 3 minutes of that on 2026-08-07 22:17–22:20, converging only
 * when a child happened to stay warm.
 *
 * These are the gates. The attach can stay behind DTLS — it must — but the
 * ffmpeg cannot.
 */
describe('AdaptiveSession transcode leg — prewarmed at the answer', () => {
  it('ACQUIRES at the answer, before anything waits on ICE or DTLS', async () => {
    const h = makeSession({ hold: true })
    h.session.prewarmTranscodeEgress()

    await until(() => h.acquires.length === 1, 'the acquire to start at the answer')
    // Not attached: the media plane is still behind the DTLS wait, exactly as
    // before. Only the ffmpeg moved earlier.
    expect(h.spy.attached).toBe(false)

    await h.session.close()
    h.finishAcquire()
  })

  it('the feed ADOPTS the prewarmed handle instead of acquiring a second one', async () => {
    const h = makeSession({ hold: true })
    h.session.prewarmTranscodeEgress()
    await until(() => h.acquires.length === 1, 'the prewarm')

    h.session.startFeedingFrames()
    h.finishAcquire()
    await until(() => h.spy.attached, 'the leg to attach')

    // Two acquires would be two children on the manager's exact-match key —
    // the second one shares, but the first is a refcount nobody releases.
    expect(h.acquires).toHaveLength(1)
    await h.session.close()
    expect(h.spy.releases).toBe(1)
  })

  it('RELEASES a prewarm the session never consumed — the primitive has no TTL', async () => {
    // The whole point of the reproducer: the viewer gives up mid-acquire. With
    // the acquire moved BEFORE the DTLS wait, the window in which a session can
    // die holding an unattached child got wider, not narrower.
    const h = makeSession({ hold: true })
    h.session.prewarmTranscodeEgress()
    await until(() => h.acquires.length === 1, 'the prewarm')

    await h.session.close()
    h.finishAcquire()

    await until(() => h.spy.releases === 1, 'the orphaned prewarm to be released')
    expect(h.spy.attached).toBe(false)
  })

  it('prewarms ONCE however many times it is called', async () => {
    const h = makeSession({ hold: true })
    h.session.prewarmTranscodeEgress()
    h.session.prewarmTranscodeEgress()
    await until(() => h.acquires.length === 1, 'the prewarm')
    expect(h.acquires).toHaveLength(1)
    await h.session.close()
    h.finishAcquire()
  })

  it('does NOT prewarm a session that needs no transcode', async () => {
    // A passthrough session has no leg and must not spawn an ffmpeg for one.
    const spy = legSpy()
    const acquires: string[] = []
    const session = new AdaptiveSession({
      sessionId: 'session-b',
      deviceId: 101,
      source: idleSource(),
      sourceCodec: 'H264',
      transcodeProfile: WEBRTC_FALLBACK_PROFILE,
      logger: asLogger({}),
      acquireTranscodeEgress: async (input) => {
        acquires.push(input.sessionId)
        return spy.leg
      },
    })
    session.prewarmTranscodeEgress()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(acquires).toEqual([])
    await session.close()
  })
})

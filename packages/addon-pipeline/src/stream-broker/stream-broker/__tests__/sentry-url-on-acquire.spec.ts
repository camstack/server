/**
 * `getStreamWithCodec` reports the SENTRY counterpart of the url it hands out.
 *
 * A composite camera (`@camstack/system`'s `camera-grid` builtin) must compose a battery
 * source WITHOUT waking it, and the dial that does that is the sentry path. The
 * question "may this camera be dialled in sentry?" already has exactly one
 * authority in this repo — `sentryEligible`, asked by the broker, on facts the
 * broker can see (`sentry-eligibility.ts`). A consumer re-deriving it from cap
 * bindings would be a second authority, and the two would disagree the first
 * time a camera lost its `stream-signals` provider.
 *
 * So the broker ANSWERS it, on the acquisition: `sentryUrl` is the sentry dial
 * when this camera offers one and `null` when it does not. A consumer that
 * wants "live, or the picture if this one sleeps" needs no facts of its own —
 * it takes `sentryUrl ?? url`.
 *
 * Only the PASSTHROUGH branch can answer. A transcode hands back an egress the
 * broker itself is feeding; that egress has no sentry counterpart and claiming
 * one would be a url nothing serves.
 */
import type { CameraStream, CamProfile } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeScopedLogger } from '../../../__tests__/support/scoped-logger.js'
import { makeSpawnFn } from '../../../__tests__/support/spawn-fake-child.js'
import type { EgressChannel, RtspRestreamerLike } from '../transcode-egress.js'
import { TranscodePipelineManager } from '../transcode-pipeline.js'

class FakeRestreamer implements RtspRestreamerLike {
  pushPacket(): void {}
}

const STREAM: CameraStream = {
  deviceId: 106,
  camStreamId: 'native:main',
  kind: 'pull-rtsp',
  url: 'rtsp://camera.local/main',
  codec: 'h264',
  resolution: { width: 1920, height: 1080 },
}

interface Harness {
  readonly manager: TranscodePipelineManager
  readonly sentryOffered: ReturnType<typeof vi.fn>
}

function makeManager(offered: boolean): Harness {
  const sentryOffered = vi.fn(async (_deviceId: number) => offered)
  const spawnFn = makeSpawnFn({ spawnArgs: [] })
  const manager = new TranscodePipelineManager({
    logger: makeScopedLogger(),
    cameraStreamLookup: () => [STREAM],
    rtspEntryLookup: () => ({
      url: 'rtsp://127.0.0.1:8554/tok',
      mutedUrl: 'rtsp://127.0.0.1:8554/tok/muted',
    }),
    resolveProfileSource: (_deviceId: number, _profile: CamProfile) => 'native:main',
    sentryOffered,
    ffmpegConfig: () => ({ binaryPath: '/deps/ffmpeg-pinned', hwAccel: 'copy', threadCount: 0 }),
    spawnFn,
    releaseGraceMs: 0,
    acquireChannel: (): EgressChannel => ({
      restreamer: new FakeRestreamer(),
      consumerUrl: 'rtsp://127.0.0.1:8554/egress',
      release: () => {},
    }),
  })
  return { manager, sentryOffered }
}

describe('getStreamWithCodec — the sentry counterpart of the acquired url', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('offers the sentry dial for a camera the broker says is eligible', async () => {
    const { manager, sentryOffered } = makeManager(true)
    const source = await manager.acquire({
      deviceId: 106,
      video: 'copy',
      audio: 'none',
      profile: 'high',
    })
    expect(source.url).toBe('rtsp://127.0.0.1:8554/tok/muted')
    // Not "/muted/sentry": that parses back to the token `tok/muted`.
    expect(source.sentryUrl).toBe('rtsp://127.0.0.1:8554/tok/sentry')
    expect(sentryOffered).toHaveBeenCalledWith(106)
  })

  it('offers NOTHING for a camera the broker says is not eligible', async () => {
    const { manager } = makeManager(false)
    const source = await manager.acquire({
      deviceId: 106,
      video: 'copy',
      audio: 'none',
      profile: 'high',
    })
    // `null` and not the live url: a consumer must be able to tell "this camera
    // has no sentry" from "here is its sentry", and a silent substitution of
    // the live url is exactly the wake this whole field exists to avoid.
    expect(source.sentryUrl).toBeNull()
  })

  it('offers nothing when nobody wired the question — an unasked question is a NO', async () => {
    const spawnFn = makeSpawnFn({ spawnArgs: [] })
    const manager = new TranscodePipelineManager({
      logger: makeScopedLogger(),
      cameraStreamLookup: () => [STREAM],
      rtspEntryLookup: () => ({
        url: 'rtsp://127.0.0.1:8554/tok',
        mutedUrl: 'rtsp://127.0.0.1:8554/tok/muted',
      }),
      resolveProfileSource: () => 'native:main',
      ffmpegConfig: () => ({ binaryPath: '/deps/ffmpeg-pinned', hwAccel: 'copy', threadCount: 0 }),
      spawnFn,
      releaseGraceMs: 0,
      acquireChannel: (): EgressChannel => ({
        restreamer: new FakeRestreamer(),
        consumerUrl: 'rtsp://127.0.0.1:8554/egress',
        release: () => {},
      }),
    })
    const source = await manager.acquire({
      deviceId: 106,
      video: 'copy',
      audio: 'none',
      profile: 'high',
    })
    expect(source.sentryUrl).toBeNull()
  })

  it('a TRANSCODE reports no sentry — the broker is feeding that egress itself', async () => {
    const { manager } = makeManager(true)
    const source = await manager.acquire({
      deviceId: 106,
      video: 'h265',
      audio: 'aac',
      profile: 'high',
    })
    expect(source.transcoded).toBe(true)
    expect(source.sentryUrl).toBeNull()
  })
})

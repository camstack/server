/**
 * Device-scoped cap providers registered by the stream-broker addon.
 *
 *   - `CameraStreamsProvider` surfaces per-device published cam streams
 *     + profile slots, delegating to the broker manager's in-memory
 *     state. Reads only.
 *   - `WebrtcSessionProvider` resolves `{deviceId, profile}` to
 *     `${deviceId}/${profile}` (or `${deviceId}/adaptive`), picks the
 *     first webrtc collection provider that advertises support, and
 *     tracks `sessionId → provider` so `handleAnswer` / `closeSession`
 *     dispatch back to the right provider.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { CameraStreamsProvider, WebrtcSessionProvider } from '../device-scoped-providers.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { nodePin } from '@camstack/types'
import { WEBRTC_FALLBACK_PROFILE } from '../webrtc/webrtc-fallback-profile.js'
import type { IStreamBrokerWithSourceProvider } from '../webrtc/remote-encoded-source-broker.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

function stubRtsp(manager: StreamBrokerManager): void {
  ;(manager as unknown as { rtspProvider: unknown }).rtspProvider = {
    getEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    getInternalEntry: vi.fn((brokerId: string) => ({
      brokerId,
      url: `rtsp://host/${brokerId}`,
      mutedUrl: '',
      enabled: true,
    })),
    setEnabled: vi.fn(),
    isEnabled: vi.fn(() => true),
    setTokenPersister: vi.fn(),
    setEnabledPersister: vi.fn(),
    getAllEntries: vi.fn(() => []),
    regenerateToken: vi.fn(),
    getRtspPort: vi.fn(() => 8554),
    persistTokens: vi.fn(),
  }
  ;(manager as unknown as { rtspServer: unknown }).rtspServer = {
    registerRestreamer: vi.fn(),
    unregisterRestreamer: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getPort: vi.fn(() => 8554),
    loadEnabled: vi.fn(),
  }
}

/** A camera whose main stream the broker has bound to the `high` slot. */
async function publishBoundStream(manager: StreamBrokerManager): Promise<void> {
  await manager.publishCameraStream({
    deviceId: 104,
    camStreamId: 'native:main',
    kind: 'pull-rtsp',
    url: 'rtsp://main',
    codec: 'h264',
    resolution: { width: 3840, height: 2160 },
    fps: 25,
  })
}

describe('CameraStreamsProvider', () => {
  let manager: StreamBrokerManager
  let provider: CameraStreamsProvider

  beforeEach(() => {
    manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    provider = new CameraStreamsProvider(manager)
  })

  it("getCameraStreams returns the device's published registry in insertion order", async () => {
    await manager.publishCameraStream({
      deviceId: 1,
      camStreamId: 'first',
      kind: 'pull-rtsp',
      url: 'rtsp://1',
    })
    await manager.publishCameraStream({
      deviceId: 1,
      camStreamId: 'second',
      kind: 'pull-rtsp',
      url: 'rtsp://2',
    })
    const list = await provider.getCameraStreams({ deviceId: 1 })
    expect(list.map((s) => s.camStreamId)).toEqual(['first', 'second'])
  })

  it('getCameraStreams returns empty for an unknown device', async () => {
    const list = await provider.getCameraStreams({ deviceId: 999 })
    expect(list).toEqual([])
  })

  it('getBrokerStreams returns all 3 profile slots once something is published', async () => {
    await manager.publishCameraStream({
      deviceId: 2,
      camStreamId: 'only',
      kind: 'pull-rtsp',
      url: 'rtsp://a',
    })
    const slots = await provider.getBrokerStreams({ deviceId: 2 })
    expect(slots).toHaveLength(3)
    expect(slots.map((s) => s.profile).toSorted()).toEqual(['high', 'low', 'mid'])
    expect(slots.find((s) => s.profile === 'mid')!.sourceCamStreamId).toBe('only')
    expect(slots.find((s) => s.profile === 'high')!.sourceCamStreamId).toBeNull()
  })

  it('getBrokerStreams returns empty for a device with no assignments', async () => {
    const slots = await provider.getBrokerStreams({ deviceId: 3 })
    expect(slots).toEqual([])
  })

  /**
   * The co-tenant hazard D67 exists to end, through a door nobody closed.
   * Alexa's SECOND session on 587 was logged "bypassing transcode via
   * cameraStreams.pickStream {selectedCamStreamId=egress:08e7…}": it attached
   * to ANOTHER consumer's private egress, holding no refcount on it, so the
   * first holder's release would have pulled the stream out from under it.
   * `excludeDerived` filters on the `derived:` prefix and knew nothing about
   * the egress. A private egress is never selectable — no flag makes it so.
   */
  it('pickStream never selects a private egress publication', async () => {
    await manager.publishCameraStream({
      deviceId: 112,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://main',
      codec: 'h265',
      resolution: { width: 2560, height: 1440 },
    })
    await manager.publishCameraStream({
      deviceId: 112,
      camStreamId: 'egress:abc123',
      kind: 'push-annexb',
      codec: 'h264',
      resolution: { width: 1280, height: 720 },
      autoEligible: false,
      label: 'egress',
    })

    const picked = await provider.pickStream({
      deviceId: 112,
      requirements: {
        acceptCodecs: ['h264'],
        minHeight: 480,
        excludeDerived: true,
        requireSiblingCodec: ['h265', 'hevc'],
      },
    })

    expect(picked).toBeNull()
  })

  /**
   * What a consumer needs to ACT, answered in one place.
   *
   * An exporter may never open the camera's own URL — the broker dials the
   * camera and everyone else dials the broker's restream. So a picker that
   * answers with a `camStreamId` alone has named a source nobody can use, and
   * every consumer has to translate it back to a profile slot and a URL.
   * Alexa wrote `profileForCamStream` for exactly that; HomeKit was about to
   * write it a second time.
   */
  it('answers with the profile, broker id and dialable url of the stream it picked', async () => {
    await publishBoundStream(manager)

    const picked = await provider.pickStream({
      deviceId: 104,
      requirements: { acceptCodecs: ['h264'] },
    })

    expect(picked?.camStreamId).toBe('native:main')
    // WHICH slot the broker chose is its business and not this test's point —
    // what matters is that the answer names the slot the stream is really
    // bound to, so a consumer can dial it without a second lookup.
    const slot = manager
      .getProfileSlotsForDevice(104)
      .find((x) => x.sourceCamStreamId === 'native:main')
    expect(slot, 'the broker bound no slot, so there is nothing to assert about').toBeDefined()
    expect(picked?.profile).toBe(slot?.profile)
    expect(picked?.brokerId).toBe(slot?.brokerId)
    // The invariant is WHOSE url it is, not what the host happens to be in a
    // test: an exporter must dial the broker's restream and never the camera's
    // own address, which here is `rtsp://main`.
    expect(picked?.url).toBeDefined()
    expect(picked?.url, 'the url is the camera’s own — an exporter must never open that').not.toBe(
      'rtsp://main',
    )
    expect(picked?.url).toContain(String(slot?.profile))
  })

  /**
   * The frame rate travels WITH its provenance.
   *
   * Getting it wrong is expensive and silent: a HomeKit accessory advertised
   * 720p at 24 fps while the slot serving it ran at 9, and the controller
   * rendered nothing. `published` is what the publisher declares; a measured
   * rate is a different statement and the two must stay distinguishable.
   */
  it('answers with the delivered fps and says where the number came from', async () => {
    await publishBoundStream(manager)

    const picked = await provider.pickStream({
      deviceId: 104,
      requirements: { acceptCodecs: ['h264'] },
    })

    expect(picked?.fps).toBe(25)
    expect(picked?.fpsSource).toBe('published')
  })

  /**
   * `requireProfileBound` — the operator's rule: the picker must never name a
   * stream a consumer cannot dial.
   */
  /**
   * `requireProfileBound` — the operator's rule: the picker must never name a
   * stream a consumer cannot dial.
   *
   * The real shape of this is a camera publishing MORE streams than the broker
   * has slots. Three slots exist; a fourth source is perfectly selectable and
   * perfectly undialable, because no restream serves it.
   */
  it('offers only streams bound to a slot when the caller requires it', async () => {
    for (const [id, height] of [
      ['native:main', 2160],
      ['native:slot-3', 720],
      ['native:sub', 360],
      ['native:extra', 480],
    ] as const) {
      await manager.publishCameraStream({
        deviceId: 107,
        camStreamId: id,
        kind: 'pull-rtsp',
        url: `rtsp://${id}`,
        codec: 'h264',
        resolution: { width: Math.round((height * 16) / 9), height },
        fps: 25,
      })
    }

    const boundIds = new Set(
      manager
        .getProfileSlotsForDevice(107)
        .map((x) => x.sourceCamStreamId)
        .filter((x): x is string => x !== null),
    )
    expect(boundIds.size, 'the broker binds three slots, so one source is left over').toBeLessThan(
      4,
    )

    // Narrow the candidates to the LEFTOVER alone, so the flag is what decides
    // the answer and not the ranking. A test where the bound stream would have
    // won anyway proves nothing — neutralising the flag left it green.
    const orphan = manager.getCameraStreamsForDevice(107).find((x) => !boundIds.has(x.camStreamId))
    expect(orphan, 'nothing was left over, so there is no rule to exercise').toBeDefined()
    const height = orphan?.resolution?.height ?? 0
    const onlyTheOrphan = { minHeight: height, maxHeight: height } as const

    const without = await provider.pickStream({
      deviceId: 107,
      requirements: { acceptCodecs: ['h264'], ...onlyTheOrphan },
    })
    expect(
      without?.camStreamId,
      'the unbound stream must still be visible to a caller that did not ask',
    ).toBe(orphan?.camStreamId)
    expect(without?.profile, 'it is bound to nothing, so it can name no profile').toBeUndefined()

    const withFlag = await provider.pickStream({
      deviceId: 107,
      requirements: { acceptCodecs: ['h264'], ...onlyTheOrphan, requireProfileBound: true },
    })
    expect(withFlag, 'no slot serves it — offering it names something nothing can dial').toBeNull()
  })

  /**
   * And the flag is NOT the default: the broker itself picks through here to
   * decide which source to BIND to a slot, and would never bind anything if it
   * could only see what is already bound.
   */
  it('still shows unbound streams to a caller that did not ask', async () => {
    await manager.publishCameraStream({
      deviceId: 593,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://main',
      codec: 'h264',
      resolution: { width: 1280, height: 720 },
      fps: 25,
    })
    const picked = await provider.pickStream({
      deviceId: 593,
      requirements: { acceptCodecs: ['h264'] },
    })
    expect(picked?.camStreamId).toBe('native:main')
  })
})

describe('WebrtcSessionProvider', () => {
  /**
   * Build a mock BrokerWebrtcServer. The real server owns session
   * lifecycle; the WebrtcSessionProvider is a thin facade that
   * builds `${deviceId}/${profile}` streamIds and delegates.
   */
  // Per-device assignment fixture used by the createSession unit tests.
  // Mock returns slots filtered by deviceId so the resolver lands the
  // right cam stream for each test.
  const PROFILE_FIXTURES: Record<
    number,
    ReadonlyArray<{ profile: 'high' | 'low' | 'mid'; sourceCamStreamId: string | null }>
  > = {
    42: [{ profile: 'high', sourceCamStreamId: 'main' }],
    5: [{ profile: 'mid', sourceCamStreamId: 'only' }],
    7: [{ profile: 'mid', sourceCamStreamId: 'sub' }],
    9: [{ profile: 'high', sourceCamStreamId: 'cam' }],
  }
  const mockManager = {
    getProfileSlotsForDevice: vi.fn().mockImplementation((deviceId: number) => {
      const slots = PROFILE_FIXTURES[deviceId] ?? []
      return slots.map((s) => ({
        deviceId,
        profile: s.profile,
        brokerId: s.sourceCamStreamId
          ? `${deviceId}/${s.sourceCamStreamId}`
          : `${deviceId}/${s.profile}`,
        sourceCamStreamId: s.sourceCamStreamId,
        status: 'idle',
      }))
    }),
    getCameraStreamsForDevice: vi.fn().mockReturnValue([]),
    getBroker: vi.fn().mockResolvedValue(null),
    getCameraStreamProbedParams: vi.fn().mockReturnValue(undefined),
  } as unknown as import('../stream-broker/stream-broker-manager.js').StreamBrokerManager

  beforeEach(() => {
    vi.mocked(mockManager.getCameraStreamProbedParams).mockReturnValue(undefined)
    vi.mocked(mockManager.getProfileSlotsForDevice).mockImplementation((deviceId: number) => {
      const slots = PROFILE_FIXTURES[deviceId] ?? []
      return slots.map((s) => ({
        deviceId,
        profile: s.profile,
        brokerId: s.sourceCamStreamId
          ? `${deviceId}/${s.sourceCamStreamId}`
          : `${deviceId}/${s.profile}`,
        sourceCamStreamId: s.sourceCamStreamId,
        status: 'idle',
      }))
    })
  })

  function makeMockWebrtcServer(
    overrides: {
      createSession?: ReturnType<typeof vi.fn>
      handleAnswer?: ReturnType<typeof vi.fn>
      closeSession?: ReturnType<typeof vi.fn>
    } = {},
  ) {
    return {
      createSession:
        overrides.createSession ??
        vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' }),
      handleAnswer: overrides.handleAnswer ?? vi.fn().mockResolvedValue(undefined),
      closeSession: overrides.closeSession ?? vi.fn().mockResolvedValue(undefined),
    } as unknown as import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
  }

  it('createSession with kind="profile" resolves to the bound camStreamId via assignments', async () => {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    const result = await facade.createSession({
      deviceId: 42,
      target: { kind: 'profile', profile: 'high' },
    })
    expect(result).toEqual({ sessionId: 's1', sdpOffer: 'offer' })
    expect(createSession).toHaveBeenCalledWith(
      '42/main',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('createSession with kind="adaptive" yields the `${deviceId}/adaptive` sentinel', async () => {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 'a1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({ deviceId: 5, target: { kind: 'adaptive' } })
    expect(createSession).toHaveBeenCalledWith(
      '5/adaptive',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('createSession with kind="cam-stream" routes directly by camStreamId', async () => {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 'c1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({
      deviceId: 7,
      target: { kind: 'cam-stream', camStreamId: 'native:main' },
    })
    expect(createSession).toHaveBeenCalledWith(
      '7/native:main',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('createSession forwards hints when provided', async () => {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    const hints = { viewportWidth: 800, viewportHeight: 600 }
    await facade.createSession({ deviceId: 7, target: { kind: 'profile', profile: 'mid' }, hints })
    expect(createSession).toHaveBeenCalledWith(
      '7/sub',
      hints,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('createSession threads a server-injected relayOnly=true into the broker opts', async () => {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({
      deviceId: 7,
      target: { kind: 'cam-stream', camStreamId: 'sub' },
      relayOnly: true,
    })
    expect(createSession).toHaveBeenCalledWith(
      '7/sub',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: true }),
    )
  })

  it('createSession sets streamingDebug=true when per-device webrtcDebug is on', async () => {
    // The "Advanced WebRTC debug logging" toggle (webrtcDebug) must put the
    // session into debug mode for this device — wired via the manager's
    // isWebrtcDebug accessor, ORed with isStreamingDebug.
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const debugManager = {
      ...mockManager,
      isStreamingDebug: vi.fn().mockReturnValue(false),
      isWebrtcDebug: vi.fn().mockReturnValue(true),
    } as unknown as import('../stream-broker/stream-broker-manager.js').StreamBrokerManager
    const facade = new WebrtcSessionProvider(server, debugManager)

    await facade.createSession({ deviceId: 42, target: { kind: 'profile', profile: 'high' } })
    expect(createSession).toHaveBeenCalledWith(
      '42/main',
      undefined,
      expect.objectContaining({ streamingDebug: true, relayOnly: false }),
    )
  })

  it('handleOffer sets streamingDebug=true when per-device webrtcDebug is on', async () => {
    const handleOffer = vi.fn().mockResolvedValue({ sessionId: 's1', sdpAnswer: 'answer' })
    const server = {
      handleOffer,
      handleAnswer: vi.fn(),
      closeSession: vi.fn(),
    } as unknown as import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
    const debugManager = {
      ...mockManager,
      isStreamingDebug: vi.fn().mockReturnValue(false),
      isWebrtcDebug: vi.fn().mockReturnValue(true),
    } as unknown as import('../stream-broker/stream-broker-manager.js').StreamBrokerManager
    const facade = new WebrtcSessionProvider(server, debugManager)

    await facade.handleOffer({ deviceId: 42, sdpOffer: 'offer' })
    expect(handleOffer).toHaveBeenCalledWith(
      '42/adaptive',
      'offer',
      undefined,
      expect.objectContaining({ streamingDebug: true }),
    )
  })

  it('handleOffer carries talkback to the server only when the caller asked (D771)', async () => {
    const handleOffer = vi.fn().mockResolvedValue({ sessionId: 's1', sdpAnswer: 'answer' })
    const server = {
      handleOffer,
      handleAnswer: vi.fn(),
      closeSession: vi.fn(),
    } as unknown as import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.handleOffer({ deviceId: 42, sdpOffer: 'offer', talkback: true })
    await facade.handleOffer({ deviceId: 42, sdpOffer: 'offer' })
    expect(handleOffer.mock.calls[0]?.[3]).toMatchObject({ talkback: true })
    expect(handleOffer.mock.calls[1]?.[3]).toMatchObject({ talkback: false })
  })

  it('createSession throws when the requested profile has no source assigned', async () => {
    const createSession = vi.fn()
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await expect(
      facade.createSession({ deviceId: 9, target: { kind: 'profile', profile: 'low' } }),
    ).rejects.toThrow(/no source assigned/)
  })

  it('handleAnswer delegates to BrokerWebrtcServer', async () => {
    const handleAnswer = vi.fn().mockResolvedValue(undefined)
    const server = makeMockWebrtcServer({ handleAnswer })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.handleAnswer({ deviceId: 1, sessionId: 's-w1', sdpAnswer: 'ans' })
    expect(handleAnswer).toHaveBeenCalledWith('s-w1', 'ans')
  })

  it('handleAnswer propagates errors for unknown sessions', async () => {
    const handleAnswer = vi.fn().mockRejectedValue(new Error('Session not found: nope'))
    const server = makeMockWebrtcServer({ handleAnswer })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await expect(
      facade.handleAnswer({ deviceId: 1, sessionId: 'nope', sdpAnswer: 'x' }),
    ).rejects.toThrow(/Session not found/)
  })

  it('closeSession delegates to BrokerWebrtcServer', async () => {
    const closeSession = vi.fn().mockResolvedValue(undefined)
    const server = makeMockWebrtcServer({ closeSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.closeSession({ deviceId: 1, sessionId: 's1' })
    expect(closeSession).toHaveBeenCalledWith('s1')
  })

  it('closeSession is safe to call twice (server handles idempotency)', async () => {
    const closeSession = vi.fn().mockResolvedValue(undefined)
    const server = makeMockWebrtcServer({ closeSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.closeSession({ deviceId: 1, sessionId: 's1' })
    await facade.closeSession({ deviceId: 1, sessionId: 's1' })
    expect(closeSession).toHaveBeenCalledTimes(2)
  })

  it('hasAdaptiveBitrate always returns false (broker-direct mode)', async () => {
    const server = makeMockWebrtcServer()
    const facade = new WebrtcSessionProvider(server, mockManager)
    // Broker-direct mode has no adaptive bitrate switching
    expect(await facade.hasAdaptiveBitrate({ deviceId: 1, profile: 'high' })).toBe(false)
  })

  it('createSession passes WEBRTC_FALLBACK_PROFILE as transcodeProfile when no override is set', async () => {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({ deviceId: 42, target: { kind: 'profile', profile: 'high' } })

    expect(createSession).toHaveBeenCalledWith(
      '42/main',
      undefined,
      expect.objectContaining({ transcodeProfile: WEBRTC_FALLBACK_PROFILE }),
    )
  })

  it('createSession ignores any per-stream override — the override path is removed', async () => {
    // The operator-configurable per-stream override was removed; the
    // WebRTC path always uses the hardcoded fallback profile (here the
    // source has no probed dimensions, so the raw fallback is used).
    vi.mocked(mockManager.getCameraStreamProbedParams).mockReturnValue(undefined)
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({ deviceId: 42, target: { kind: 'profile', profile: 'high' } })

    expect(createSession).toHaveBeenCalledWith(
      '42/main',
      undefined,
      expect.objectContaining({ transcodeProfile: WEBRTC_FALLBACK_PROFILE }),
    )
  })

  it('createSession with no override → adapts baked default to the probed source resolution', async () => {
    // 4K H.265 source served to a no-HW-HEVC browser. With no operator
    // override the broker used to scale to 1280×720 (baked default).
    // Smart fallback overrides {width,height} with the probed source so
    // the forced transcode stays 4K H.264 instead.
    const probedSource = {
      video: { codec: 'h265' as const, width: 3840, height: 2160 },
      audio: 'passthrough' as const,
    }
    vi.mocked(mockManager.getCameraStreamProbedParams).mockReturnValue(probedSource)
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({ deviceId: 42, target: { kind: 'profile', profile: 'high' } })

    const opts = createSession.mock.calls[0]?.[2] as {
      transcodeProfile: { video: { width: number; height: number; codec: string } }
    }
    expect(opts.transcodeProfile.video.width).toBe(3840)
    expect(opts.transcodeProfile.video.height).toBe(2160)
    expect(opts.transcodeProfile.video.codec).toBe('h264')
  })

  it('createSession with a 4K probed source → adapts the fallback to 4K (no override path)', async () => {
    // The operator override is gone: the broker uses the hardcoded
    // fallback adapted to the probed source resolution, so a 4K H.265
    // source stays 4K H.264 instead of being pinned to the baked 720p.
    const probedSource = {
      video: { codec: 'h265' as const, width: 3840, height: 2160 },
      audio: 'passthrough' as const,
    }
    vi.mocked(mockManager.getCameraStreamProbedParams).mockReturnValue(probedSource)
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({ deviceId: 42, target: { kind: 'profile', profile: 'high' } })

    const opts = createSession.mock.calls[0]?.[2] as {
      transcodeProfile: { video: { width: number; height: number; codec: string } }
    }
    expect(opts.transcodeProfile.video.width).toBe(3840)
    expect(opts.transcodeProfile.video.height).toBe(2160)
    expect(opts.transcodeProfile.video.codec).toBe('h264')
  })

  it('createSession with no override and source carrying no width/height → falls back to raw WEBRTC_FALLBACK_PROFILE', async () => {
    // Pre-probe state (or a source the broker hasn't measured yet). The
    // smart fallback can't inject dimensions — it returns the baked
    // default by reference so existing behavior is preserved.
    const probedSourceNoRes = {
      video: { codec: 'h264' as const },
      audio: 'passthrough' as const,
    }
    vi.mocked(mockManager.getCameraStreamProbedParams).mockReturnValue(probedSourceNoRes)
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({ deviceId: 42, target: { kind: 'profile', profile: 'high' } })

    expect(createSession).toHaveBeenCalledWith(
      '42/main',
      undefined,
      expect.objectContaining({ transcodeProfile: WEBRTC_FALLBACK_PROFILE }),
    )
  })

  it('createSession on an adaptive target never queries probed source — adaptive falls back to WEBRTC_FALLBACK_PROFILE', async () => {
    // The adaptive sentinel has no concrete camStreamId; probing makes
    // no sense (no single source) — the resolver short-circuits before
    // touching getCameraStreamProbedParams.
    vi.mocked(mockManager.getCameraStreamProbedParams).mockClear()
    const createSession = vi.fn().mockResolvedValue({ sessionId: 'a1', sdpOffer: 'offer' })
    const server = makeMockWebrtcServer({ createSession })
    const facade = new WebrtcSessionProvider(server, mockManager)

    await facade.createSession({ deviceId: 5, target: { kind: 'adaptive' } })

    expect(mockManager.getCameraStreamProbedParams).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalledWith(
      '5/adaptive',
      undefined,
      expect.objectContaining({ transcodeProfile: WEBRTC_FALLBACK_PROFILE }),
    )
  })
})

describe('WebrtcSessionProvider — cross-node ingest wiring (Slice 3 Task 3)', () => {
  /**
   * These tests exercise the REAL `StreamBrokerManager` (unlike the plain
   * `mockManager` object above) because `ensureBrokerForWebrtcSession` reads
   * the manager's own `this.brokers` / `this.api` / `this.localNodeId` /
   * `this.webrtcServer` state. The inner broker the `RemoteEncodedSourceBroker`
   * drives is substituted via `setRemoteEncodedBrokerFactory` (mirrors
   * `remote-encoded-source-broker.spec.ts`'s fake-broker pattern) so no real
   * RTSP dial happens.
   */
  function makeFakeWebrtcServer(): {
    server: import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
    createSession: ReturnType<typeof vi.fn>
    registerBroker: ReturnType<typeof vi.fn>
    unregisterBroker: ReturnType<typeof vi.fn>
  } {
    const createSession = vi.fn().mockResolvedValue({ sessionId: 's1', sdpOffer: 'offer' })
    const registerBroker = vi.fn()
    const unregisterBroker = vi.fn()
    const server = {
      createSession,
      registerBroker,
      unregisterBroker,
      setProfileTierResolver: vi.fn(),
      setStreamOriginResolver: vi.fn(),
      setEgressTranscodeProvider: vi.fn(),
      setEnsureAdaptiveTierBrokerHook: vi.fn(),
      handleAnswer: vi.fn(),
      closeSession: vi.fn(),
    } as unknown as import('../webrtc/broker-webrtc-server.js').BrokerWebrtcServer
    return { server, createSession, registerBroker, unregisterBroker }
  }

  /** Fake inner broker with a controllable `onDemandChange` observer. */
  function makeFakeInnerBroker(): {
    broker: IStreamBrokerWithSourceProvider
    fireDemand: (active: boolean) => void
  } {
    let observer: ((active: boolean) => void) | null = null
    const broker = {
      deviceId: 'fake',
      status: 'streaming',
      suspended: false,
      setSourceProvider: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      onDemandChange: vi.fn((cb: (active: boolean) => void) => {
        observer = cb
        return () => {
          if (observer === cb) observer = null
        }
      }),
    } as unknown as IStreamBrokerWithSourceProvider
    return { broker, fireDemand: (active: boolean) => observer?.(active) }
  }

  it('regression: getIngestOwner resolves to this node → the local path runs, adapter NEVER constructed', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi.fn().mockResolvedValue({ ownerNodeId: 'hub' })
    const createBrokerFactory = vi.fn()
    manager.setRemoteEncodedBrokerFactory(createBrokerFactory)
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')
    const { server, createSession, registerBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)

    const result = await facade.createSession({
      deviceId: 900,
      target: { kind: 'cam-stream', camStreamId: 'main' },
    })

    expect(result).toEqual({ sessionId: 's1', sdpOffer: 'offer' })
    expect(getIngestOwner).toHaveBeenCalledTimes(1)
    expect(createBrokerFactory).not.toHaveBeenCalled()
    expect(registerBroker).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalledWith(
      '900/main',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('remote-adapter: getIngestOwner resolves to a different reachable node → adapter created, broker registered, createSession succeeds', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 901,
        profile: 'mid',
        brokerId: '901/mid',
        sourceCamStreamId: 'main',
        status: 'ready',
      },
    ])
    const getStreamWithCodec = vi.fn().mockResolvedValue({
      url: 'rtsp://10.0.0.9:8554/tok-abc',
      videoCodec: 'H264',
      audioCodec: 'none',
      resolution: { width: 640, height: 360 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: 'pk-901-mid',
    })
    const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    const { broker: fakeInnerBroker, fireDemand } = makeFakeInnerBroker()
    manager.setRemoteEncodedBrokerFactory(() => fakeInnerBroker)

    const { server, createSession, registerBroker, unregisterBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)

    const result = await facade.createSession({
      deviceId: 901,
      target: { kind: 'cam-stream', camStreamId: 'main' },
    })

    expect(result).toEqual({ sessionId: 's1', sdpOffer: 'offer' })
    expect(listAllProfileSlots).toHaveBeenCalledWith(undefined, nodePin('agent-a'))
    expect(getStreamWithCodec).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 901,
        video: 'copy',
        audio: 'none',
        profile: 'mid',
        hostname: '10.0.0.9',
      }),
      nodePin('agent-a'),
    )
    expect(registerBroker).toHaveBeenCalledWith('901/main', fakeInnerBroker)
    expect(createSession).toHaveBeenCalledWith(
      '901/main',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )

    // Last-session-idle teardown: the inner broker's own onDemandChange(false)
    // edge tears down the adapter — unregister + release the owner restream —
    // mirroring `attachDerivedFeeder`'s local-broker teardown hook.
    fireDemand(false)
    await vi.waitFor(() => {
      expect(releaseStreamWithCodec).toHaveBeenCalled()
    })
    expect(unregisterBroker).toHaveBeenCalledWith('901/main')
    expect(releaseStreamWithCodec).toHaveBeenCalledWith(
      { pipelineKey: 'pk-901-mid' },
      nodePin('agent-a'),
    )
  })

  it('concurrency: two overlapping createSession calls for the SAME non-owned brokerId single-flight to ONE acquire + ONE registration (no double-pull, no orphaned adapter)', async () => {
    // Regression for the concurrent-first-session race: without a
    // manager-level single-flight, the `remoteBrokerAdapters.has(brokerId)`
    // guard and the eventual `.set()` straddle `await getIngestOwner.query()`
    // — two concurrent callers for the SAME brokerId both pass the guard
    // (map still empty), both construct an adapter and acquire the owner's
    // restream, and the second `.set()` silently overwrites the first —
    // orphaning it (its restream refcount never released because the map
    // no longer points at it, and its own onDemandChange teardown never
    // fires because no session's demand-edge is wired to IT anymore).
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 950,
        profile: 'mid',
        brokerId: '950/mid',
        sourceCamStreamId: 'main',
        status: 'ready',
      },
    ])
    const getStreamWithCodec = vi.fn().mockResolvedValue({
      url: 'rtsp://10.0.0.9:8554/tok-race',
      videoCodec: 'H264',
      audioCodec: 'none',
      resolution: { width: 640, height: 360 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: 'pk-950-mid',
    })
    const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    const innerBrokers: ReturnType<typeof makeFakeInnerBroker>[] = []
    manager.setRemoteEncodedBrokerFactory(() => {
      const fake = makeFakeInnerBroker()
      innerBrokers.push(fake)
      return fake.broker
    })

    const { server, createSession, registerBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)
    const createArgs = {
      deviceId: 950,
      target: { kind: 'cam-stream' as const, camStreamId: 'main' },
    }

    // Fire BOTH createSession calls before either resolves — the real
    // race: neither has reached `remoteBrokerAdapters.set()` when the
    // second one starts (don't await the first before starting the
    // second).
    const [result1, result2] = await Promise.all([
      facade.createSession(createArgs),
      facade.createSession(createArgs),
    ])

    expect(result1).toEqual({ sessionId: 's1', sdpOffer: 'offer' })
    expect(result2).toEqual({ sessionId: 's1', sdpOffer: 'offer' })
    // Exactly ONE owner acquire — no double-pull / double refcount.
    expect(getStreamWithCodec).toHaveBeenCalledTimes(1)
    // Exactly ONE adapter constructed and registered — no orphan.
    expect(innerBrokers).toHaveLength(1)
    expect(registerBroker).toHaveBeenCalledTimes(1)
    expect(registerBroker).toHaveBeenCalledWith('950/main', innerBrokers[0]?.broker)
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('refcount churn (Task 4): a session sharing the alive adapter adds no extra acquire; full teardown then a new session re-acquires from scratch', async () => {
    // Mirrors `RemoteSourcePlane`'s multi-subscriber sharing invariant
    // ("last unsubscribe tears the entry down… a later re-subscribe
    // re-acquires — fresh URL/token, never cached") for the WebRTC leg's
    // adapter, which lives in `StreamBrokerManager.remoteBrokerAdapters`
    // rather than inside `RemoteEncodedSourceBroker` itself (that class
    // refuses `getBroker()` after its own `dispose()` by design — it is a
    // one-shot object; the manager constructs a brand-new instance per
    // acquire cycle).
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const brokerId = '906/main'
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-a', reachableHost: '10.0.0.9' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 906,
        profile: 'mid',
        brokerId,
        sourceCamStreamId: 'main',
        status: 'ready',
      },
    ])
    let acquireCount = 0
    const getStreamWithCodec = vi.fn().mockImplementation(async () => {
      acquireCount += 1
      return {
        url: `rtsp://10.0.0.9:8554/tok-${acquireCount}`,
        videoCodec: 'H264',
        audioCodec: 'none',
        resolution: { width: 640, height: 360 },
        transcoded: false,
        encoder: 'copy',
        pipelineKey: `pk-906-mid-${acquireCount}`,
      }
    })
    const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    const innerBrokers: ReturnType<typeof makeFakeInnerBroker>[] = []
    manager.setRemoteEncodedBrokerFactory(() => {
      const fake = makeFakeInnerBroker()
      innerBrokers.push(fake)
      return fake.broker
    })

    const { server, registerBroker, unregisterBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)
    const createArgs = {
      deviceId: 906,
      target: { kind: 'cam-stream' as const, camStreamId: 'main' },
    }

    // Session 1 — the FIRST session for this brokerId triggers the ONE
    // acquire + adapter construction.
    await facade.createSession(createArgs)
    expect(getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(innerBrokers).toHaveLength(1)
    expect(registerBroker).toHaveBeenCalledTimes(1)
    expect(registerBroker).toHaveBeenCalledWith(brokerId, innerBrokers[0]?.broker)

    // Session 2 — a second session for the SAME brokerId while the adapter
    // is still alive short-circuits on `remoteBrokerAdapters.has(brokerId)`:
    // zero extra acquires, zero extra broker construction — ONE acquisition
    // backs both sessions (refcount-shared).
    await facade.createSession(createArgs)
    expect(getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(innerBrokers).toHaveLength(1)
    expect(registerBroker).toHaveBeenCalledTimes(1)

    // Last-session-close: the inner broker's own onDemandChange(false) edge
    // tears the adapter down fully — unregister + release the owner restream.
    innerBrokers[0]?.fireDemand(false)
    await vi.waitFor(() => {
      expect(releaseStreamWithCodec).toHaveBeenCalledTimes(1)
    })
    expect(unregisterBroker).toHaveBeenCalledWith(brokerId)
    expect(releaseStreamWithCodec).toHaveBeenCalledWith(
      { pipelineKey: 'pk-906-mid-1' },
      nodePin('agent-a'),
    )

    // Session 3 — a NEW session after full teardown re-acquires from
    // scratch: a SECOND getStreamWithCodec call (never a cached URL/token)
    // driving a brand-new adapter/inner-broker instance.
    await facade.createSession(createArgs)
    expect(getStreamWithCodec).toHaveBeenCalledTimes(2)
    expect(innerBrokers).toHaveLength(2)
    expect(innerBrokers[1]?.broker).not.toBe(innerBrokers[0]?.broker)
    expect(registerBroker).toHaveBeenCalledTimes(2)
    expect(registerBroker).toHaveBeenLastCalledWith(brokerId, innerBrokers[1]?.broker)
  })

  it('unresolvable: getIngestOwner resolves to a different node with no reachableHost → throws instead of hanging', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi.fn().mockResolvedValue({ ownerNodeId: 'agent-b' })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')
    const { server, createSession } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)

    await expect(
      facade.createSession({ deviceId: 902, target: { kind: 'cam-stream', camStreamId: 'main' } }),
    ).rejects.toThrow(/agent-b/)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('getIngestOwner throwing degrades gracefully to local — no adapter, existing flow proceeds', async () => {
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi.fn().mockRejectedValue(new Error('cap not mounted yet'))
    const createBrokerFactory = vi.fn()
    manager.setRemoteEncodedBrokerFactory(createBrokerFactory)
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')
    const { server, createSession, registerBroker } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)

    const result = await facade.createSession({
      deviceId: 903,
      target: { kind: 'cam-stream', camStreamId: 'main' },
    })

    expect(result).toEqual({ sessionId: 's1', sdpOffer: 'offer' })
    expect(createBrokerFactory).not.toHaveBeenCalled()
    expect(registerBroker).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalled()
  })

  it('regression: a pre-existing LOCAL broker for brokerId short-circuits — getIngestOwner is NEVER called (rollout-safety guarantee)', async () => {
    // The `this.brokers.has(brokerId)` first-line early-return in
    // `ensureBrokerForWebrtcSession` is the guarantee that today's
    // owner==self deployments (every camera's `ingestNode` is the hub) see
    // ZERO extra calls — not even a `getIngestOwner` round-trip. Publish a
    // local broker for the target brokerId FIRST (mirrors how a live camera
    // already has a broker from `publishCameraStream`/`ensureBroker`), then
    // exercise the webrtc-session path and assert the cross-node resolver
    // is never even queried.
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    await manager.publishCameraStream({
      deviceId: 904,
      camStreamId: 'main',
      kind: 'pull-rtsp',
      url: 'rtsp://904',
    })
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-z', reachableHost: '10.0.0.1' })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')
    const { server, createSession } = makeFakeWebrtcServer()
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)

    const result = await facade.createSession({
      deviceId: 904,
      target: { kind: 'cam-stream', camStreamId: 'main' },
    })

    expect(result).toEqual({ sessionId: 's1', sdpOffer: 'offer' })
    expect(getIngestOwner).not.toHaveBeenCalled()
    expect(createSession).toHaveBeenCalledWith(
      '904/main',
      undefined,
      expect.objectContaining({ streamingDebug: false, relayOnly: false }),
    )
  })

  it('leak fix: delegate throws AFTER remote-adapter registration → the adapter is disposed and the original error propagates', async () => {
    // Reproduces the resource leak: `ensureBrokerForWebrtcSession` already
    // registered the remote adapter + inner broker (like the "remote-adapter"
    // test above), but this time `BrokerWebrtcServer.createSession` itself
    // throws (session-construction error). Demand on the inner broker never
    // reaches `true`, so the `onDemandChange(true→false)` teardown edge never
    // fires — without the delegate-failure cleanup this adapter + its WebRTC
    // registration + the owner restream refcount would leak forever.
    const manager = new StreamBrokerManager(makeLogger())
    stubRtsp(manager)
    const getIngestOwner = vi
      .fn()
      .mockResolvedValue({ ownerNodeId: 'agent-c', reachableHost: '10.0.0.10' })
    const listAllProfileSlots = vi.fn().mockResolvedValue([
      {
        deviceId: 905,
        profile: 'mid',
        brokerId: '905/mid',
        sourceCamStreamId: 'main',
        status: 'ready',
      },
    ])
    const getStreamWithCodec = vi.fn().mockResolvedValue({
      url: 'rtsp://10.0.0.10:8554/tok-def',
      videoCodec: 'H264',
      audioCodec: 'none',
      resolution: { width: 640, height: 360 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: 'pk-905-mid',
    })
    const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
    const api = {
      pipelineOrchestrator: { getIngestOwner: { query: getIngestOwner } },
      streamBroker: {
        listAllProfileSlots: { query: listAllProfileSlots },
        getStreamWithCodec: { mutate: getStreamWithCodec },
        releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
      },
    } as unknown as AddonApi
    manager.setApiAccess(api, 'hub')

    const { broker: fakeInnerBroker } = makeFakeInnerBroker()
    manager.setRemoteEncodedBrokerFactory(() => fakeInnerBroker)

    const delegateError = new Error('offer construction failed')
    const { server, createSession, registerBroker, unregisterBroker } = makeFakeWebrtcServer()
    createSession.mockRejectedValueOnce(delegateError)
    manager.setWebrtcServer(server)
    const facade = new WebrtcSessionProvider(server, manager)

    await expect(
      facade.createSession({ deviceId: 905, target: { kind: 'cam-stream', camStreamId: 'main' } }),
    ).rejects.toThrow('offer construction failed')

    expect(registerBroker).toHaveBeenCalledWith('905/main', fakeInnerBroker)
    expect(unregisterBroker).toHaveBeenCalledWith('905/main')
    expect(releaseStreamWithCodec).toHaveBeenCalledWith(
      { pipelineKey: 'pk-905-mid' },
      nodePin('agent-c'),
    )
  })
})

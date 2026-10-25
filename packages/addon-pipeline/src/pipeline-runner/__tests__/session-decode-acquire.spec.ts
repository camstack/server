/**
 * Owner-node pin coverage for `acquireSessionDecodeRestreamFrom` (extracted
 * from the private `acquireSessionDecodeRestream` method so the pin threading
 * through the three `streamBroker` calls — `listAllProfileSlots`,
 * `getStreamWithCodec`, `releaseStreamWithCodec` — is unit-testable). Before
 * this extraction only the pure `resolveSessionDecodeOwnerNodeId` helper that
 * COMPUTES the pin had coverage; a future edit dropping `pin` from one of the
 * three calls would have passed the whole suite. Mirrors the
 * `remote-source-plane.spec.ts` fake-api pattern.
 */
import { DETECTION_PRE_ROLL_REQUEST_MS } from '../../stream-broker/rtsp/restream-intent.js'
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { nodePin } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import { acquireSessionDecodeRestreamFrom } from '../index.js'

function mockLogger(): IScopedLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  } as unknown as IScopedLogger
}

const SLOTS = [
  {
    deviceId: 104,
    profile: 'high',
    brokerId: '104/high',
    sourceCamStreamId: 'main',
    status: 'ready',
  },
] as const

interface FakeApi {
  api: AddonApi
  listAllProfileSlots: ReturnType<typeof vi.fn>
  getStreamWithCodec: ReturnType<typeof vi.fn>
  releaseStreamWithCodec: ReturnType<typeof vi.fn>
}

function makeFakeApi(): FakeApi {
  const listAllProfileSlots = vi.fn().mockResolvedValue(SLOTS)
  const getStreamWithCodec = vi.fn().mockResolvedValue({
    url: 'rtsp://127.0.0.1:8554/tok-abc',
    videoCodec: 'H264',
    audioCodec: 'none',
    resolution: { width: 640, height: 360 },
    transcoded: false,
    encoder: 'copy',
    pipelineKey: 'pk-104-high-copy',
  })
  const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
  const api = {
    streamBroker: {
      listAllProfileSlots: { query: listAllProfileSlots },
      getStreamWithCodec: { mutate: getStreamWithCodec },
      releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
    },
  } as unknown as AddonApi
  return { api, listAllProfileSlots, getStreamWithCodec, releaseStreamWithCodec }
}

describe('acquireSessionDecodeRestreamFrom (owner-node pin threading)', () => {
  it('pins all three streamBroker calls to the owner node when ownerNodeId is set', async () => {
    const fake = makeFakeApi()
    const pin = nodePin('owner-x')

    const result = await acquireSessionDecodeRestreamFrom(fake.api, mockLogger(), {
      deviceId: 104,
      streamId: 'main',
      tag: 'session-decode:detect:104',
      hostname: 'h',
      ownerNodeId: 'owner-x',
    })

    expect(result).not.toBeNull()
    expect(fake.listAllProfileSlots).toHaveBeenCalledWith(undefined, pin)
    expect(fake.getStreamWithCodec).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 104, video: 'copy', profile: 'high', hostname: 'h' }),
      pin,
    )

    await result?.release()
    expect(fake.releaseStreamWithCodec).toHaveBeenCalledWith(expect.anything(), pin)
  })

  it("leaves all three streamBroker calls unpinned when ownerNodeId is omitted (today's node-local behavior)", async () => {
    const fake = makeFakeApi()

    const result = await acquireSessionDecodeRestreamFrom(fake.api, mockLogger(), {
      deviceId: 104,
      streamId: 'main',
      tag: 'session-decode:detect:104',
    })

    expect(result).not.toBeNull()
    expect(fake.listAllProfileSlots).toHaveBeenCalledWith(undefined, undefined)
    expect(fake.getStreamWithCodec).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 104, video: 'copy', profile: 'high' }),
      undefined,
    )

    await result?.release()
    expect(fake.releaseStreamWithCodec).toHaveBeenCalledWith(expect.anything(), undefined)
  })
})

/**
 * The DETECTION dial intent (see `stream-broker/rtsp/restream-intent.ts`).
 *
 * The broker cap input has no purpose field, so the only channel a decode dial
 * has for declaring itself is the URL it dials. This is where that declaration
 * is applied — and where a regression would silently put every detection decode
 * back on the blind-start path with nothing failing.
 */
describe('acquireSessionDecodeRestreamFrom (detection dial intent)', () => {
  function makeMutedApi(): FakeApi {
    const fake = makeFakeApi()
    fake.getStreamWithCodec.mockResolvedValue({
      url: 'rtsp://127.0.0.1:8554/tok-abc/muted',
      videoCodec: 'H264',
      audioCodec: 'none',
      resolution: { width: 640, height: 360 },
      transcoded: false,
      encoder: 'copy',
      pipelineKey: 'pk-104-high-copy',
    })
    return fake
  }

  it('dials the detection-intent path when the caller declares it', async () => {
    const fake = makeMutedApi()

    const result = await acquireSessionDecodeRestreamFrom(fake.api, mockLogger(), {
      deviceId: 104,
      streamId: 'main',
      tag: 'session-decode:detect:104',
      detectionIntent: true,
    })

    // The dial states BOTH halves (D382): the intent, and the history it asks
    // for. Without the second the session would be served none — which is now
    // the correct answer to a dial that named no amount.
    expect(result?.source.restreamUrl).toBe(
      `rtsp://127.0.0.1:8554/tok-abc/muted-detection/preroll-${DETECTION_PRE_ROLL_REQUEST_MS}`,
    )
  })

  it('leaves the URL alone for every other dial (motion, and today by default)', async () => {
    const fake = makeMutedApi()

    const result = await acquireSessionDecodeRestreamFrom(fake.api, mockLogger(), {
      deviceId: 104,
      streamId: 'main',
      tag: 'session-decode:motion:104',
    })

    expect(result?.source.restreamUrl).toBe('rtsp://127.0.0.1:8554/tok-abc/muted')
  })
})

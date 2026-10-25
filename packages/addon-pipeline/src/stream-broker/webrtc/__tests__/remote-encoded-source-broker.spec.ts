/**
 * `RemoteEncodedSourceBroker` — the WebRTC encoded-source leg's RTP/encoded
 * analogue of `RemoteSourcePlane`. Mirrors `remote-source-plane.spec.ts`'s
 * fake-api pattern for mocking `streamBroker.*`; the inner `StreamBroker` is
 * substituted via the injected `createBroker` factory so no real RTSP dial
 * happens in these tests.
 */
import type { AddonApi, IScopedLogger, StreamSource } from '@camstack/types'
import { nodePin } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  RemoteEncodedSourceBroker,
  type CreateStreamBroker,
  type IStreamBrokerWithSourceProvider,
} from '../remote-encoded-source-broker.js'

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
    profile: 'low',
    brokerId: '104/low',
    sourceCamStreamId: 'sub',
    status: 'ready',
  },
] as const

interface FakeApi {
  api: AddonApi
  getStreamWithCodec: ReturnType<typeof vi.fn>
  releaseStreamWithCodec: ReturnType<typeof vi.fn>
  listAllProfileSlots: ReturnType<typeof vi.fn>
}

function makeFakeApi(): FakeApi {
  const listAllProfileSlots = vi.fn().mockResolvedValue(SLOTS)
  const getStreamWithCodec = vi.fn().mockResolvedValue({
    url: 'rtsp://192.168.10.9:8554/tok-abc',
    videoCodec: 'H264',
    audioCodec: 'none',
    resolution: { width: 640, height: 360 },
    transcoded: false,
    encoder: 'copy',
    pipelineKey: 'pk-104-low-copy',
  })
  const releaseStreamWithCodec = vi.fn().mockResolvedValue({ released: true, refcount: 0 })
  const api = {
    streamBroker: {
      listAllProfileSlots: { query: listAllProfileSlots },
      getStreamWithCodec: { mutate: getStreamWithCodec },
      releaseStreamWithCodec: { mutate: releaseStreamWithCodec },
    },
  } as unknown as AddonApi
  return { api, getStreamWithCodec, releaseStreamWithCodec, listAllProfileSlots }
}

interface FakeBroker {
  broker: IStreamBrokerWithSourceProvider
  setSourceProvider: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  getSourceProvider: () => (() => StreamSource | null) | undefined
}

function makeFakeBroker(): FakeBroker {
  let sourceProvider: (() => StreamSource | null) | undefined
  const setSourceProvider = vi.fn((provider: () => StreamSource | null) => {
    sourceProvider = provider
  })
  const start = vi.fn().mockResolvedValue(undefined)
  const stop = vi.fn().mockResolvedValue(undefined)
  const broker = {
    deviceId: 'fake',
    status: 'streaming',
    suspended: false,
    setSourceProvider,
    start,
    stop,
  } as unknown as IStreamBrokerWithSourceProvider
  return { broker, setSourceProvider, start, stop, getSourceProvider: () => sourceProvider }
}

function makeCreateBrokerFactory(): {
  createBroker: CreateStreamBroker
  brokers: FakeBroker[]
  calls: ReturnType<typeof vi.fn>
} {
  const brokers: FakeBroker[] = []
  const calls = vi.fn()
  const createBroker: CreateStreamBroker = (deps) => {
    calls(deps)
    const fake = makeFakeBroker()
    brokers.push(fake)
    return fake.broker
  }
  return { createBroker, brokers, calls }
}

function makeSourceBroker(
  fake: FakeApi,
  factory: ReturnType<typeof makeCreateBrokerFactory>,
): RemoteEncodedSourceBroker {
  return new RemoteEncodedSourceBroker({
    api: fake.api,
    logger: mockLogger(),
    deviceId: 104,
    streamId: 'sub',
    ownerNodeId: 'owner-x',
    reachableHost: 'reachable-host',
    createBroker: factory.createBroker,
  })
}

describe('RemoteEncodedSourceBroker', () => {
  let fake: FakeApi
  let factory: ReturnType<typeof makeCreateBrokerFactory>

  beforeEach(() => {
    fake = makeFakeApi()
    factory = makeCreateBrokerFactory()
  })

  it('acquires the owner restream pinned to the owner node, targeting the resolved profile', async () => {
    const source = makeSourceBroker(fake, factory)
    await source.getBroker()

    expect(fake.listAllProfileSlots).toHaveBeenCalledWith(undefined, nodePin('owner-x'))
    expect(fake.getStreamWithCodec).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 104,
        video: 'copy',
        audio: 'none',
        profile: 'low',
        hostname: 'reachable-host',
      }),
      nodePin('owner-x'),
    )
    await source.dispose()
  })

  it('single-flights concurrent getBroker() calls into ONE acquire', async () => {
    const source = makeSourceBroker(fake, factory)
    const [a, b] = await Promise.all([source.getBroker(), source.getBroker()])

    expect(a).toBe(b)
    expect(fake.getStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(factory.calls).toHaveBeenCalledTimes(1)
    await source.dispose()
  })

  it('a rejected acquire is retryable — the next getBroker() re-acquires', async () => {
    fake.getStreamWithCodec.mockRejectedValueOnce(new Error('dial failed'))
    const source = makeSourceBroker(fake, factory)

    await expect(source.getBroker()).rejects.toThrow('dial failed')
    expect(fake.getStreamWithCodec).toHaveBeenCalledTimes(1)

    const broker = await source.getBroker()
    expect(broker).toBeDefined()
    expect(fake.getStreamWithCodec).toHaveBeenCalledTimes(2)
    await source.dispose()
  })

  it('dispose() stops the inner broker and releases the restream once; a second dispose() is a no-op', async () => {
    const source = makeSourceBroker(fake, factory)
    await source.getBroker()
    const fakeBroker = factory.brokers[0]
    expect(fakeBroker).toBeDefined()

    await source.dispose()
    expect(fakeBroker?.stop).toHaveBeenCalledTimes(1)
    expect(fake.releaseStreamWithCodec).toHaveBeenCalledTimes(1)
    expect(fake.releaseStreamWithCodec).toHaveBeenCalledWith(
      { pipelineKey: 'pk-104-low-copy' },
      nodePin('owner-x'),
    )

    await source.dispose()
    expect(fakeBroker?.stop).toHaveBeenCalledTimes(1)
    expect(fake.releaseStreamWithCodec).toHaveBeenCalledTimes(1)
  })

  it("the inner broker's sourceProvider returns the acquired {type:'rtsp', url}", async () => {
    const source = makeSourceBroker(fake, factory)
    await source.getBroker()
    const fakeBroker = factory.brokers[0]
    expect(fakeBroker).toBeDefined()

    expect(fakeBroker?.setSourceProvider).toHaveBeenCalledTimes(1)
    expect(fakeBroker?.start).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'rtsp', url: 'rtsp://192.168.10.9:8554/tok-abc' }),
    )
    const provider = fakeBroker?.getSourceProvider()
    expect(provider?.()).toEqual(
      expect.objectContaining({ type: 'rtsp', url: 'rtsp://192.168.10.9:8554/tok-abc' }),
    )
    await source.dispose()
  })
})

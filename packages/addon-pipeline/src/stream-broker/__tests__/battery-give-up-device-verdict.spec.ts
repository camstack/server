import {
  type AddonApi,
  type CamStreamDescriptor,
  DeviceFeature,
  EventCategory,
  type EventFilter,
  type IEventBus,
  type IScopedLogger,
  type SystemEvent,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamBroker } from '../stream-broker/stream-broker.js'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

/**
 * LIVE BUG (device 640, Argus 3E, 2026-11-21): the battery give-up never fired.
 * The broker's battery verdict was read from the `deviceFeatures` the PUBLISHER
 * stamped on its cam-streams, and the Reolink catalog does not carry `sleeps`
 * (that feature is derived from the `low-power-sleep` binding by the device
 * registry). The broker looped on "requesting publisher to materialize" for
 * ever, each pass logging in to a sleeping camera.
 *
 * The verdict must come from the DEVICE (registry features), whatever the
 * publisher omitted.
 */

const DEVICE_ID = 640
const CAM_STREAM_ID = 'native:main'

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
  const entry = (brokerId: string) => ({
    brokerId,
    url: `rtsp://host/${brokerId}`,
    mutedUrl: '',
    enabled: true,
  })
  Object.assign(manager, {
    rtspProvider: {
      getEntry: vi.fn(entry),
      getInternalEntry: vi.fn(entry),
      setEnabled: vi.fn(),
      isEnabled: vi.fn(() => true),
      setTokenPersister: vi.fn(),
      setEnabledPersister: vi.fn(),
      getAllEntries: vi.fn(() => []),
      regenerateToken: vi.fn(),
      getRtspPort: vi.fn(() => 8554),
      persistTokens: vi.fn(),
    },
    rtspServer: {
      registerRestreamer: vi.fn(),
      unregisterRestreamer: vi.fn(),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      getPort: vi.fn(() => 8554),
      loadEnabled: vi.fn(),
    },
  })
}

/** The live shape: a lazy rfc4571 entry published WITHOUT `deviceFeatures`. */
const LAZY_NO_FEATURES: CamStreamDescriptor = {
  camStreamId: CAM_STREAM_ID,
  kind: 'pull-rfc4571',
  label: 'Main',
  url: 'lazy:rfc4571:native%3Amain',
  codec: 'h264',
  autoEligible: true,
}

function makeApi(deviceFeatures: readonly string[]): AddonApi {
  return {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [
          { id: DEVICE_ID, type: 'camera', isCamera: true, disabled: false },
        ]),
      },
      getDevice: { query: vi.fn(async () => ({ id: DEVICE_ID, features: [...deviceFeatures] })) },
    },
    deviceState: { getCapSlice: { query: vi.fn(async () => null) } },
    streamCatalog: { getCatalog: { query: vi.fn(async () => [LAZY_NO_FEATURES]) } },
  } as unknown as AddonApi
}

async function run(
  deviceFeatures: readonly string[],
): Promise<{ refreshRequests: number; broker: StreamBroker | undefined }> {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  const manager = new StreamBrokerManager(makeLogger())
  stubRtsp(manager)
  let refreshRequests = 0
  const bus: IEventBus = {
    emit: (event: SystemEvent) => {
      if (event.category === EventCategory.StreamBrokerOnRequestStreamSourceRefresh) {
        refreshRequests++
      }
    },
    subscribe: (_filter: EventFilter, _handler: (event: SystemEvent) => void) => () => {},
    getRecent: () => [],
  }
  manager.setEventBus(bus)
  manager.setApiAccess(makeApi(deviceFeatures))
  await manager.reconcileDeviceCatalog(DEVICE_ID)
  const broker = (manager as unknown as { brokers: Map<string, StreamBroker> }).brokers.get(
    `${DEVICE_ID}/${CAM_STREAM_ID}`,
  )
  // A consumer with live intent: the broker dials.
  broker?.onEncodedData(() => {})
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  await broker?.stop()
  return { refreshRequests, broker }
}

describe('battery give-up: the verdict is the DEVICE, not what the publisher stamped', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a sleeper whose published stream carries no deviceFeatures', async () => {
    const { refreshRequests, broker } = await run([DeviceFeature.Sleeps])
    expect(broker).toBeDefined()
    // One bounded episode (flat 1 s polls inside the 20 s deadline), then silence.
    expect(refreshRequests).toBeGreaterThan(0)
    expect(refreshRequests).toBeLessThanOrEqual(25)
  })

  it('a mains camera keeps the retry schedule (unchanged)', async () => {
    const { refreshRequests } = await run([])
    expect(refreshRequests).toBeGreaterThan(25)
  })
})

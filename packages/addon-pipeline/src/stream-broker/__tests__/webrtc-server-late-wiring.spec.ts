/**
 * setWebrtcServer must back-register brokers created BEFORE it was wired.
 *
 * Root cause this guards against (observed live on the battery doorbell,
 * device 8): in addon activation `reconcileAllCatalogsAtStartup()` runs and
 * creates brokers via publishCameraStream → ensureBroker → fanOutRegistration
 * BEFORE `setWebrtcServer()` is called. At that point `this.webrtcServer` is
 * undefined, so `fanOutRegistration`'s `if (this.webrtcServer)` guard skips
 * `registerBroker`. Those brokers then live ONLY in the manager's `this.brokers`
 * map — never in the WebRTC server's registry. Because `ensureBroker`
 * short-circuits on `this.brokers.has(brokerId)`, no later reconcile ever
 * repairs the gap. Result: `selectBestBroker` finds zero candidates for the
 * device and every WebRTC session fails with
 *   `No broker for stream "8/adaptive" (resolved: "8/high")`
 * even though the catalog + profile slots are fully populated.
 *
 * The fix: `setWebrtcServer` back-registers every already-created broker into
 * the freshly-wired server, so late wiring (or a server swap) is self-healing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { AddonApi, IScopedLogger, CamStreamDescriptor } from '@camstack/types'

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

function makeManager(): StreamBrokerManager {
  const manager = new StreamBrokerManager(makeLogger())
  stubRtsp(manager)
  return manager
}

function makeApi(descriptors: readonly CamStreamDescriptor[]): AddonApi {
  return {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [{ id: 8, type: 'camera', isCamera: true, disabled: false }]),
      },
    },
    streamCatalog: { getCatalog: { query: vi.fn(async () => descriptors) } },
  } as unknown as AddonApi
}

function makeMockWebrtcServer(): { server: unknown; registerBroker: ReturnType<typeof vi.fn> } {
  const registerBroker = vi.fn()
  const server = {
    registerBroker,
    unregisterBroker: vi.fn(),
    setProfileTierResolver: vi.fn(),
    setStreamOriginResolver: vi.fn(),
    setEgressTranscodeProvider: vi.fn(),
    setEnsureAdaptiveTierBrokerHook: vi.fn(),
  }
  return { server, registerBroker }
}

const MAIN: CamStreamDescriptor = {
  camStreamId: 'native:main',
  kind: 'pull-rtsp',
  url: 'rtsp://example/main',
}
const SUB: CamStreamDescriptor = {
  camStreamId: 'native:sub',
  kind: 'pull-rtsp',
  url: 'rtsp://example/sub',
}

describe('setWebrtcServer — late wiring back-registers existing brokers', () => {
  let manager: StreamBrokerManager
  beforeEach(() => {
    manager = makeManager()
  })

  it('registers brokers that were created BEFORE the WebRTC server was wired', async () => {
    // Reproduce activation order: reconcile (creates brokers) runs while the
    // WebRTC server is still undefined, then setWebrtcServer is wired after.
    manager.setApiAccess(makeApi([MAIN, SUB]))
    await manager.reconcileAllCatalogsAtStartup(1, 1)
    // Brokers now exist in the manager but no WebRTC server has seen them.
    expect(
      manager
        .getCameraStreamsForDevice(8)
        .map((s) => s.camStreamId)
        .toSorted(),
    ).toEqual(['native:main', 'native:sub'])

    const { server, registerBroker } = makeMockWebrtcServer()
    manager.setWebrtcServer(server as never)

    const registered = registerBroker.mock.calls.map((c) => c[0]).toSorted()
    expect(registered).toEqual(['8/native:main', '8/native:sub'])
  })

  it('still registers brokers created AFTER the server is wired (no regression)', async () => {
    const { server, registerBroker } = makeMockWebrtcServer()
    manager.setWebrtcServer(server as never)
    manager.setApiAccess(makeApi([MAIN]))
    await manager.reconcileAllCatalogsAtStartup(1, 1)
    expect(registerBroker.mock.calls.map((c) => c[0])).toContain('8/native:main')
  })
})

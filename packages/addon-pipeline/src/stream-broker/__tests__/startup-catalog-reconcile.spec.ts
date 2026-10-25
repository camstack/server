/**
 * reconcileAllCatalogsAtStartup — bounded-retry startup catalog pull.
 *
 * Verifies the broker awaits a startup reconcile and retries empty cameras:
 *   1. A camera that answers empty on the first pull and non-empty on the
 *      second ends up with a populated cam-stream registry (a 2nd pass ran).
 *   2. A camera that populates on pass 1 triggers NO extra pass (call count).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { AddonApi, IScopedLogger, CamStreamDescriptor } from '@camstack/types'

// ── Fakes ────────────────────────────────────────────────────────────

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

/**
 * Stub out the RTSP layer so publish paths don't try to bind a real port.
 * Mirrors the pattern used by derived-streams-hydration.spec.ts.
 */
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

const MAIN_DESCRIPTOR: CamStreamDescriptor = {
  camStreamId: 'native:main',
  kind: 'pull-rtsp',
  url: 'rtsp://example/main',
}

/**
 * Build a fake AddonApi whose deviceManager.listAll returns one camera and
 * whose streamCatalog.getCatalog returns the supplied descriptor batches in
 * order (one batch per call). `getCatalog` is exposed for call-count asserts.
 */
function makeApi(catalogBatches: readonly (readonly CamStreamDescriptor[])[]): {
  api: AddonApi
  getCatalog: ReturnType<typeof vi.fn>
} {
  let call = 0
  const getCatalog = vi.fn(async () => {
    const batch = catalogBatches[Math.min(call, catalogBatches.length - 1)]
    call += 1
    return batch
  })
  const api = {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [{ id: 1, type: 'camera', isCamera: true, disabled: false }]),
      },
    },
    streamCatalog: {
      getCatalog: { query: getCatalog },
    },
  } as unknown as AddonApi
  return { api, getCatalog }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('reconcileAllCatalogsAtStartup', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
  })

  it('retries a camera that answers empty on the first pass and populates on the second', async () => {
    const { api, getCatalog } = makeApi([[], [MAIN_DESCRIPTOR]])
    manager.setApiAccess(api)

    expect(manager.getCameraStreamsForDevice(1).length).toBe(0)

    await manager.reconcileAllCatalogsAtStartup(2, 1)

    expect(manager.getCameraStreamsForDevice(1).map((s) => s.camStreamId)).toContain('native:main')
    // Two passes ran: first empty, second populated.
    expect(getCatalog).toHaveBeenCalledTimes(2)
  })

  it('runs no extra pass when the camera populates on the first pass', async () => {
    const { api, getCatalog } = makeApi([[MAIN_DESCRIPTOR]])
    manager.setApiAccess(api)

    await manager.reconcileAllCatalogsAtStartup(2, 1)

    expect(manager.getCameraStreamsForDevice(1).map((s) => s.camStreamId)).toContain('native:main')
    // Populated on pass 1 → no second pass.
    expect(getCatalog).toHaveBeenCalledTimes(1)
  })
})

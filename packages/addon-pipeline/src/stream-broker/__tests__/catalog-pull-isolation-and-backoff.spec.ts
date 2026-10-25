/**
 * ONE camera must never cost the fleet its catalog — and its omission must be
 * VISIBLE and BOUNDED.
 *
 * The incident (2026-08-25, device 3629 "Camera porta retro"): a Reolink
 * Baichuan session expired under a socket that stayed open, so every
 * `stream-catalog.getCatalog` for that device answered
 * `buildVideoStreamOptions failed … responseCode 400`. It repeated every 30 s
 * for 35 minutes, at `debug`, and could never have recovered.
 *
 * These are OUTCOME tests against the real `StreamBrokerManager`:
 *   1. the other cameras' cam-streams are published anyway, and only the
 *      failing one is missing;
 *   2. the omission emits a log line carrying that device's numeric
 *      `deviceId` tag;
 *   3. the retry is bounded — a permanently failing camera is asked a handful
 *      of times over hours, not once per poll tick;
 *   4. an EVENT-driven reconcile still gets through the backoff, and a
 *      recovery is announced.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import type { AddonApi, IScopedLogger, CamStreamDescriptor } from '@camstack/types'

// ── Fakes ────────────────────────────────────────────────────────────

interface LogSpy {
  readonly logger: IScopedLogger
  readonly warn: ReturnType<typeof vi.fn>
  readonly info: ReturnType<typeof vi.fn>
}

function makeLogger(): LogSpy {
  const warn = vi.fn()
  const info = vi.fn()
  const l: IScopedLogger = {
    info,
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return { logger: l, warn, info }
}

/** Stub the RTSP layer so publish paths don't bind a real port. */
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

const MAIN_DESCRIPTOR: CamStreamDescriptor = {
  camStreamId: 'native:main',
  kind: 'pull-rtsp',
  url: 'rtsp://example/main',
}

interface CatalogFixture {
  readonly api: AddonApi
  readonly getCatalog: ReturnType<typeof vi.fn>
}

/**
 * A fleet of `deviceIds` cameras whose catalog pull succeeds for everyone
 * except `failing`, for which it rejects with `error`.
 */
function makeApi(
  deviceIds: readonly number[],
  failing: ReadonlySet<number>,
  error = 'buildStreamCatalog: buildVideoStreamOptions failed for device 3629',
): CatalogFixture {
  const getCatalog = vi.fn(async (input: { deviceId: number }) => {
    if (failing.has(input.deviceId)) throw new Error(error)
    return [MAIN_DESCRIPTOR]
  })
  const api = {
    deviceManager: {
      listAll: {
        query: vi.fn(async () =>
          deviceIds.map((id) => ({ id, type: 'camera', isCamera: true, disabled: false })),
        ),
      },
    },
    streamCatalog: { getCatalog: { query: getCatalog } },
  } as unknown as AddonApi
  return { api, getCatalog }
}

interface Harness {
  readonly manager: StreamBrokerManager
  readonly log: LogSpy
}

function makeHarness(api: AddonApi): Harness {
  const log = makeLogger()
  const manager = new StreamBrokerManager(log.logger)
  stubRtsp(manager)
  manager.setApiAccess(api)
  return { manager, log }
}

/** Every `tags` payload attached to a warn line whose message matches. */
function warnTagsFor(log: LogSpy, fragment: string): unknown[] {
  return log.warn.mock.calls
    .filter((call) => typeof call[0] === 'string' && call[0].includes(fragment))
    .map((call) => (call[1] as { tags?: unknown } | undefined)?.tags)
}

// ── Tests ────────────────────────────────────────────────────────────

describe('catalog reconcile — one failing device does not cost the fleet its catalog', () => {
  it('publishes every other camera and omits ONLY the one whose pull threw', async () => {
    const { api } = makeApi([101, 102, 3629], new Set([3629]))
    const { manager } = makeHarness(api)

    await manager.reconcileAllCatalogs()

    expect(manager.getCameraStreamsForDevice(101).map((s) => s.camStreamId)).toEqual([
      'native:main',
    ])
    expect(manager.getCameraStreamsForDevice(102).map((s) => s.camStreamId)).toEqual([
      'native:main',
    ])
    expect(manager.getCameraStreamsForDevice(3629)).toEqual([])
  })

  it('REPORTS the omission with the failing device numeric id in `tags.deviceId`', async () => {
    const { api } = makeApi([101, 102, 3629], new Set([3629]))
    const { manager, log } = makeHarness(api)

    await manager.reconcileAllCatalogs()

    const tags = warnTagsFor(log, 'stream-catalog pull failed')
    expect(tags).toEqual([{ deviceId: 3629 }])
  })

  it('says nothing about the healthy cameras', async () => {
    const { api } = makeApi([101, 102, 3629], new Set([3629]))
    const { manager, log } = makeHarness(api)

    await manager.reconcileAllCatalogs()

    const tags = warnTagsFor(log, 'stream-catalog pull failed')
    expect(tags).not.toContainEqual({ deviceId: 101 })
    expect(tags).not.toContainEqual({ deviceId: 102 })
  })
})

describe('catalog reconcile — the retry for a failing device is bounded', () => {
  it('does not re-pull a just-failed device on the very next poll tick', async () => {
    const { api, getCatalog } = makeApi([3629], new Set([3629]))
    const { manager } = makeHarness(api)

    await manager.reconcileAllCatalogs()
    await manager.reconcileAllCatalogs()
    await manager.reconcileAllCatalogs()

    // Three poll ticks, one pull: the first failure armed the ladder and the
    // 15 s first rung had not elapsed.
    expect(getCatalog).toHaveBeenCalledTimes(1)
  })

  it('asks a permanently-broken camera a handful of times over 24 h, not 2880', async () => {
    vi.useFakeTimers()
    const base = Date.UTC(2026, 7, 25, 0, 0, 0)
    vi.setSystemTime(base)
    const { api, getCatalog } = makeApi([3629], new Set([3629]))
    const { manager } = makeHarness(api)

    // 24 hours of the real 30 s reconcile poll.
    const TICKS = (24 * 60 * 60) / 30
    for (let tick = 0; tick < TICKS; tick++) {
      vi.setSystemTime(base + tick * 30_000)
      await manager.reconcileDeviceCatalog(3629, 'poll')
    }

    // Ladder is 15 s, 60 s, 5 m, 15 m, 30 m, 60 m, then 90 m repeating:
    // 6 rungs inside the first ~1 h 51 m, then ~14 more at the 90 m floor.
    expect(getCatalog.mock.calls.length).toBeGreaterThan(1)
    expect(getCatalog.mock.calls.length).toBeLessThanOrEqual(24)
    expect(getCatalog.mock.calls.length).toBeLessThan(TICKS / 100)
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})

describe('catalog reconcile — the backoff never swallows new information', () => {
  let harness: Harness
  let getCatalog: ReturnType<typeof vi.fn>

  beforeEach(() => {
    const fixture = makeApi([3629], new Set([3629]))
    getCatalog = fixture.getCatalog
    harness = makeHarness(fixture.api)
  })

  it('an EVENT-driven reconcile pulls even while the device is on a backoff rung', async () => {
    await harness.manager.reconcileAllCatalogs()
    expect(getCatalog).toHaveBeenCalledTimes(1)

    // `StreamParamsChanged` / `DeviceRegistered` reach the default trigger.
    await harness.manager.reconcileDeviceCatalog(3629)

    expect(getCatalog).toHaveBeenCalledTimes(2)
  })
})

describe('catalog reconcile — recovery is announced', () => {
  it('publishes the catalog and logs the recovery once the pull succeeds again', async () => {
    let broken = true
    const getCatalog = vi.fn(async () => {
      if (broken) throw new Error('Baichuan request failed (responseCode 400, empty body)')
      return [MAIN_DESCRIPTOR]
    })
    const api = {
      deviceManager: {
        listAll: {
          query: vi.fn(async () => [{ id: 3629, type: 'camera', isCamera: true, disabled: false }]),
        },
      },
      streamCatalog: { getCatalog: { query: getCatalog } },
    } as unknown as AddonApi
    const { manager, log } = makeHarness(api)

    await manager.reconcileAllCatalogs()
    expect(manager.getCameraStreamsForDevice(3629)).toEqual([])

    broken = false
    await manager.reconcileDeviceCatalog(3629)

    expect(manager.getCameraStreamsForDevice(3629).map((s) => s.camStreamId)).toEqual([
      'native:main',
    ])
    const recovery = log.info.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('stream-catalog pull recovered'),
    )
    expect(recovery).toHaveLength(1)
    expect((recovery[0]?.[1] as { tags?: unknown } | undefined)?.tags).toEqual({ deviceId: 3629 })
  })
})

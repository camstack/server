/**
 * A camera that left the fleet without a `DeviceUnregistered` must not stay
 * DIALLED forever (D685).
 *
 * Since D685 a provider no longer retracts its streams from `removeDevice()`
 * (that hook also runs on every runner restart), so the operator's delete
 * reaches the broker through ONE event — and events may be dropped (D8/D11).
 * A leftover cam stream is not idle: `high` is default-warm, its prebuffer
 * hold dials the camera with no consumer at all. So the 30 s catalog poll,
 * which already reads the fleet, retracts and purges a device whose streams
 * are registered but which is ABSENT from that listing — and only when two
 * consecutive successful reads agree (D49): never on a failed read, never on
 * an empty one, and a reappearance cancels the pending sweep.
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

interface LogSpy {
  readonly logger: IScopedLogger
  readonly warn: ReturnType<typeof vi.fn>
}

function makeLogger(): LogSpy {
  const warn = vi.fn()
  const l: IScopedLogger = {
    info: vi.fn(),
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return { logger: l, warn }
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

const DELETED = 3217
const ALIVE = 101
/** The poll's cadence: the second agreeing read must be at least this late. */
const POLL_MS = 30_000

/** One answer of `deviceManager.listAll`: the fleet, or a failed read. */
type FleetRead = readonly number[] | 'throws'

interface Harness {
  readonly manager: StreamBrokerManager
  readonly log: LogSpy
  /** Queue the answers the next polls get, in order. */
  readonly nextReads: (reads: readonly FleetRead[]) => void
}

function makeHarness(): Harness {
  let queue: FleetRead[] = [[ALIVE, DELETED]]
  let last: FleetRead = [ALIVE, DELETED]
  const listAll = vi.fn(async () => {
    const read = queue.shift() ?? last
    last = read
    if (read === 'throws') throw new Error('deviceManager.listAll: UDS timeout')
    return read.map((id) => ({ id, type: 'camera', isCamera: true, disabled: false }))
  })
  const getCatalog = vi.fn(async () => [
    { camStreamId: 'native:main', kind: 'pull-rtsp', url: 'rtsp://camera/main' },
  ])
  const api = {
    deviceManager: { listAll: { query: listAll } },
    streamCatalog: { getCatalog: { query: getCatalog } },
  } as unknown as AddonApi
  const log = makeLogger()
  const manager = new StreamBrokerManager(log.logger)
  stubRtsp(manager)
  manager.setApiAccess(api)
  return {
    manager,
    log,
    nextReads: (reads) => {
      queue = [...reads]
    },
  }
}

async function slotsOf(manager: StreamBrokerManager, deviceId: number): Promise<number> {
  return (await manager.listAllProfileSlots()).filter((s) => s.deviceId === deviceId).length
}

/** One poll tick later, on the wall clock the sweep reads. */
function tick(): void {
  vi.setSystemTime(Date.now() + POLL_MS)
}

describe('catalog poll — a device that left the fleet is swept on two agreeing reads', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 30, 12, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('retracts AND purges a device absent from two consecutive successful reads', async () => {
    const h = makeHarness()
    await h.manager.reconcileAllCatalogs()
    expect(h.manager.getCameraStreamsForDevice(DELETED)).toHaveLength(1)

    h.nextReads([[ALIVE], [ALIVE]])
    await h.manager.reconcileAllCatalogs()
    // One read is not a verdict.
    expect(h.manager.getCameraStreamsForDevice(DELETED)).toHaveLength(1)

    tick()
    await h.manager.reconcileAllCatalogs()
    expect(h.manager.getCameraStreamsForDevice(DELETED)).toEqual([])
    expect(await slotsOf(h.manager, DELETED)).toBe(0)
    // …and nothing else moved.
    expect(h.manager.getCameraStreamsForDevice(ALIVE)).toHaveLength(1)

    const swept = h.log.warn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('left the fleet'),
    )
    expect(swept).toHaveLength(1)
    expect(swept[0]![1]).toMatchObject({ tags: { deviceId: DELETED } })
  })

  it('does nothing when the device reappears between the two reads', async () => {
    const h = makeHarness()
    await h.manager.reconcileAllCatalogs()

    h.nextReads([[ALIVE], [ALIVE, DELETED], [ALIVE]])
    await h.manager.reconcileAllCatalogs()
    tick()
    await h.manager.reconcileAllCatalogs()
    tick()
    // The reappearance cancelled the first miss: this is a FIRST miss again.
    await h.manager.reconcileAllCatalogs()

    expect(h.manager.getCameraStreamsForDevice(DELETED)).toHaveLength(1)
    expect(await slotsOf(h.manager, DELETED)).toBeGreaterThan(0)
  })

  it('never sweeps on a failed read or an EMPTY one (D49)', async () => {
    const h = makeHarness()
    await h.manager.reconcileAllCatalogs()

    h.nextReads(['throws', 'throws', [], [], 'throws', []])
    for (let i = 0; i < 6; i++) {
      tick()
      await h.manager.reconcileAllCatalogs()
    }

    expect(h.manager.getCameraStreamsForDevice(DELETED)).toHaveLength(1)
    expect(h.manager.getCameraStreamsForDevice(ALIVE)).toHaveLength(1)
  })

  it('does not count two reads closer than one poll interval — startup passes and overlapping polls', async () => {
    const h = makeHarness()
    await h.manager.reconcileAllCatalogs()

    // `reconcileAllCatalogsAtStartup` re-runs 1.5 s apart, and the 30 s poll is
    // not single-flight: two reads that close are one observation.
    h.nextReads([[ALIVE], [ALIVE], [ALIVE]])
    await h.manager.reconcileAllCatalogs()
    vi.setSystemTime(Date.now() + 1_500)
    await h.manager.reconcileAllCatalogs()
    expect(h.manager.getCameraStreamsForDevice(DELETED)).toHaveLength(1)

    // A full interval after the FIRST mark, the agreeing read is a verdict.
    vi.setSystemTime(Date.now() + POLL_MS - 1_500)
    await h.manager.reconcileAllCatalogs()
    expect(h.manager.getCameraStreamsForDevice(DELETED)).toEqual([])
  })

  it('forgets a mark whose device lost its streams another way', async () => {
    const h = makeHarness()
    await h.manager.reconcileAllCatalogs()

    h.nextReads([[ALIVE], [ALIVE], [ALIVE]])
    await h.manager.reconcileAllCatalogs() // marks DELETED
    // Its streams go by another path (the DeviceUnregistered retract)…
    await h.manager.retractDevice(DELETED, { preserveAssignments: true, purgeAssignments: true })
    tick()
    await h.manager.reconcileAllCatalogs() // …so this read must DROP the stale mark.

    // Streams under that id come back while the listing still lacks it. With a
    // stale mark this read would retract at once; it may only mark.
    await h.manager.publishCameraStream({
      deviceId: DELETED,
      camStreamId: 'native:main',
      kind: 'pull-rtsp',
      url: 'rtsp://camera/main',
    })
    tick()
    await h.manager.reconcileAllCatalogs()
    expect(h.manager.getCameraStreamsForDevice(DELETED)).toHaveLength(1)
  })
})

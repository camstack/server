/**
 * A stream is retracted only when two catalog pulls AGREE it is gone (D689).
 *
 * The catalog reconcile used to retract a provider stream after ONE pull that
 * omitted it. That pull is a fallible read of another process — a provider
 * mid-restart, a camera answering half its channels — and the retract it
 * drives DESTROYS work: the broker, its restreamer, every recording writer and
 * viewer attached to it. So an omission only MARKS the stream; the retract
 * needs a later successful pull, at least one reconcile interval after the
 * mark, to agree (D49). A pull that fails decides nothing, a pull that answers
 * nothing at all (`null`) is not "no streams", and a stream that reappears is
 * unmarked.
 *
 * An answered EMPTY catalog decides nothing either: providers answer `[]` both
 * for "not mine" and for "don't know yet" (a sleeping Reolink battery camera,
 * a rebooting Hikvision). It neither marks nor clears.
 */
import type { AddonApi, CamStreamDescriptor, IScopedLogger } from '@camstack/types'
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

const DEVICE = 101
/** The reconcile cadence: the agreeing pull must be at least this late. */
const POLL_MS = 30_000

const MAIN: CamStreamDescriptor = {
  camStreamId: 'stream-1',
  kind: 'pull-rtsp',
  url: 'rtsp://camera/main',
  resolution: { width: 1920, height: 1080 },
}
const SUB: CamStreamDescriptor = {
  camStreamId: 'stream-2',
  kind: 'pull-rtsp',
  url: 'rtsp://camera/sub',
  resolution: { width: 640, height: 360 },
}

/** One answer of `stream-catalog.getCatalog`: descriptors, `null`, or a failure. */
type CatalogPull = readonly CamStreamDescriptor[] | null | 'throws'

/** One answer of `deviceManager.listAll` for {@link DEVICE}. */
type FleetState = 'enabled' | 'disabled'

interface Harness {
  readonly manager: StreamBrokerManager
  readonly log: LogSpy
  /** Queue the answers the next catalog pulls get, in order; the last repeats. */
  readonly nextPulls: (pulls: readonly CatalogPull[]) => void
  readonly setFleet: (state: FleetState) => void
}

function makeHarness(): Harness {
  let queue: CatalogPull[] = []
  let last: CatalogPull = [MAIN, SUB]
  let fleet: FleetState = 'enabled'
  const getCatalog = vi.fn(async () => {
    // NOT `??`: a queued `null` answer is a value under test, not "queue empty".
    const pull = queue.length > 0 ? queue.shift()! : last
    last = pull
    if (pull === 'throws') throw new Error('stream-catalog.getCatalog timed out for device 101')
    return pull
  })
  const listAll = vi.fn(async () => [
    { id: DEVICE, type: 'camera', isCamera: true, disabled: fleet === 'disabled' },
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
    nextPulls: (pulls) => {
      queue = [...pulls]
    },
    setFleet: (state) => {
      fleet = state
    },
  }
}

function streamIds(manager: StreamBrokerManager): readonly string[] {
  return manager
    .getCameraStreamsForDevice(DEVICE)
    .map((s) => s.camStreamId)
    .toSorted()
}

/** One reconcile interval later, on the wall clock the reconcile reads. */
function tick(ms = POLL_MS): void {
  vi.setSystemTime(Date.now() + ms)
}

function retractionWarnings(log: LogSpy): readonly (readonly unknown[])[] {
  return log.warn.mock.calls.filter(
    (call) => typeof call[0] === 'string' && call[0].includes('absent from two catalog pulls'),
  )
}

describe('catalog reconcile — a stream is retracted only on two agreeing pulls (D689)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 30, 12, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('keeps a stream ONE pull omitted, and retracts it when a pull a full interval later agrees', async () => {
    const h = makeHarness()
    await h.manager.reconcileDeviceCatalog(DEVICE)
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])

    h.nextPulls([[MAIN], [MAIN]])
    await h.manager.reconcileDeviceCatalog(DEVICE)
    // One read is not a verdict.
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])

    tick()
    await h.manager.reconcileDeviceCatalog(DEVICE)
    expect(streamIds(h.manager)).toEqual(['stream-1'])

    const warned = retractionWarnings(h.log)
    expect(warned).toHaveLength(1)
    expect(warned[0]![1]).toMatchObject({
      tags: { deviceId: DEVICE },
      meta: { camStreamId: 'stream-2' },
    })
  })

  it('unmarks a stream that reappears between the two pulls', async () => {
    const h = makeHarness()
    await h.manager.reconcileDeviceCatalog(DEVICE)

    h.nextPulls([[MAIN], [MAIN, SUB], [MAIN]])
    await h.manager.reconcileDeviceCatalog(DEVICE) // marks stream-2
    tick()
    await h.manager.reconcileDeviceCatalog(DEVICE) // back: unmarked
    tick()
    await h.manager.reconcileDeviceCatalog(DEVICE) // a FIRST omission again
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])

    tick()
    await h.manager.reconcileDeviceCatalog(DEVICE)
    expect(streamIds(h.manager)).toEqual(['stream-1'])
  })

  it('never retracts on a FAILED pull, however many', async () => {
    const h = makeHarness()
    await h.manager.reconcileDeviceCatalog(DEVICE)

    h.nextPulls(['throws'])
    for (let i = 0; i < 5; i++) {
      tick()
      await h.manager.reconcileDeviceCatalog(DEVICE)
    }
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])
  })

  it('never retracts on a pull that answered NOTHING (null) — unknown is not empty', async () => {
    const h = makeHarness()
    await h.manager.reconcileDeviceCatalog(DEVICE)

    h.nextPulls([null])
    for (let i = 0; i < 5; i++) {
      tick()
      await h.manager.reconcileDeviceCatalog(DEVICE)
    }
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])
  })

  it('does not count two pulls closer than one interval — an event pull next to a poll', async () => {
    const h = makeHarness()
    await h.manager.reconcileDeviceCatalog(DEVICE)

    h.nextPulls([[MAIN]])
    await h.manager.reconcileDeviceCatalog(DEVICE)
    tick(1_500)
    await h.manager.reconcileDeviceCatalog(DEVICE)
    tick(POLL_MS - 1_501)
    await h.manager.reconcileDeviceCatalog(DEVICE)
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])

    // A full interval after the FIRST mark, the agreeing pull is a verdict.
    tick(1)
    await h.manager.reconcileDeviceCatalog(DEVICE)
    expect(streamIds(h.manager)).toEqual(['stream-1'])
  })

  it('never retracts on an ANSWERED empty catalog, however many — "not mine" and "not yet" answer []', async () => {
    const h = makeHarness()
    await h.manager.reconcileDeviceCatalog(DEVICE)

    h.nextPulls([[]])
    for (let i = 0; i < 5; i++) {
      tick()
      await h.manager.reconcileDeviceCatalog(DEVICE)
    }
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])
    expect(retractionWarnings(h.log)).toHaveLength(0)
  })

  it('an empty, failed or null pull between two omitting pulls neither marks nor clears', async () => {
    const h = makeHarness()
    await h.manager.reconcileDeviceCatalog(DEVICE)

    h.nextPulls([[MAIN], [], 'throws', null, [MAIN]])
    await h.manager.reconcileDeviceCatalog(DEVICE) // marks stream-2
    tick()
    await h.manager.reconcileDeviceCatalog(DEVICE) // [] — nothing (does not clear)
    tick()
    await h.manager.reconcileDeviceCatalog(DEVICE) // failed — nothing
    tick()
    await h.manager.reconcileDeviceCatalog(DEVICE) // null — nothing
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])
    tick()
    await h.manager.reconcileDeviceCatalog(DEVICE) // the second omitting pull agrees
    expect(streamIds(h.manager)).toEqual(['stream-1'])
  })

  it('a camera disabled in between forgets its marks — re-enabled, it starts from one observation', async () => {
    const h = makeHarness()
    await h.manager.reconcileAllCatalogs()

    h.nextPulls([[MAIN]])
    await h.manager.reconcileAllCatalogs() // marks stream-2
    h.setFleet('disabled')
    tick()
    await h.manager.reconcileAllCatalogs() // disabled: no pull
    h.setFleet('enabled')
    tick()
    await h.manager.reconcileAllCatalogs() // a FIRST omission after re-enable
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])

    tick()
    await h.manager.reconcileAllCatalogs()
    expect(streamIds(h.manager)).toEqual(['stream-1'])
  })

  it('a stream retracted another way and published again starts unmarked', async () => {
    const h = makeHarness()
    await h.manager.reconcileDeviceCatalog(DEVICE)

    h.nextPulls([[MAIN]])
    await h.manager.reconcileDeviceCatalog(DEVICE) // marks stream-2
    await h.manager.retractCameraStream({ deviceId: DEVICE, camStreamId: 'stream-2' })
    await h.manager.publishCameraStream({ deviceId: DEVICE, ...SUB })
    tick()
    // With a stale mark this pull would retract at once; it may only mark.
    await h.manager.reconcileDeviceCatalog(DEVICE)
    expect(streamIds(h.manager)).toEqual(['stream-1', 'stream-2'])
  })
})

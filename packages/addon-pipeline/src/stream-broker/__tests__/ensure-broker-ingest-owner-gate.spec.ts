/**
 * ensureBroker ingest-owner dormancy gate (FIX #1b).
 *
 * A PHYSICAL-source broker may only be created on the node that owns the
 * camera's source pull (`clusterRoles.ingestNode`, via `getIngestOwner`).
 * On a non-owner node the reconcile MUST NOT build a local physical broker —
 * otherwise a consumer attaching to it would dial the camera a second time
 * (double-pull; observed as Hikvision SETUP 453 storms in the ingest=agent
 * live test).
 *
 * Verifies:
 *   1. self === owner (hub) → the reconcile creates the physical broker.
 *   2. self !== owner (agent, owner=hub) → zero physical brokers created,
 *      even though the cam-stream catalog IS published.
 *   3. getIngestOwner unavailable + no cache + no pushed event → FAIL-OPEN
 *      (never starve the usual owner; FIX #2 fail-open, was fail-closed).
 *   4. FIX #2 — ownership PUSHED via PipelineIngestOwnerChanged gates the
 *      broker with NO getIngestOwner query (hot path is a pure cache read).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'
import { EventCategory, createEvent } from '@camstack/types'
import type { AddonApi, IEventBus, IScopedLogger, CamStreamDescriptor } from '@camstack/types'

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

const MAIN_DESCRIPTOR: CamStreamDescriptor = {
  camStreamId: 'native:main',
  kind: 'pull-rtsp',
  url: 'rtsp://example/main',
}

/**
 * Fake AddonApi: one camera, one catalog batch, and a `getIngestOwner` that
 * resolves to `ingestOwner` (or throws when `throwOwner` is set).
 */
function makeApi(ingestOwner: string | undefined, throwOwner = false): AddonApi {
  return {
    deviceManager: {
      listAll: {
        query: vi.fn(async () => [{ id: 1, type: 'camera', isCamera: true, disabled: false }]),
      },
    },
    streamCatalog: {
      getCatalog: { query: vi.fn(async () => [MAIN_DESCRIPTOR]) },
    },
    pipelineOrchestrator: {
      getIngestOwner: {
        query: vi.fn(async () => {
          if (throwOwner) throw new Error('cap not mounted')
          return { ownerNodeId: ingestOwner }
        }),
      },
    },
  } as unknown as AddonApi
}

function brokerCount(manager: StreamBrokerManager): number {
  return (manager as unknown as { brokers: Map<string, unknown> }).brokers.size
}

/**
 * Minimal event bus whose only live path is delivering
 * `PipelineIngestOwnerChanged` to the manager's subscriber. `emitIngestOwner`
 * drives the pushed-ownership path the manager subscribes to in `setEventBus`.
 */
function makeFakeBus(): {
  bus: IEventBus
  emitIngestOwner: (ownerNodeId: string) => void
} {
  const ingestHandlers: Array<(e: unknown) => void> = []
  const bus = {
    subscribe: (filter: { category?: unknown }, handler: (e: unknown) => void): (() => void) => {
      if (filter.category === EventCategory.PipelineIngestOwnerChanged) ingestHandlers.push(handler)
      return () => {}
    },
    emit: () => {},
  } as unknown as IEventBus
  const emitIngestOwner = (ownerNodeId: string): void => {
    const evt = createEvent(
      EventCategory.PipelineIngestOwnerChanged,
      { type: 'addon', id: 'pipeline-orchestrator', nodeId: 'hub' },
      { ownerNodeId },
    )
    for (const h of ingestHandlers) h(evt)
  }
  return { bus, emitIngestOwner }
}

/** Await the manager's most recent ownership-change teardown reconcile. */
async function ownershipReconcile(manager: StreamBrokerManager): Promise<void> {
  await (manager as unknown as { lastOwnershipReconcile: Promise<void> }).lastOwnershipReconcile
}

/** Read the private getIngestOwner query spy off a fake AddonApi. */
function ingestQuerySpy(api: AddonApi): ReturnType<typeof vi.fn> {
  return (
    api as unknown as {
      pipelineOrchestrator: { getIngestOwner: { query: ReturnType<typeof vi.fn> } }
    }
  ).pipelineOrchestrator.getIngestOwner.query
}

describe('ensureBroker ingest-owner dormancy gate', () => {
  let manager: StreamBrokerManager

  beforeEach(() => {
    manager = makeManager()
  })

  afterEach(() => {
    // setEventBus starts a stream-health interval — clear it so the timer
    // doesn't leak across tests.
    const timer = (manager as unknown as { streamHealthTimer?: ReturnType<typeof setInterval> })
      .streamHealthTimer
    if (timer) clearInterval(timer)
  })

  it('self IS the ingest owner (hub) → creates the physical broker', async () => {
    manager.setApiAccess(makeApi('hub'), 'hub')
    await manager.reconcileAllCatalogsAtStartup(2, 1)
    expect(manager.getCameraStreamsForDevice(1).map((s) => s.camStreamId)).toContain('native:main')
    expect(brokerCount(manager)).toBe(1)
  })

  it('self is NOT the ingest owner (agent, owner=hub) → zero physical brokers, catalog still published', async () => {
    manager.setApiAccess(makeApi('hub'), 'agent-a')
    await manager.reconcileAllCatalogsAtStartup(2, 1)
    // Catalog IS published (the cam-stream registry is node-agnostic)...
    expect(manager.getCameraStreamsForDevice(1).map((s) => s.camStreamId)).toContain('native:main')
    // ...but NO local physical broker was created — dormant on the non-owner node.
    expect(brokerCount(manager)).toBe(0)
  })

  it('getIngestOwner unavailable + no cache + no pushed event → FAIL-OPEN (never starve the owner)', async () => {
    // Cold start with the orchestrator not yet answering (FIX #1 makes this a
    // fast precise error, not a 30s hang). We fail-OPEN: allow the broker so the
    // usual owner (hub) is never starved of prebuffer/recording. A rare transient
    // double-pull self-heals on the next pushed PipelineIngestOwnerChanged.
    manager.setApiAccess(makeApi(undefined, true), 'agent-a')
    await manager.reconcileAllCatalogsAtStartup(2, 1)
    expect(brokerCount(manager)).toBe(1)
  })

  it('agent IS the ingest owner (ingest-off-hub) → creates the physical broker', async () => {
    manager.setApiAccess(makeApi('agent-a'), 'agent-a')
    await manager.reconcileAllCatalogsAtStartup(2, 1)
    expect(brokerCount(manager)).toBe(1)
  })

  // --- Event-driven ownership (FIX #2): the gate reads the pushed owner and
  //     never queries getIngestOwner on the hot path. ---

  it('pushed owner = self → creates the broker WITHOUT a getIngestOwner query', async () => {
    const { bus, emitIngestOwner } = makeFakeBus()
    const api = makeApi('hub') // query would say hub, but it must NOT be consulted
    manager.setEventBus(bus)
    manager.setApiAccess(api, 'agent-a')
    // Orchestrator pushes: agent-a IS the owner.
    emitIngestOwner('agent-a')

    await manager.reconcileAllCatalogsAtStartup(2, 1)

    expect(brokerCount(manager)).toBe(1)
    expect(ingestQuerySpy(api)).not.toHaveBeenCalled()
  })

  it('pushed owner = other node → stays dormant WITHOUT a getIngestOwner query', async () => {
    const { bus, emitIngestOwner } = makeFakeBus()
    const api = makeApi('agent-a') // query would (wrongly) say self — must be ignored
    manager.setEventBus(bus)
    manager.setApiAccess(api, 'agent-a')
    // Orchestrator pushes: the HUB is the owner, not this agent.
    emitIngestOwner('hub')

    await manager.reconcileAllCatalogsAtStartup(2, 1)

    expect(brokerCount(manager)).toBe(0)
    expect(ingestQuerySpy(api)).not.toHaveBeenCalled()
  })

  it('a later pushed flip to self flips the gate open (no query)', async () => {
    const { bus, emitIngestOwner } = makeFakeBus()
    const api = makeApi('hub')
    manager.setEventBus(bus)
    manager.setApiAccess(api, 'agent-a')

    emitIngestOwner('hub') // not owner yet
    await manager.reconcileAllCatalogsAtStartup(2, 1)
    expect(brokerCount(manager)).toBe(0)

    emitIngestOwner('agent-a') // flip: now this agent is the owner
    await manager.reconcileAllCatalogsAtStartup(2, 1)
    expect(brokerCount(manager)).toBe(1)
    expect(ingestQuerySpy(api)).not.toHaveBeenCalled()
  })

  // --- Reverse-flip teardown (FIX #3): losing ownership drops local physical
  //     brokers so the old owner stops dialing (no lingering double-pull). ---

  it('flip AWAY from self tears down the local physical brokers (stops dialing)', async () => {
    const { bus, emitIngestOwner } = makeFakeBus()
    const api = makeApi('agent-a')
    manager.setEventBus(bus)
    manager.setApiAccess(api, 'agent-a')

    // This agent is the owner → creates the physical broker (dialing).
    emitIngestOwner('agent-a')
    await manager.reconcileAllCatalogsAtStartup(2, 1)
    expect(brokerCount(manager)).toBe(1)

    // Ingest flips to the hub → this agent must drop its physical broker.
    emitIngestOwner('hub')
    await ownershipReconcile(manager)
    expect(brokerCount(manager)).toBe(0)
  })

  it('a same-owner re-emit while non-owner is a cheap no-op (no brokers to tear down)', async () => {
    const { bus, emitIngestOwner } = makeFakeBus()
    const api = makeApi('agent-a')
    manager.setEventBus(bus)
    manager.setApiAccess(api, 'agent-a')

    emitIngestOwner('hub') // non-owner from the start → no brokers
    await manager.reconcileAllCatalogsAtStartup(2, 1)
    expect(brokerCount(manager)).toBe(0)

    // Repeated topology re-emits (agent online/offline) must not throw / churn.
    emitIngestOwner('hub')
    await ownershipReconcile(manager)
    expect(brokerCount(manager)).toBe(0)
  })
})

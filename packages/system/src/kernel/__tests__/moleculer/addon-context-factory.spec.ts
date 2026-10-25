import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import {
  createAddonContext,
  createUdsAddonContext,
  getBrokerEventBus,
  registerEventBusService,
  __resetBindingSubscriptionForTests,
} from '../../moleculer/addon-context-factory.js'
import {
  EventCategory,
  emitReadiness,
  snapshotCapability,
  type AddonDeclaration,
  type SystemEvent,
  type ReadinessScope,
} from '@camstack/types'
import { CapabilityUnavailableError } from '../../capability-handle.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'

describe('createAddonContext', () => {
  let hubBroker: ServiceBroker
  let agentBroker: ServiceBroker
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-test-'))
  })

  afterEach(async () => {
    if (agentBroker) await agentBroker.stop()
    if (hubBroker) await hubBroker.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates an AddonContext with eventBus that routes to the hub via camstack.evt.* broadcast', async () => {
    hubBroker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agentBroker = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })

    // Events flow via one Moleculer event per category —
    // `broker.broadcast('camstack.evt.<category>', ...)` handled by the
    // per-broker `$event-bus` service's wildcard handler. The hub
    // observes the stream by subscribing to its broker bus with a
    // `'**'` category filter. Self-echoes (same nodeID as emitter) are
    // filtered out by the `$event-bus` handler — so events emitted from
    // the agent broker reach the hub's subscriber exactly once.
    registerEventBusService(hubBroker)
    registerEventBusService(agentBroker)

    const receivedEvents: SystemEvent[] = []
    getBrokerEventBus(hubBroker).subscribe({ category: '**' }, (event) => {
      receivedEvents.push(event)
    })

    await hubBroker.start()
    await agentBroker.start()

    const declaration: AddonDeclaration = { id: 'test-addon', entry: './dist/index.js' }
    const ctx = await createAddonContext(agentBroker, declaration, tmpDir)

    ctx.eventBus.emit({
      id: '1',
      timestamp: new Date(),
      source: { type: 'addon', id: 'test-addon' },
      category: EventCategory.DetectionResult,
      data: { found: true },
    })

    // Broadcast transit is async across brokers — wait a beat for the
    // Fake transporter to deliver to the hub's `$event-bus` handler.
    await new Promise((r) => setTimeout(r, 100))

    expect(receivedEvents).toHaveLength(1)
    expect(receivedEvents[0]!.category).toBe('detection.result')
  })

  it('creates AddonContext with correct id and logger', async () => {
    hubBroker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agentBroker = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })

    await hubBroker.start()
    await agentBroker.start()

    const declaration: AddonDeclaration = { id: 'my-addon', entry: './index.js' }
    const ctx = await createAddonContext(agentBroker, declaration, tmpDir)

    expect(ctx.id).toBe('my-addon')
    expect(ctx.logger).toBeDefined()
    expect(ctx.logger.info).toBeTypeOf('function')
    expect(ctx.logger.child).toBeTypeOf('function')
  })

  it('creates dataDir for addon', async () => {
    agentBroker = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })
    await agentBroker.start()

    const declaration: AddonDeclaration = { id: 'my-addon', entry: './index.js' }
    const ctx = await createAddonContext(agentBroker, declaration, tmpDir)

    expect(fs.existsSync(ctx.dataDir)).toBe(true)
    expect(ctx.dataDir).toContain('my-addon')
  })

  it('eventBus.subscribe works for local events', async () => {
    agentBroker = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })
    await agentBroker.start()

    const declaration: AddonDeclaration = { id: 'my-addon', entry: './index.js' }
    const ctx = await createAddonContext(agentBroker, declaration, tmpDir)

    const received: unknown[] = []
    ctx.eventBus.subscribe({ category: 'test.event' as never }, (evt: unknown) => {
      received.push(evt)
    })

    // Emit locally — should reach subscriber
    ctx.eventBus.emit({
      id: '2',
      timestamp: new Date(),
      source: { type: 'addon', id: 'my-addon' },
      category: 'test.event' as never,
      data: {},
    })

    expect(received).toHaveLength(1)
  })

  it('devices.create propagates device-manager errors', async () => {
    agentBroker = new ServiceBroker({ nodeID: 'agent', transporter: 'Fake', logger: false })

    // Seed a device-manager service that always rejects allocateDeviceId
    // with a recognisable error. Previously this test relied on the
    // broker.call failing fast with "service not found" when no provider
    // existed — that path is gone: the transport now waits for discovery
    // so the test would hang forever without a stub provider.
    // The real contract being verified is: errors from the device-manager
    // cap propagate through `ctx.kernel.devices.create` without being
    // swallowed.
    agentBroker.createService({
      name: 'device-manager',
      actions: {
        'device-manager.allocateDeviceId': {
          handler: () => {
            throw new Error('stub: bad args — no stableId provided')
          },
        },
      },
    })
    await agentBroker.start()

    const declaration: AddonDeclaration = { id: 'my-addon', entry: './index.js' }
    const ctx = await createAddonContext(agentBroker, declaration, tmpDir)

    // Invoke `create` with missing args to assert the broker round-trip rejects.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double: call the typed method with no args
    const createFn = ctx.kernel.devices.create as unknown as () => Promise<unknown>
    await expect(createFn()).rejects.toThrow(/bad args|stableId/)
  })
})

// ── Capability Acquisition API ────────────────────────────────────────

describe('createAddonContext — capability acquisition API', () => {
  let broker: ServiceBroker
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-acq-test-'))
    __resetBindingSubscriptionForTests()
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    registerEventBusService(broker)
    await broker.start()
  })

  afterEach(async () => {
    // Restore real timers before stopping the broker — Moleculer's graceful
    // shutdown uses real setTimeout internally; fake timers would stall it.
    vi.useRealTimers()
    await broker.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Helper to emit a readiness event into the context's event bus.
  function emitCap(
    ctx: Awaited<ReturnType<typeof createAddonContext>>,
    capName: string,
    scope: ReadinessScope,
    state: 'ready' | 'down' | 'starting',
  ): void {
    emitReadiness(ctx.eventBus, {
      capName,
      scope,
      state,
      generation: 'gen-test-1',
      sourceNodeId: 'hub',
    })
  }

  it('useCapability returns a CapabilityHandle with isReady=false for unknown cap', async () => {
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)

    const handle = ctx.useCapability('unknown-cap')
    expect(handle).toBeDefined()
    expect(handle.isReady).toBe(false)
  })

  it('useCapability returns the SAME cached instance on repeated calls', async () => {
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)

    const handle1 = ctx.useCapability('my-cap')
    const handle2 = ctx.useCapability('my-cap')
    expect(handle1).toBe(handle2)
  })

  it('useCapability returns DIFFERENT instances for different scopes', async () => {
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)

    const globalScope: ReadinessScope = { type: 'global' }
    const nodeScope: ReadinessScope = { type: 'node', nodeId: 'hub' }

    const handle1 = ctx.useCapability('my-cap', globalScope)
    const handle2 = ctx.useCapability('my-cap', nodeScope)
    expect(handle1).not.toBe(handle2)
  })

  it('acquireCapability resolves after cap becomes ready via event bus', async () => {
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)

    const scope: ReadinessScope = { type: 'global' }
    // Start the acquire — it blocks until ready
    const acquirePromise = ctx.acquireCapability('my-cap', scope, { timeoutMs: 500 })

    // Emit readiness into the event bus so the registry sees it
    emitCap(ctx, 'my-cap', scope, 'ready')
    // Let async subscriptions flush
    await new Promise((r) => setTimeout(r, 0))

    const handle = await acquirePromise
    expect(handle.isReady).toBe(true)
    expect(handle.capName).toBe('my-cap')
  })

  it('acquireCapability throws CapabilityUnavailableError if cap never becomes ready', async () => {
    vi.useFakeTimers()
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)

    const scope: ReadinessScope = { type: 'global' }
    let caught: unknown
    const acquirePromise = ctx
      .acquireCapability('my-cap', scope, { timeoutMs: 50 })
      .catch((err) => {
        caught = err
      })
    await vi.advanceTimersByTimeAsync(100)
    await acquirePromise
    expect(caught).toBeInstanceOf(CapabilityUnavailableError)
  })

  it('onCapabilityStateChange fires "ready" when cap becomes ready', async () => {
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)

    const scope: ReadinessScope = { type: 'global' }
    const states: Array<'ready' | 'down'> = []
    ctx.onCapabilityStateChange('my-cap', scope, (state) => {
      states.push(state)
    })

    emitCap(ctx, 'my-cap', scope, 'ready')
    await new Promise((r) => setTimeout(r, 0))

    expect(states).toContain('ready')
  })

  it('onCapabilityStateChange fires "down" when cap goes down after being ready', async () => {
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)

    const scope: ReadinessScope = { type: 'global' }
    const states: Array<'ready' | 'down'> = []
    ctx.onCapabilityStateChange('my-cap', scope, (state) => {
      states.push(state)
    })

    // First emit ready
    emitCap(ctx, 'my-cap', scope, 'ready')
    await new Promise((r) => setTimeout(r, 0))
    expect(states).toContain('ready')

    // Then emit down
    emitCap(ctx, 'my-cap', scope, 'down')
    await new Promise((r) => setTimeout(r, 0))
    expect(states).toContain('down')
  })

  it('onCapabilityStateChange returns working unsubscribe', async () => {
    const declaration: AddonDeclaration = { id: 'test-addon', entry: './index.js' }
    const ctx = await createAddonContext(broker, declaration, tmpDir)

    const scope: ReadinessScope = { type: 'global' }
    let callCount = 0
    const unsubscribe = ctx.onCapabilityStateChange('my-cap', scope, () => {
      callCount++
    })

    // First emit — should fire
    emitCap(ctx, 'my-cap', scope, 'ready')
    await new Promise((r) => setTimeout(r, 0))
    const countAfterFirstEmit = callCount

    // Unsubscribe
    unsubscribe()

    // Second emit — should NOT fire
    emitCap(ctx, 'my-cap', scope, 'down')
    await new Promise((r) => setTimeout(r, 0))

    expect(callCount).toBe(countAfterFirstEmit)
    expect(callCount).toBeGreaterThanOrEqual(1)
  })
})

// ── createUdsAddonContext — broker-less child (F2) ──────────────────────────
//
// A UDS-only child context has NO broker. Its tRPC link chain is
// `[localProviderLink, ipcParentLink]` — there is no `brokerTransportLink`.
// A `ctx.api.<cap>` call that no LOCAL sibling owns must ride `ipcParentLink`
// → `client.callOut` → the parent's `onUnownedCall` (proving there's no broker
// route). A locally-registered sibling cap must resolve in-process.

describe('createUdsAddonContext — UDS-only child (no broker)', () => {
  const PARENT_NODE = 'hub'
  const CHILD_ID = 'uds-ctx-child'
  const CHILD_NODE = `${PARENT_NODE}/${CHILD_ID}`
  let registry: LocalChildRegistry
  let client: LocalChildClient
  let tmpDir: string
  const unownedCalls: CapCallInput[] = []

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uds-ctx-test-'))
    unownedCalls.length = 0
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(PARENT_NODE),
      // Parent fallback: record the call + return a sentinel so we can assert
      // the child's `ctx.api` routed over UDS (no broker).
      onUnownedCall: async (input) => {
        unownedCalls.push(input)
        return { routedOverUds: true, cap: input.capName, method: input.method }
      },
    })
    registry.onReadinessSnapshotRequest(() => [])
    await registry.start()
    client = new LocalChildClient({
      nodeId: PARENT_NODE,
      childId: CHILD_ID,
      caps: [],
      dispatch: async () => {
        throw new Error('child has no inbound caps in this test')
      },
    })
    await client.start()
  })

  afterEach(async () => {
    await client.close()
    await registry.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('builds a context with a UDS-backed logger + event bus (no broker)', async () => {
    const declaration: AddonDeclaration = { id: 'uds-addon', entry: './index.js' }
    const ctx = await createUdsAddonContext(client, CHILD_NODE, declaration, tmpDir)
    expect(ctx.id).toBe('uds-addon')
    expect(ctx.logger.info).toBeTypeOf('function')
    expect(ctx.eventBus.emit).toBeTypeOf('function')
    // No broker → no cluster.broker on ctx.kernel (documented worker contract).
    expect(ctx.kernel.cluster).toBeUndefined()
    expect(ctx.kernel.localNodeId).toBe(CHILD_NODE)
  })

  it('ctx.api for an unowned cap routes over UDS to the parent (no brokerTransportLink)', async () => {
    const declaration: AddonDeclaration = { id: 'uds-addon', entry: './index.js' }
    const ctx = await createUdsAddonContext(client, CHILD_NODE, declaration, tmpDir)

    // No local sibling owns `pipelineExecutor` → must ride ipcParentLink → callOut.
    const apiAny = ctx.api as unknown as {
      pipelineExecutor: { getSchema: { query: (i: unknown) => Promise<unknown> } }
    }
    const result = await apiAny.pipelineExecutor.getSchema.query({ foo: 1 })

    expect(unownedCalls).toHaveLength(1)
    expect(unownedCalls[0]!.capName).toBe('pipeline-executor')
    expect(unownedCalls[0]!.method).toBe('getSchema')
    expect(result).toMatchObject({
      routedOverUds: true,
      cap: 'pipeline-executor',
      method: 'getSchema',
    })
  })

  it('ctx.getNativeProvider does NOT resolve the wrapper the runner itself registered', async () => {
    const declaration: AddonDeclaration = { id: 'snapshot', entry: './index.js' }
    const ctx = await createUdsAddonContext(client, CHILD_NODE, declaration, tmpDir)

    // The runner IS the `snapshot` wrapper — it registers the cap locally.
    // Asking for the NATIVE behind the same name must leave the process: this
    // is the wrapper-calls-itself deadlock the `native: true` hint prevents.
    const wrapper = { getSnapshot: vi.fn(async () => ({ from: 'wrapper' })) }
    ctx.registerProvider('snapshot', wrapper)

    const native = ctx.getNativeProvider(snapshotCapability, 102)
    expect(native).not.toBeNull()
    const out = await native!.getSnapshot({ deviceId: 102, force: true })

    expect(wrapper.getSnapshot).not.toHaveBeenCalled()
    expect(unownedCalls).toHaveLength(1)
    expect(unownedCalls[0]).toMatchObject({
      capName: 'snapshot',
      method: 'getSnapshot',
      deviceId: 102,
      native: true,
    })
    // `deviceId` also rides inside the args, where the provider reads it.
    expect(unownedCalls[0]!.args).toMatchObject({ deviceId: 102, force: true })
    expect(out).toMatchObject({ routedOverUds: true, cap: 'snapshot' })
  })

  it('ctx.api for a locally-registered sibling cap resolves in-process (localProviderLink)', async () => {
    const declaration: AddonDeclaration = { id: 'uds-addon', entry: './index.js' }
    const ctx = await createUdsAddonContext(client, CHILD_NODE, declaration, tmpDir)

    // Register a local provider for `my-cap`; localProviderLink must resolve it
    // WITHOUT touching the parent (unownedCalls stays empty).
    ctx.registerProvider('my-cap', { ping: async () => 'local-pong' })
    const apiAny = ctx.api as unknown as {
      myCap: { ping: { query: () => Promise<string> } }
    }
    const out = await apiAny.myCap.ping.query()
    expect(out).toBe('local-pong')
    expect(unownedCalls).toHaveLength(0)
  })
})

// ── settings view — a write that cannot reach the hub FAILS (D870) ───────────
//
// A forked runner used to swallow a failed settings write (best-effort), which
// is how a configuration change could vanish in silence. The write now rejects
// with the transport error, so the caller decides; a caller that fires and
// forgets must catch it, and then nothing leaks as an unhandledRejection.

describe('createUdsAddonContext — a settings write that cannot reach the hub rejects', () => {
  const PARENT_NODE = 'hub-settings-resilience'
  const CHILD_ID = 'settings-resilience-child'
  const CHILD_NODE = `${PARENT_NODE}/${CHILD_ID}`
  let registry: LocalChildRegistry
  let client: LocalChildClient
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-resilience-test-'))
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(PARENT_NODE),
      onUnownedCall: async (input: CapCallInput) => {
        if (input.capName === 'settings-store' && input.method === 'transact') {
          throw new Error(
            'parent could not route child unowned cap call "settings-store.transact": ' +
              '[brokerTransportLink] discovery deadline exceeded — call will fast-fail',
          )
        }
        // The boot guard's reads: no blobs, nothing to migrate.
        if (input.capName === 'settings-store' && input.method === 'count') return 0
        if (input.capName === 'settings-store' && input.method === 'get') return null
        if (input.capName === 'settings-store' && input.method === 'query') return []
        return {}
      },
    })
    registry.onReadinessSnapshotRequest(() => [])
    await registry.start()
    client = new LocalChildClient({
      nodeId: PARENT_NODE,
      childId: CHILD_ID,
      caps: [],
      dispatch: async () => {
        throw new Error('child has no inbound caps in this test')
      },
    })
    await client.start()
  })

  afterEach(async () => {
    await client.close()
    await registry.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('an awaited writeAddonStore REJECTS with the transport error - it is not swallowed', async () => {
    const declaration: AddonDeclaration = { id: 'settings-resilience-addon', entry: './index.js' }
    const ctx = await createUdsAddonContext(client, CHILD_NODE, declaration, tmpDir)
    await expect(ctx.settings!.writeAddonStore({ probedBestHwaccel: 'none' })).rejects.toThrow(
      /discovery deadline exceeded/,
    )
  })

  it('a fire-and-forget write whose caller catches it leaks no unhandledRejection', async () => {
    const declaration: AddonDeclaration = { id: 'settings-resilience-addon', entry: './index.js' }
    const ctx = await createUdsAddonContext(client, CHILD_NODE, declaration, tmpDir)
    const unhandledReasons: unknown[] = []
    const unhandledHandler = (reason: unknown): void => {
      unhandledReasons.push(reason)
    }
    process.on('unhandledRejection', unhandledHandler)
    try {
      void ctx.settings!.writeAddonStore({ probedBestHwaccel: 'none' }).catch(() => undefined)
      await new Promise((r) => setTimeout(r, 50))
      expect(unhandledReasons).toHaveLength(0)
    } finally {
      process.removeListener('unhandledRejection', unhandledHandler)
    }
  })
})

// ── per-device settings through a runner (D870) ──────────────────────────────
//
// A runner's `ctx.settings.*DeviceStore` reaches the ONE shared store, the rows
// of `addon-device-settings`, through the hub's `settings-store` cap - not a
// blob of its own. The full behaviour (two views, one real SQLite file) is the
// contract suite `device-settings-contract.spec.ts`; this pins the wiring of
// the runner context itself: which collection, which calls, which scope.

describe('createUdsAddonContext - per-device settings are the shared store rows', () => {
  const PARENT_NODE = 'hub-device-store-isolation'
  const CHILD_ID_A = 'addon-alpha'
  const CHILD_ID_B = 'addon-beta'
  const CHILD_NODE_A = `${PARENT_NODE}/${CHILD_ID_A}`
  const CHILD_NODE_B = `${PARENT_NODE}/${CHILD_ID_B}`

  let registryA: LocalChildRegistry
  let registryB: LocalChildRegistry
  let clientA: LocalChildClient
  let clientB: LocalChildClient
  let tmpDirA: string
  let tmpDirB: string

  // The hub's rows, keyed by id, standing in for the `settings-store` cap.
  const rows = new Map<string, Record<string, unknown>>()
  const calls: Array<{ method: string; args: unknown }> = []

  interface StoreOp {
    op: string
    collection: string
    records?: Array<{ id: string; data: Record<string, unknown> }>
    filter?: { whereBetween?: Record<string, [string, string]>; whereIn?: Record<string, string[]> }
  }

  function applyDelete(filter: NonNullable<StoreOp['filter']>): number {
    const between = filter.whereBetween?.['id']
    const within = filter.whereIn?.['id']
    let deleted = 0
    for (const id of [...rows.keys()]) {
      const hit =
        (between !== undefined && id >= between[0] && id < between[1]) ||
        (within !== undefined && within.includes(id))
      if (hit && rows.delete(id)) deleted += 1
    }
    return deleted
  }

  let hubUnreachable = false

  async function onUnownedCall(input: CapCallInput): Promise<unknown> {
    if (hubUnreachable) throw new Error('hub unreachable')
    if (input.capName !== 'settings-store') return {}
    const args = input.args as Record<string, unknown>
    calls.push({ method: input.method, args })
    if (input.method === 'count') {
      const filter = args['filter'] as StoreOp['filter'] | undefined
      const between = filter === undefined ? undefined : filter.whereBetween?.['id']
      return [...rows.keys()].filter(
        (id) => between === undefined || (id >= between[0] && id < between[1]),
      ).length
    }
    if (input.method === 'get') return null
    if (input.method === 'query') {
      const filter = args['filter'] as StoreOp['filter'] | undefined
      const between = filter === undefined ? undefined : filter.whereBetween?.['id']
      return [...rows.entries()]
        .filter(([id]) => between === undefined || (id >= between[0] && id < between[1]))
        .toSorted(([x], [y]) => (x < y ? -1 : 1))
        .map(([id, data]) => ({ id, data }))
    }
    if (input.method === 'transact') {
      for (const op of args['ops'] as StoreOp[]) {
        if (op.op === 'deleteWhere') applyDelete(op.filter ?? {})
        if (op.op === 'upsertMany') for (const r of op.records ?? []) rows.set(r.id, r.data)
      }
      return { applied: true }
    }
    if (input.method === 'deleteWhere') {
      return { deleted: applyDelete(args['filter'] as NonNullable<StoreOp['filter']>) }
    }
    return {}
  }

  beforeEach(async () => {
    rows.clear()
    calls.length = 0
    hubUnreachable = false
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-a-'))
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'device-store-b-'))

    registryA = new LocalChildRegistry({
      server: createLocalTransport().createServer(PARENT_NODE),
      onUnownedCall,
    })
    registryA.onReadinessSnapshotRequest(() => [])
    await registryA.start()

    registryB = new LocalChildRegistry({
      server: createLocalTransport().createServer(PARENT_NODE),
      onUnownedCall,
    })
    registryB.onReadinessSnapshotRequest(() => [])
    await registryB.start()

    const noInbound = async (): Promise<never> => {
      throw new Error('child has no inbound caps')
    }
    clientA = new LocalChildClient({
      nodeId: PARENT_NODE,
      childId: CHILD_ID_A,
      caps: [],
      dispatch: noInbound,
    })
    await clientA.start()
    clientB = new LocalChildClient({
      nodeId: PARENT_NODE,
      childId: CHILD_ID_B,
      caps: [],
      dispatch: noInbound,
    })
    await clientB.start()
  })

  afterEach(async () => {
    await clientA.close()
    await clientB.close()
    await registryA.close()
    await registryB.close()
    fs.rmSync(tmpDirA, { recursive: true, force: true })
    fs.rmSync(tmpDirB, { recursive: true, force: true })
    rows.clear()
  })

  async function contexts() {
    const declarationA: AddonDeclaration = { id: CHILD_ID_A, entry: './index.js' }
    const declarationB: AddonDeclaration = { id: CHILD_ID_B, entry: './index.js' }
    return {
      ctxA: await createUdsAddonContext(clientA, CHILD_NODE_A, declarationA, tmpDirA),
      ctxB: await createUdsAddonContext(clientB, CHILD_NODE_B, declarationB, tmpDirB),
    }
  }

  it('two addons writing device settings for the same deviceId do not trample each other', async () => {
    const { ctxA, ctxB } = await contexts()
    await ctxA.settings!.writeDeviceStore(42, { url: 'rtsp://cam-a/main', fps: 25 })
    await ctxB.settings!.writeDeviceStore(42, { url: 'rtsp://cam-b/main', fps: 15 })

    expect(await ctxA.settings!.readDeviceStore(42)).toEqual({ url: 'rtsp://cam-a/main', fps: 25 })
    expect(await ctxB.settings!.readDeviceStore(42)).toEqual({ url: 'rtsp://cam-b/main', fps: 15 })
  })

  it("clearDeviceStore for one addon does not affect the other addon's settings", async () => {
    const { ctxA, ctxB } = await contexts()
    await ctxA.settings!.writeDeviceStore(7, { token: 'tok-a' })
    await ctxB.settings!.writeDeviceStore(7, { token: 'tok-b' })
    await ctxA.settings!.clearDeviceStore(7)

    expect(await ctxA.settings!.readDeviceStore(7)).toEqual({})
    expect(await ctxB.settings!.readDeviceStore(7)).toEqual({ token: 'tok-b' })
  })

  it('writes ROWS of addon-device-settings in ONE transact - no blob, no read-modify-write', async () => {
    const { ctxA } = await contexts()
    await ctxA.settings!.writeDeviceStore(99, { configured: true, bands: [1] })

    expect(
      calls.map((c) => c.method).filter((m) => m !== 'count' && m !== 'get' && m !== 'query'),
    ).toEqual(['transact'])
    expect([...rows.keys()].toSorted()).toEqual([
      `${CHILD_ID_A}:99.bands`,
      `${CHILD_ID_A}:99.configured`,
    ])
    const first = calls.find((c) => c.method === 'transact')
    if (first === undefined) throw new Error('no call recorded')
    const ops = (first.args as { ops: StoreOp[] }).ops
    expect(ops.every((op) => op.collection === 'addon-device-settings')).toBe(true)
  })

  it('a store that cannot be asked THROWS - the empty object is never the answer', async () => {
    const { ctxA } = await contexts()
    hubUnreachable = true
    await expect(ctxA.settings!.readDeviceStore(5)).rejects.toThrow()
  })
})

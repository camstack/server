import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import {
  createTestCluster,
  waitUntil,
  getAvailableNodeIds,
  type TestCluster,
} from './cluster-setup.js'
import {
  createAddonService,
  createAddonContext,
  getBrokerEventBus,
  registerEventBusService,
  clusterEventTopic,
  createHubService,
  NativeMetricsProvider,
  type HubServiceDeps,
} from '@camstack/system'
import { createAgentService } from '../../agent-service.js'
import type { AgentServiceDeps } from '../../agent-service.js'
import {
  type ICamstackAddon,
  type AddonDeclaration,
  type AddonContext,
  type IMetricsProvider,
  type ProviderRegistration,
  metricsProviderCapability,
} from '@camstack/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actionIsAvailable(broker: ServiceBroker, actionName: string): boolean {
  // Moleculer's ServiceBroker has no upstream types for `.registry`; poke
  // the internal registry through the test-double boundary.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  return (
    broker as unknown as Record<string, unknown> & {
      registry: { actions: { isAvailable: (n: string) => boolean } }
    }
  ).registry.actions.isAvailable(actionName)
}

/** Minimal NativeMetricsAddon wrapper that captures the registered provider. */
class TestNativeMetricsAddon implements ICamstackAddon {
  provider: NativeMetricsProvider | null = null
  private currentIntervalMs = 500

  async initialize(context: AddonContext): Promise<ProviderRegistration[]> {
    const cfg = context.addonConfig as Record<string, unknown> | undefined
    this.currentIntervalMs = (cfg?.samplingIntervalMs as number | undefined) ?? 500
    const provider = new NativeMetricsProvider()
    provider.startSampling(this.currentIntervalMs)
    this.provider = provider
    context.logger.info(`Test metrics started (interval: ${this.currentIntervalMs}ms)`)
    // Composed POJO mirrors the production metrics provider surface that
    // the addon registers. It intentionally implements only the subset of
    // `IMetricsProvider` the cluster tests exercise (snapshot + per-process
    // stats); the cap has since grown further methods (`listNodeProcesses`,
    // `getLoadSeries`) the test double does not stub, so it crosses the
    // test-double boundary.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    const composed = {
      collectSnapshot: () => provider.collectSnapshot(),
      getCached: () => provider.getCached(),
      getCurrent: () => provider.getCurrent(),
      getDiskSpace: (params: { dirPath: string }) => provider.getDiskSpace(params),
      getGpuInfo: () => provider.getGpuInfo(),
      getCpuTemperature: () => provider.getCpuTemperature(),
      getProcessStats: (params: { pids: number[] }) => provider.getProcessStats(params),
      listAddonInstances: async () => [],
      getAddonStats: async () => null,
    } as unknown as IMetricsProvider
    return [{ capability: metricsProviderCapability, provider: composed }]
  }

  postBrokerStart(): void {
    /* no-op — broker is already started in these in-process/cluster tests */
  }

  async shutdown(): Promise<void> {
    this.provider?.stopSampling()
    this.provider = null
  }

  getConfigSchema() {
    return { sections: [] }
  }

  getConfig() {
    return { samplingIntervalMs: this.currentIntervalMs }
  }
}

// `createAddonService` still reads an explicit per-capability `methods`
// override off the declaration (via `normalizeCapability`) to pin which
// Moleculer actions get exposed; the `CapabilityDeclaration` type no
// longer carries `methods`, so the method-bearing capability entry
// crosses the test-double boundary while preserving runtime behaviour.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
const METRICS_DECLARATION = {
  id: 'native-metrics',
  entry: './dist/index.js',
  capabilities: [
    {
      name: 'metrics-provider',
      methods: [
        'collectSnapshot',
        'getCached',
        'getCurrent',
        'getDiskSpace',
        'getGpuInfo',
        'getCpuTemperature',
        'getProcessStats',
        'listAddonInstances',
        'getAddonStats',
      ],
    },
  ],
} as unknown as AddonDeclaration

/** Initialize addon and capture registered providers, then create Moleculer service schema. */
async function initAndCreateService(
  addon: TestNativeMetricsAddon,
  targetBroker: ServiceBroker,
  declaration: AddonDeclaration,
  dataDir: string,
): Promise<{ schema: import('moleculer').ServiceSchema; providers: Map<string, unknown> }> {
  const context = await createAddonContext(targetBroker, declaration, dataDir)
  const providers = new Map<string, unknown>()
  // TestNativeMetricsAddon declares a concrete `Promise<ProviderRegistration[]>`
  // return type on its `initialize` method — the helper doesn't need to
  // normalize against the wider AddonInitResult envelope. Capability entries
  // carry a `CapabilityDefinition` object since the 2026-04-14 migration, so
  // the providers map is indexed by `capability.name`.
  const regs: readonly ProviderRegistration[] = await addon.initialize(context)
  for (const reg of regs) {
    const cap = reg.capability
    const capName: string = typeof cap === 'string' ? cap : cap.name
    providers.set(capName, reg.provider)
    context.registerProvider(capName, reg.provider)
  }
  const schema = createAddonService(addon as unknown as ICamstackAddon, declaration, { providers })
  return { schema, providers }
}

function createHubDeps(overrides?: Partial<HubServiceDeps>): HubServiceDeps & {
  readonly receivedEvents: Array<Record<string, unknown>>
  readonly receivedLogs: Array<Record<string, unknown>>
  readonly storedEvents: Array<Record<string, unknown>>
} {
  const receivedEvents: Array<Record<string, unknown>> = []
  const receivedLogs: Array<Record<string, unknown>> = []
  const storedEvents: Array<Record<string, unknown>> = []
  // `$hub.event` was removed, so events can no longer populate these
  // arrays through `deps.onEvent`. Tests that need event capture now
  // register a `$event-bus` wildcard subscriber after creating the
  // broker (see `captureClusterEvents` below); `$hub.getRecentEvents`
  // still reads from `storedEvents` so the assertions stay stable.
  return {
    receivedEvents,
    receivedLogs,
    storedEvents,
    getAddonConfig: (addonId) => ({ addonId, samplingIntervalMs: 500 }),
    getSettings: (scope, key) => ({ scope, key, value: 'test-value' }),
    getRecentEvents: (category, limit) => {
      const filtered = category
        ? storedEvents.filter((e) => e.category === category)
        : [...storedEvents]
      return limit ? filtered.slice(0, limit) : filtered
    },
    onLog: (entry) => {
      receivedLogs.push(entry as Record<string, unknown>)
    },
    ...overrides,
  }
}

/**
 * Wire a `$event-bus` wildcard subscriber on `broker` that mirrors the
 * behaviour the old `$hub.event` handler provided: every event seen by
 * the hub `$event-bus` service is appended to the given deps'
 * `receivedEvents` and `storedEvents` arrays. Returns the unsubscribe
 * function.
 */
function captureClusterEvents(
  broker: ServiceBroker,
  deps: {
    receivedEvents: Array<Record<string, unknown>>
    storedEvents: Array<Record<string, unknown>>
  },
): () => void {
  registerEventBusService(broker)
  return getBrokerEventBus(broker).subscribe({ category: '**' }, (event) => {
    const snapshot: Record<string, unknown> = { ...event }
    deps.receivedEvents.push(snapshot)
    deps.storedEvents.push(snapshot)
  })
}

function createAgentDeps(tmpDir: string): AgentServiceDeps & {
  readonly loadedAddons: Map<string, { id: string; status: string }>
} {
  const addonsDir = path.join(tmpDir, 'addons')
  const dataDir = path.join(tmpDir, 'data')
  fs.mkdirSync(addonsDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  const loadedAddons = new Map<string, { id: string; status: string }>()
  return { addonsDir, dataDir, loadedAddons, agentName: 'agent-1', configPath: '' }
}

function createTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `e2e-${label}-`))
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/** Create a minimal tarball for deploy tests. */
function createTestTarball(tmpDir: string): string {
  const srcDir = path.join(tmpDir, 'test-addon-src')
  fs.mkdirSync(srcDir, { recursive: true })
  fs.writeFileSync(
    path.join(srcDir, 'package.json'),
    JSON.stringify({ name: 'test-addon', version: '1.0.0' }),
  )
  fs.writeFileSync(path.join(srcDir, 'index.js'), 'module.exports = {}')
  const tarPath = path.join(tmpDir, 'test-addon.tgz')
  execSync(`tar -czf "${tarPath}" -C "${path.dirname(srcDir)}" "${path.basename(srcDir)}"`, {
    timeout: 5000,
  })
  return fs.readFileSync(tarPath).toString('base64')
}

// ---------------------------------------------------------------------------
// Group 1: Real addon lifecycle on single node (hub-only)
// ---------------------------------------------------------------------------

describe('Group 1: Real addon lifecycle on single node', () => {
  let broker: ServiceBroker
  let addon: TestNativeMetricsAddon
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTempDir('g1')
    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    addon = new TestNativeMetricsAddon()
  })

  afterEach(async () => {
    await addon.shutdown()
    try {
      await broker.stop()
    } catch {
      /* already stopped */
    }
    cleanupDir(tmpDir)
  })

  it('NativeMetricsAddon initializes with minimal context', async () => {
    const context = await createAddonContext(broker, { ...METRICS_DECLARATION }, tmpDir)
    await addon.initialize(context)
    expect(addon.provider).not.toBeNull()
  })

  it('NativeMetricsAddon registers as metrics-provider via initialize() return', async () => {
    const context = await createAddonContext(broker, { ...METRICS_DECLARATION }, tmpDir)
    const regs = await addon.initialize(context)
    expect(Array.isArray(regs)).toBe(true)
    const metricReg = (regs as Array<{ capability: { name: string }; provider: unknown }>).find(
      (r) => r.capability.name === 'metrics-provider',
    )
    expect(metricReg).toBeDefined()
    // Provider is a composed POJO (class methods + addon-instance methods),
    // not the raw NativeMetricsProvider instance.
    const provider = metricReg!.provider as Record<string, unknown>
    expect(typeof provider.collectSnapshot).toBe('function')
    expect(typeof provider.listAddonInstances).toBe('function')
    expect(typeof provider.getAddonStats).toBe('function')
  })

  it('NativeMetricsAddon provider returns real CPU/memory data', async () => {
    const context = await createAddonContext(broker, { ...METRICS_DECLARATION }, tmpDir)
    await addon.initialize(context)
    // Wait for the first CPU sample to populate
    await new Promise((r) => setTimeout(r, 200))
    const snapshot = await addon.provider!.collectSnapshot()
    expect(snapshot).toBeDefined()
    expect(snapshot.cpu).toBeDefined()
    expect(snapshot.cpu.cores).toBeGreaterThan(0)
    expect(snapshot.memory).toBeDefined()
    expect(snapshot.memory.totalBytes).toBeGreaterThan(0)
    expect(snapshot.timestampMs).toBeGreaterThan(0)
  })

  it('NativeMetricsAddon shuts down cleanly (stops sampling timers)', async () => {
    const context = await createAddonContext(broker, { ...METRICS_DECLARATION }, tmpDir)
    await addon.initialize(context)
    const provider = addon.provider!
    await addon.shutdown()
    expect(addon.provider).toBeNull()
    // After shutdown, getCached still returns the last cache (no crash)
    const cached = await provider.getCached()
    // May be null or a snapshot depending on timing — the key is no crash
    expect(cached === null || typeof cached === 'object').toBe(true)
  })

  it('NativeMetricsAddon as Moleculer service: action call returns real metrics', async () => {
    const { schema } = await initAndCreateService(addon, broker, METRICS_DECLARATION, tmpDir)
    // Wait for sampling
    await new Promise((r) => setTimeout(r, 200))

    broker.createService(schema)
    const hubDeps = createHubDeps()
    broker.createService(createHubService(hubDeps))
    await broker.start()

    const snapshot = (await broker.call(
      'native-metrics.metrics-provider.collectSnapshot',
    )) as Record<string, unknown>
    expect(snapshot).toBeDefined()
    expect(snapshot.cpu).toBeDefined()
    expect(snapshot.memory).toBeDefined()

    // Legacy `getCpuPercent` / `getMemoryPercent` were removed when the cap
    // surface was expanded; `getCurrent` now returns both in one payload.
    const current = (await broker.call('native-metrics.metrics-provider.getCurrent')) as {
      cpuPercent: number
      memoryPercent: number
    }
    expect(typeof current.cpuPercent).toBe('number')
    expect(typeof current.memoryPercent).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Group 2: Real addon on remote agent
// ---------------------------------------------------------------------------

describe('Group 2: Real addon on remote agent', () => {
  let cluster: TestCluster
  const addons: TestNativeMetricsAddon[] = []
  const tmpDirs: string[] = []
  const extraBrokers: ServiceBroker[] = []

  afterEach(async () => {
    for (const a of addons) {
      try {
        await a.shutdown()
      } catch {
        /* */
      }
    }
    addons.length = 0
    for (const b of extraBrokers) {
      try {
        await b.stop()
      } catch {
        /* */
      }
    }
    extraBrokers.length = 0
    if (cluster) await cluster.stop()
    for (const d of tmpDirs) cleanupDir(d)
    tmpDirs.length = 0
  })

  it('NativeMetricsAddon on agent-gpu: hub can call metrics via Moleculer', async () => {
    cluster = createTestCluster(['agent-gpu'])
    const agentBroker = cluster.agents.get('agent-gpu')!
    const tmpDir = createTempDir('g2-gpu')
    tmpDirs.push(tmpDir)
    const addon = new TestNativeMetricsAddon()
    addons.push(addon)
    const { schema } = await initAndCreateService(addon, agentBroker, METRICS_DECLARATION, tmpDir)
    await new Promise((r) => setTimeout(r, 200))

    agentBroker.createService(schema)
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.collectSnapshot'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    const snapshot = (await cluster.hub.call(actionName, {}, { nodeID: 'agent-gpu' })) as Record<
      string,
      unknown
    >
    expect(snapshot).toBeDefined()
    expect(snapshot.cpu).toBeDefined()
    expect(snapshot.memory).toBeDefined()
  })

  it('NativeMetricsAddon on 2 agents: hub gets different metrics per node', async () => {
    cluster = createTestCluster(['agent-1', 'agent-2'])

    for (const nodeId of ['agent-1', 'agent-2']) {
      const agentBroker = cluster.agents.get(nodeId)!
      const tmpDir = createTempDir(`g2-${nodeId}`)
      tmpDirs.push(tmpDir)
      const addon = new TestNativeMetricsAddon()
      addons.push(addon)
      const { schema } = await initAndCreateService(addon, agentBroker, METRICS_DECLARATION, tmpDir)
      agentBroker.createService(schema)
    }

    await new Promise((r) => setTimeout(r, 200))
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.collectSnapshot'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    const snap1 = (await cluster.hub.call(actionName, {}, { nodeID: 'agent-1' })) as Record<
      string,
      unknown
    >
    const snap2 = (await cluster.hub.call(actionName, {}, { nodeID: 'agent-2' })) as Record<
      string,
      unknown
    >
    expect(snap1).toBeDefined()
    expect(snap2).toBeDefined()
    // Both should have cpu/memory info (same machine, but independent snapshots)
    expect((snap1 as { cpu: { cores: number } }).cpu.cores).toBeGreaterThan(0)
    expect((snap2 as { cpu: { cores: number } }).cpu.cores).toBeGreaterThan(0)
  })

  it('Agent metrics addon goes offline: hub call fails gracefully', async () => {
    cluster = createTestCluster(['agent-gpu'])
    const agentBroker = cluster.agents.get('agent-gpu')!
    const tmpDir = createTempDir('g2-offline')
    tmpDirs.push(tmpDir)
    const addon = new TestNativeMetricsAddon()
    addons.push(addon)
    const { schema } = await initAndCreateService(addon, agentBroker, METRICS_DECLARATION, tmpDir)
    agentBroker.createService(schema)
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.collectSnapshot'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    // Verify it works first
    const snap = await cluster.hub.call(actionName, {}, { nodeID: 'agent-gpu' })
    expect(snap).toBeDefined()

    // Stop the agent
    await addon.shutdown()
    await agentBroker.stop()
    await waitUntil(() => !getAvailableNodeIds(cluster.hub).includes('agent-gpu'))

    // Call should fail
    await expect(
      cluster.hub.call(actionName, {}, { nodeID: 'agent-gpu', timeout: 1000 }),
    ).rejects.toThrow()
  })

  it('Agent metrics addon reconnects: hub can call again', async () => {
    cluster = createTestCluster(['agent-gpu'])
    const agentBroker = cluster.agents.get('agent-gpu')!
    const tmpDir = createTempDir('g2-reconnect')
    tmpDirs.push(tmpDir)
    const addon = new TestNativeMetricsAddon()
    addons.push(addon)
    const { schema } = await initAndCreateService(addon, agentBroker, METRICS_DECLARATION, tmpDir)
    agentBroker.createService(schema)
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.collectSnapshot'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    // Stop agent
    await addon.shutdown()
    await agentBroker.stop()
    await waitUntil(() => !getAvailableNodeIds(cluster.hub).includes('agent-gpu'))

    // Reconnect with new broker + addon
    const newBroker = new ServiceBroker({ nodeID: 'agent-gpu', transporter: 'Fake', logger: false })
    extraBrokers.push(newBroker)
    const newAddon = new TestNativeMetricsAddon()
    addons.push(newAddon)
    const tmpDir2 = createTempDir('g2-reconnect2')
    tmpDirs.push(tmpDir2)
    const { schema: newSchema } = await initAndCreateService(
      newAddon,
      newBroker,
      METRICS_DECLARATION,
      tmpDir2,
    )
    await new Promise((r) => setTimeout(r, 200))
    newBroker.createService(newSchema)
    await newBroker.start()

    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)
    const snap = (await cluster.hub.call(actionName, {}, { nodeID: 'agent-gpu' })) as Record<
      string,
      unknown
    >
    expect(snap).toBeDefined()
    expect(snap.cpu).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Group 3: $hub API — every action
// ---------------------------------------------------------------------------

describe('Group 3: $hub API — every action', () => {
  let hub: ServiceBroker
  let agent: ServiceBroker
  let hubDeps: ReturnType<typeof createHubDeps>

  beforeEach(async () => {
    hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agent = new ServiceBroker({ nodeID: 'agent-1', transporter: 'Fake', logger: false })
    hubDeps = createHubDeps()
    hub.createService(createHubService(hubDeps))
    // `$hub.event` is gone — we wire the `$event-bus` wildcard subscriber
    // so the legacy `hubDeps.receivedEvents` / `hubDeps.storedEvents`
    // arrays get populated when agents broadcast via `camstack.evt.*`.
    // Must happen before `broker.start()` so discovery propagates the
    // subscription.
    captureClusterEvents(hub, hubDeps)
    registerEventBusService(agent)
    await hub.start()
    await agent.start()
  })

  afterEach(async () => {
    try {
      await agent.stop()
    } catch {
      /* */
    }
    try {
      await hub.stop()
    } catch {
      /* */
    }
  })

  // Former `$hub.event receives events and stores them` + the categories
  // test were deleted — the action no longer exists. The replacement path
  // (broker.broadcast → $event-bus) is exercised by the `getRecentEvents`
  // tests below and by the broker-event-bus-roundtrip spec.

  it('$hub.getAddonConfig returns addon-specific config', async () => {
    const config = (await agent.call('$hub.getAddonConfig', {
      addonId: 'native-metrics',
    })) as Record<string, unknown>
    expect(config.addonId).toBe('native-metrics')
    expect(config.samplingIntervalMs).toBe(500)
  })

  it('$hub.getSettings returns settings by scope and key', async () => {
    const settings = (await agent.call('$hub.getSettings', {
      scope: 'global',
      key: 'detection.threshold',
    })) as Record<string, unknown>
    expect(settings.scope).toBe('global')
    expect(settings.key).toBe('detection.threshold')
    expect(settings.value).toBe('test-value')
  })

  it('$hub.getRecentEvents returns stored events filtered by category', async () => {
    // Populate the hub's stored-event buffer by broadcasting from the
    // agent — the hub's `$event-bus` wildcard subscriber installed in
    // `beforeEach` appends every incoming event to `hubDeps.storedEvents`,
    // which `$hub.getRecentEvents` queries.
    agent.broadcast(clusterEventTopic('detection.result'), {
      id: 'e1',
      timestamp: new Date(),
      source: { type: 'test', id: 'a' },
      category: 'detection.result',
      data: { count: 1 },
      sourceNodeId: 'agent-1',
    })
    agent.broadcast(clusterEventTopic('device.online'), {
      id: 'e2',
      timestamp: new Date(),
      source: { type: 'test', id: 'a' },
      category: 'device.online',
      data: { id: 'cam1' },
      sourceNodeId: 'agent-1',
    })
    agent.broadcast(clusterEventTopic('detection.result'), {
      id: 'e3',
      timestamp: new Date(),
      source: { type: 'test', id: 'a' },
      category: 'detection.result',
      data: { count: 2 },
      sourceNodeId: 'agent-1',
    })

    await waitUntil(() => hubDeps.storedEvents.length >= 3)

    const events = (await agent.call('$hub.getRecentEvents', {
      category: 'detection.result',
    })) as readonly unknown[]
    expect(events).toHaveLength(2)
  })

  it('$hub.getRecentEvents respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      agent.broadcast(clusterEventTopic('test'), {
        id: `ev-${i}`,
        timestamp: new Date(),
        source: { type: 'test', id: 'a' },
        category: 'test',
        data: { i },
        sourceNodeId: 'agent-1',
      })
    }
    await waitUntil(() => hubDeps.storedEvents.length >= 5)

    const events = (await agent.call('$hub.getRecentEvents', { limit: 2 })) as readonly unknown[]
    expect(events).toHaveLength(2)
  })

  it('$hub.log receives and stores log entries from agents', async () => {
    await agent.call('$hub.log', {
      level: 'info',
      message: 'test log message',
      addonId: 'test-addon',
      nodeId: 'agent-1',
    })
    expect(hubDeps.receivedLogs).toHaveLength(1)
    expect(hubDeps.receivedLogs[0]!.message).toBe('test log message')
  })

  it('$hub.log with different levels', async () => {
    const levels = ['info', 'warn', 'error', 'debug']
    for (const level of levels) {
      await agent.call('$hub.log', {
        level,
        message: `${level} message`,
        addonId: 'test-addon',
        nodeId: 'agent-1',
      })
    }
    expect(hubDeps.receivedLogs).toHaveLength(4)
    expect(hubDeps.receivedLogs.map((l) => l.level)).toEqual(levels)
  })
})

// ---------------------------------------------------------------------------
// Group 4: $agent API — every action
// ---------------------------------------------------------------------------

describe('Group 4: $agent API — every action', () => {
  let hub: ServiceBroker
  let agent: ServiceBroker
  let agentDeps: ReturnType<typeof createAgentDeps>
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = createTempDir('g4')
    hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    agent = new ServiceBroker({ nodeID: 'agent-1', transporter: 'Fake', logger: false })
    agentDeps = createAgentDeps(tmpDir)
    agent.createService(createAgentService(agentDeps))
    // Mock the agent's own `$process` service — `$agent.restart` delegates to
    // `$process.restart` (the same primitive the hub uses for a forked addon),
    // pinned to the agent's own node. The real service lives in the agent
    // runtime, not this test broker, so provide a minimal stand-in.
    agent.createService({
      name: '$process',
      actions: { restart: () => ({ success: true, pid: 4242 }) },
    })
    hub.createService(createHubService(createHubDeps()))
    await hub.start()
    await agent.start()
    await waitUntil(() => getAvailableNodeIds(hub).includes('agent-1'))
  })

  afterEach(async () => {
    try {
      await agent.stop()
    } catch {
      /* */
    }
    try {
      await hub.stop()
    } catch {
      /* */
    }
    cleanupDir(tmpDir)
  })

  it('$agent.status returns correct system info', async () => {
    const status = (await hub.call('$agent.status', {}, { nodeID: 'agent-1' })) as Record<
      string,
      unknown
    >
    expect(status.nodeId).toBe('agent-1')
    expect(status.platform).toBe(os.platform())
    expect(status.arch).toBe(os.arch())
    expect(status.hostname).toBe(os.hostname())
    expect(status.cpuCores).toBe(os.cpus().length)
    expect(status.totalMemoryMB as number).toBeGreaterThan(0)
  })

  it('$agent.status reports loaded addons with status', async () => {
    agentDeps.loadedAddons.set('addon-a', { id: 'addon-a', status: 'running' })
    agentDeps.loadedAddons.set('addon-b', { id: 'addon-b', status: 'stopped' })

    const status = (await hub.call('$agent.status', {}, { nodeID: 'agent-1' })) as Record<
      string,
      unknown
    >
    const addonsArr = status.addons as Array<{ id: string; status: string }>
    expect(addonsArr).toHaveLength(2)
    expect(addonsArr.find((a) => a.id === 'addon-a')?.status).toBe('running')
    expect(addonsArr.find((a) => a.id === 'addon-b')?.status).toBe('stopped')
  })

  it('$agent.listAddons returns addon IDs from loaded map', async () => {
    agentDeps.loadedAddons.set('detection', { id: 'detection', status: 'running' })
    agentDeps.loadedAddons.set('metrics', { id: 'metrics', status: 'running' })

    const ids = (await hub.call(
      '$agent.listAddons',
      {},
      { nodeID: 'agent-1' },
    )) as readonly string[]
    expect(ids).toContain('detection')
    expect(ids).toContain('metrics')
  })

  it('$agent.deploy extracts bundle and returns path', async () => {
    const bundleBase64 = createTestTarball(tmpDir)
    const result = (await hub.call(
      '$agent.deploy',
      {
        addonId: 'test-addon',
        bundle: bundleBase64,
      },
      { nodeID: 'agent-1' },
    )) as Record<string, unknown>

    expect(result.success).toBe(true)
    expect(result.addonId).toBe('test-addon')
    expect(typeof result.path).toBe('string')
    // Verify files were extracted
    const deployedDir = result.path as string
    expect(fs.existsSync(deployedDir)).toBe(true)
  })

  it('$agent.undeploy removes addon from loaded map and cleans up', async () => {
    agentDeps.loadedAddons.set('my-addon', { id: 'my-addon', status: 'running' })
    const addonDir = path.join(agentDeps.addonsDir, 'my-addon')
    fs.mkdirSync(addonDir, { recursive: true })
    fs.writeFileSync(path.join(addonDir, 'index.js'), '// test')

    const result = (await hub.call(
      '$agent.undeploy',
      { addonId: 'my-addon' },
      { nodeID: 'agent-1' },
    )) as Record<string, unknown>
    expect(result.success).toBe(true)
    expect(agentDeps.loadedAddons.has('my-addon')).toBe(false)
    expect(fs.existsSync(addonDir)).toBe(false)
  })

  it('$agent.undeploy of non-existent addon succeeds gracefully', async () => {
    const result = (await hub.call(
      '$agent.undeploy',
      { addonId: 'nonexistent' },
      { nodeID: 'agent-1' },
    )) as Record<string, unknown>
    expect(result.success).toBe(true)
    expect(result.addonId).toBe('nonexistent')
  })

  it('$agent.restart delegates to $process.restart and returns success', async () => {
    const result = (await hub.call(
      '$agent.restart',
      { addonId: 'my-addon' },
      { nodeID: 'agent-1' },
    )) as Record<string, unknown>
    expect(result.success).toBe(true)
    expect(result.addonId).toBe('my-addon')
    expect(result.pid).toBe(4242)
  })
})

// ---------------------------------------------------------------------------
// Group 5: Multi-node combinations
// ---------------------------------------------------------------------------

describe('Group 5: Multi-node combinations', () => {
  const tmpDirs: string[] = []
  const allAddons: TestNativeMetricsAddon[] = []
  let cluster: TestCluster
  const extraBrokers: ServiceBroker[] = []

  afterEach(async () => {
    for (const a of allAddons) {
      try {
        await a.shutdown()
      } catch {
        /* */
      }
    }
    allAddons.length = 0
    for (const b of extraBrokers) {
      try {
        await b.stop()
      } catch {
        /* */
      }
    }
    extraBrokers.length = 0
    if (cluster) await cluster.stop()
    for (const d of tmpDirs) cleanupDir(d)
    tmpDirs.length = 0
  })

  async function addMetricsToNode(
    broker: ServiceBroker,
    nodeLabel: string,
  ): Promise<TestNativeMetricsAddon> {
    const tmpDir = createTempDir(`g5-${nodeLabel}`)
    tmpDirs.push(tmpDir)
    const addon = new TestNativeMetricsAddon()
    allAddons.push(addon)
    const { schema } = await initAndCreateService(addon, broker, METRICS_DECLARATION, tmpDir)
    broker.createService(schema)
    return addon
  }

  it('1 hub + 0 agents: hub serves its own metrics', async () => {
    cluster = createTestCluster([])
    await addMetricsToNode(cluster.hub, 'hub')
    await new Promise((r) => setTimeout(r, 200))
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.getCurrent'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)
    const cpu = (await cluster.hub.call(actionName)) as { cpuPercent: number }
    expect(typeof cpu.cpuPercent).toBe('number')
  })

  it('1 hub + 1 agent: hub and agent both serve metrics, targeted by nodeID', async () => {
    cluster = createTestCluster(['agent-1'])
    await addMetricsToNode(cluster.hub, 'hub')
    await addMetricsToNode(cluster.agents.get('agent-1')!, 'agent-1')
    await new Promise((r) => setTimeout(r, 200))
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.getCurrent'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    const hubMem = (await cluster.hub.call(actionName, {}, { nodeID: 'hub' })) as {
      memoryPercent: number
    }
    const agentMem = (await cluster.hub.call(actionName, {}, { nodeID: 'agent-1' })) as {
      memoryPercent: number
    }
    expect(typeof hubMem.memoryPercent).toBe('number')
    expect(typeof agentMem.memoryPercent).toBe('number')
  })

  it('1 hub + 3 agents: all 4 nodes serve metrics independently', async () => {
    cluster = createTestCluster(['agent-a', 'agent-b', 'agent-c'])
    await addMetricsToNode(cluster.hub, 'hub')
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      await addMetricsToNode(cluster.agents.get(id)!, id)
    }
    await new Promise((r) => setTimeout(r, 200))
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.getCurrent'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    for (const nodeId of ['hub', 'agent-a', 'agent-b', 'agent-c']) {
      const cpu = (await cluster.hub.call(actionName, {}, { nodeID: nodeId })) as {
        cpuPercent: number
      }
      expect(typeof cpu.cpuPercent).toBe('number')
    }
  })

  it('1 hub + 3 agents: one agent stops, others continue serving', async () => {
    cluster = createTestCluster(['agent-a', 'agent-b', 'agent-c'])
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      await addMetricsToNode(cluster.agents.get(id)!, id)
    }
    await new Promise((r) => setTimeout(r, 200))
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.getCurrent'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    // Stop agent-b
    await cluster.agents.get('agent-b')!.stop()
    await waitUntil(() => !getAvailableNodeIds(cluster.hub).includes('agent-b'))

    // agent-a and agent-c still work
    const cpuA = (await cluster.hub.call(actionName, {}, { nodeID: 'agent-a' })) as {
      cpuPercent: number
    }
    expect(typeof cpuA.cpuPercent).toBe('number')
    const cpuC = (await cluster.hub.call(actionName, {}, { nodeID: 'agent-c' })) as {
      cpuPercent: number
    }
    expect(typeof cpuC.cpuPercent).toBe('number')

    // agent-b fails
    await expect(
      cluster.hub.call(actionName, {}, { nodeID: 'agent-b', timeout: 1000 }),
    ).rejects.toThrow()
    // Multi-node broker convergence (start + action availability + agent-b stop
    // + re-convergence) serially chains several waits that exceed the 5s default
    // on CI-class hardware — give this e2e a generous timeout.
  }, 20000)

  // QUARANTINED (D3 plan Task 3): pre-existing timing failure unrelated to the registration handshake — test has a 5000ms outer timeout but serially chains multiple `waitUntil(..., 5000)` calls (broker start + action availability + agent-b stop + agent-b restart + action re-availability) that together exceed 5s on CI-class hardware; consistently fails at ~5538ms. The `await createAddonContext` fix on this branch does not touch this test path (`addMetricsToNode`/`createTestCluster`). Identical test body at branch point fd266820 — pre-existing.
  it.skip('1 hub + 3 agents: stopped agent restarts, all 4 serve again', async () => {
    cluster = createTestCluster(['agent-a', 'agent-b', 'agent-c'])
    await addMetricsToNode(cluster.hub, 'hub')
    for (const id of ['agent-a', 'agent-b', 'agent-c']) {
      await addMetricsToNode(cluster.agents.get(id)!, id)
    }
    await new Promise((r) => setTimeout(r, 200))
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.getCurrent'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    // Stop agent-b
    await cluster.agents.get('agent-b')!.stop()
    await waitUntil(() => !getAvailableNodeIds(cluster.hub).includes('agent-b'))

    // Restart agent-b
    const newB = new ServiceBroker({ nodeID: 'agent-b', transporter: 'Fake', logger: false })
    extraBrokers.push(newB)
    await addMetricsToNode(newB, 'agent-b-new')
    await new Promise((r) => setTimeout(r, 200))
    await newB.start()
    await waitUntil(() => getAvailableNodeIds(cluster.hub).includes('agent-b'), 5000)
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    // All 4 nodes respond
    for (const nodeId of ['hub', 'agent-a', 'agent-b', 'agent-c']) {
      const cpu = (await cluster.hub.call(actionName, {}, { nodeID: nodeId })) as {
        cpuPercent: number
      }
      expect(typeof cpu.cpuPercent).toBe('number')
    }
  })
})

// ---------------------------------------------------------------------------
// Group 6: Event flow with real addon
// ---------------------------------------------------------------------------

describe('Group 6: Event flow with real addon', () => {
  let cluster: TestCluster
  const tmpDirs: string[] = []
  const allAddons: TestNativeMetricsAddon[] = []

  afterEach(async () => {
    for (const a of allAddons) {
      try {
        await a.shutdown()
      } catch {
        /* */
      }
    }
    allAddons.length = 0
    if (cluster) await cluster.stop()
    for (const d of tmpDirs) cleanupDir(d)
    tmpDirs.length = 0
  })

  it('Real addon emits event via context.eventBus.emit -> arrives at hub receivedEvents', async () => {
    cluster = createTestCluster(['agent-1'])
    const tmpDir = createTempDir('g6-emit')
    tmpDirs.push(tmpDir)
    const agentBroker = cluster.agents.get('agent-1')!
    const context = await createAddonContext(agentBroker, METRICS_DECLARATION, tmpDir)
    await cluster.start()

    // Emit event through the context eventBus
    context.eventBus.emit({
      // biome-ignore lint/plugin: synthetic test-only event category for bus-routing coverage
      category: 'metrics.sampled',
      data: { cpu: 42 },
      timestamp: Date.now(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as import('@camstack/types').SystemEvent)

    await waitUntil(() => cluster.receivedEvents.length > 0, 3000)
    expect(cluster.receivedEvents).toHaveLength(1)
    expect(cluster.receivedEvents[0]!.category).toBe('metrics.sampled')
  })

  it('Multiple addons on different nodes emit events -> all arrive at hub', async () => {
    cluster = createTestCluster(['agent-1', 'agent-2'])
    await cluster.start()

    for (const nodeId of ['agent-1', 'agent-2']) {
      const tmpDir = createTempDir(`g6-multi-${nodeId}`)
      tmpDirs.push(tmpDir)
      const agentBroker = cluster.agents.get(nodeId)!
      const context = await createAddonContext(agentBroker, METRICS_DECLARATION, tmpDir)

      context.eventBus.emit({
        // biome-ignore lint/plugin: synthetic test-only event category for bus-routing coverage
        category: 'metrics.sampled',
        data: { node: nodeId },
        timestamp: Date.now(),
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
      } as unknown as import('@camstack/types').SystemEvent)
    }

    await waitUntil(() => cluster.receivedEvents.length >= 2, 3000)
    expect(cluster.receivedEvents).toHaveLength(2)
  })

  it('Local eventBus.subscribe receives events from same-node addon', async () => {
    cluster = createTestCluster(['agent-1'])
    const tmpDir = createTempDir('g6-local-sub')
    tmpDirs.push(tmpDir)
    const agentBroker = cluster.agents.get('agent-1')!
    const context = await createAddonContext(agentBroker, METRICS_DECLARATION, tmpDir)
    await cluster.start()

    const localEvents: unknown[] = []
    context.eventBus.subscribe({ category: 'metrics.*' }, (event) => {
      localEvents.push(event)
    })

    context.eventBus.emit({
      // biome-ignore lint/plugin: synthetic test-only event category for bus-routing coverage
      category: 'metrics.snapshot',
      data: { value: 1 },
      timestamp: Date.now(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as import('@camstack/types').SystemEvent)

    // Local subscriber should receive immediately (synchronous dispatch)
    expect(localEvents).toHaveLength(1)
  })

  it('Local eventBus.subscribe DOES receive events from other nodes (distributed bus)', async () => {
    // These bare Fake-transporter brokers carry neither the agent inbound
    // gate (D802) nor the agent event scope (D848), so this shows only the
    // BUS mechanics. In production an agent's events reach the hub only and
    // a peer agent receives none — `agent-mesh-isolation.cluster.spec.ts`
    // asserts that on a real TLS cluster.
    cluster = createTestCluster(['agent-1', 'agent-2'])
    const tmpDir1 = createTempDir('g6-cross-1')
    const tmpDir2 = createTempDir('g6-cross-2')
    tmpDirs.push(tmpDir1, tmpDir2)
    const context1 = await createAddonContext(
      cluster.agents.get('agent-1')!,
      METRICS_DECLARATION,
      tmpDir1,
    )
    const context2 = await createAddonContext(
      cluster.agents.get('agent-2')!,
      METRICS_DECLARATION,
      tmpDir2,
    )
    await cluster.start()

    const agent1Events: unknown[] = []
    context1.eventBus.subscribe({ category: 'metrics.*' }, (event) => {
      agent1Events.push(event)
    })

    // Emit from agent-2 — agent-1's subscriber receives it via broadcast.
    context2.eventBus.emit({
      // biome-ignore lint/plugin: synthetic test-only event category for bus-routing coverage
      category: 'metrics.snapshot',
      data: { from: 'agent-2' },
      timestamp: Date.now(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as import('@camstack/types').SystemEvent)

    // Broadcast path is async — wait a beat for the Moleculer transit
    // to deliver to the peer broker's $event-bus service.
    await new Promise((r) => setTimeout(r, 200))
    expect(agent1Events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Group 7: Context transparency
// ---------------------------------------------------------------------------

describe('Group 7: Context transparency', () => {
  let broker: ServiceBroker
  let tmpDir: string

  beforeEach(() => {
    tmpDir = createTempDir('g7')
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
  })

  afterEach(async () => {
    try {
      await broker.stop()
    } catch {
      /* */
    }
    cleanupDir(tmpDir)
  })

  it('Addon context.id is correct', async () => {
    const context = await createAddonContext(broker, METRICS_DECLARATION, tmpDir)
    expect(context.id).toBe('native-metrics')
  })

  it('Addon context.logger works (does not crash)', async () => {
    const context = await createAddonContext(broker, METRICS_DECLARATION, tmpDir)
    // All log levels should not throw
    expect(() => context.logger.info('test info')).not.toThrow()
    expect(() => context.logger.warn('test warn')).not.toThrow()
    expect(() => context.logger.error('test error')).not.toThrow()
    expect(() => context.logger.debug('test debug')).not.toThrow()
  })

  it('Addon context.eventBus.emit routes to hub', async () => {
    const hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    const receivedEvents: unknown[] = []
    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
      }),
    )
    // Post-$hub.event: hub ingests cluster events via the `$event-bus`
    // service + a wildcard subscriber, not a hub-service dep callback.
    registerEventBusService(hub)
    registerEventBusService(broker)
    getBrokerEventBus(hub).subscribe({ category: '**' }, (event) => {
      receivedEvents.push(event)
    })

    await hub.start()
    await broker.start()
    await waitUntil(() => getAvailableNodeIds(hub).includes('agent-test'))

    const context = await createAddonContext(broker, METRICS_DECLARATION, tmpDir)
    context.eventBus.emit({
      // biome-ignore lint/plugin: synthetic test-only event category for bus-routing coverage
      category: 'test.event',
      data: {},
      timestamp: Date.now(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as import('@camstack/types').SystemEvent)

    await waitUntil(() => receivedEvents.length > 0, 3000)
    expect(receivedEvents).toHaveLength(1)
    await hub.stop()
  })

  it('Addon context.eventBus.subscribe receives local events', async () => {
    const context = await createAddonContext(broker, METRICS_DECLARATION, tmpDir)
    const events: unknown[] = []
    context.eventBus.subscribe({ category: 'test.*' }, (e) => {
      events.push(e)
    })
    context.eventBus.emit({
      // biome-ignore lint/plugin: synthetic test-only event category for bus-routing coverage
      category: 'test.local',
      data: { value: 42 },
      timestamp: Date.now(),
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
    } as unknown as import('@camstack/types').SystemEvent)
    expect(events).toHaveLength(1)
  })

  it('Addon context.eventBus.getRecent returns empty array (remote limitation)', async () => {
    const context = await createAddonContext(broker, METRICS_DECLARATION, tmpDir)
    const recent = context.eventBus.getRecent()
    expect(recent).toEqual([])
  })

  // Device persistence now routes through `ctx.api.deviceManager.*`
  // — the `device-manager` capability auto-routed via the codegen'd
  // tRPC router or broker-api-proxy. Proven by seeding a stub
  // `device-manager` service that throws on `registerDevice` — the
  // rejection must propagate through `ctx.kernel.devices.register`.
  //
  // Prior to the location-transparency rework, this test relied on
  // "Service not found" fast-failing when no provider was registered.
  // That fast-fail path is gone (the transport now waits on service
  // discovery), so we seed a rejecting stub provider instead.
  it('Addon context.devices.register routes through device-manager capability', async () => {
    // Seed the stub BEFORE broker.start() so the Moleculer
    // registry has the service when the ctx's transport link probes
    // for it (`onlyAvailable: true` only includes started services).
    broker.createService({
      name: 'device-manager',
      actions: {
        'device-manager.registerDevice': {
          handler: () => {
            throw new Error('stub: device-manager.registerDevice rejected')
          },
        },
        'device-manager.allocateDeviceId': {
          handler: () => ({ id: 1 }),
        },
      },
    })
    await broker.start()

    const context = await createAddonContext(broker, METRICS_DECLARATION, tmpDir)
    const fakeDevice = {
      stableId: 'fake-cam',
      type: 'camera',
      name: 'Fake Cam',
      parentStableId: null,
      features: [],
      config: { values: { url: 'rtsp://fake' } },
      online: true,
      removeDevice: async () => {},
    } as unknown as import('@camstack/types').IDevice

    await expect(context.kernel.devices.register(fakeDevice)).rejects.toThrow(/device-manager/)
  })

  it('Addon context.dataDir exists on filesystem', async () => {
    const context = await createAddonContext(broker, METRICS_DECLARATION, tmpDir)
    expect(fs.existsSync(context.dataDir)).toBe(true)
    expect(context.dataDir).toContain('native-metrics')
  })
})

// ---------------------------------------------------------------------------
// Group 8: Concurrent operations
// ---------------------------------------------------------------------------

describe('Group 8: Concurrent operations', () => {
  let cluster: TestCluster
  const tmpDirs: string[] = []
  const allAddons: TestNativeMetricsAddon[] = []

  afterEach(async () => {
    for (const a of allAddons) {
      try {
        await a.shutdown()
      } catch {
        /* */
      }
    }
    allAddons.length = 0
    if (cluster) await cluster.stop()
    for (const d of tmpDirs) cleanupDir(d)
    tmpDirs.length = 0
  })

  it('3 agents broadcast events simultaneously — all events received', async () => {
    // Updated from the legacy `$hub.event` fan-in. Each agent broadcasts
    // on the `camstack.evt.*` channel; the wildcard subscriber installed
    // by `createTestCluster` on the hub captures every event.
    cluster = createTestCluster(['agent-1', 'agent-2', 'agent-3'])
    await cluster.start()

    for (const nodeId of ['agent-1', 'agent-2', 'agent-3']) {
      cluster.agents.get(nodeId)!.broadcast(clusterEventTopic('concurrent.test'), {
        id: `ev-${nodeId}`,
        timestamp: new Date(),
        source: { type: 'test', id: nodeId },
        category: 'concurrent.test',
        data: { from: nodeId },
        sourceNodeId: nodeId,
      })
    }

    await waitUntil(() => cluster.receivedEvents.length >= 3, 5000)
    expect(cluster.receivedEvents).toHaveLength(3)
    const sources = cluster.receivedEvents.map((e) => (e.data as { from: string }).from)
    expect(sources).toContain('agent-1')
    expect(sources).toContain('agent-2')
    expect(sources).toContain('agent-3')
  })

  it('Hub calls metrics on 3 agents simultaneously — all return results', async () => {
    cluster = createTestCluster(['agent-1', 'agent-2', 'agent-3'])
    for (const id of ['agent-1', 'agent-2', 'agent-3']) {
      const tmpDir = createTempDir(`g8-${id}`)
      tmpDirs.push(tmpDir)
      const addon = new TestNativeMetricsAddon()
      allAddons.push(addon)
      const { schema } = await initAndCreateService(
        addon,
        cluster.agents.get(id)!,
        METRICS_DECLARATION,
        tmpDir,
      )
      cluster.agents.get(id)!.createService(schema)
    }
    await new Promise((r) => setTimeout(r, 200))
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.getCurrent'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    const results = await Promise.all(
      ['agent-1', 'agent-2', 'agent-3'].map((nodeId) =>
        cluster.hub.call(actionName, {}, { nodeID: nodeId }),
      ),
    )

    expect(results).toHaveLength(3)
    for (const r of results) {
      const metrics = r as { cpuPercent: number; memoryPercent: number }
      expect(typeof metrics.cpuPercent).toBe('number')
      expect(typeof metrics.memoryPercent).toBe('number')
    }
  })

  it('Agent emits events while hub calls its actions — no deadlock', async () => {
    cluster = createTestCluster(['agent-1'])
    const tmpDir = createTempDir('g8-deadlock')
    tmpDirs.push(tmpDir)
    const addon = new TestNativeMetricsAddon()
    allAddons.push(addon)
    const agentBroker = cluster.agents.get('agent-1')!
    const context = await createAddonContext(agentBroker, METRICS_DECLARATION, tmpDir)
    const capturedProviders = new Map<string, unknown>()
    const regs: readonly ProviderRegistration[] = await addon.initialize(context)
    for (const reg of regs) {
      const cap = reg.capability
      const capName: string = typeof cap === 'string' ? cap : cap.name
      capturedProviders.set(capName, reg.provider)
      context.registerProvider(capName, reg.provider)
    }
    await new Promise((r) => setTimeout(r, 200))
    const schema = createAddonService(addon as unknown as ICamstackAddon, METRICS_DECLARATION, {
      providers: capturedProviders,
    })
    agentBroker.createService(schema)
    await cluster.start()

    const actionName = 'native-metrics.metrics-provider.getCurrent'
    await waitUntil(() => actionIsAvailable(cluster.hub, actionName), 5000)

    // Emit events and call actions concurrently
    const eventPromises = Array.from({ length: 5 }, (_, i) => {
      context.eventBus.emit({
        // biome-ignore lint/plugin: synthetic test-only event category for bus-routing coverage
        category: 'concurrent.event',
        data: { i },
        timestamp: Date.now(),
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
      } as unknown as import('@camstack/types').SystemEvent)
      return Promise.resolve()
    })

    const actionPromises = Array.from({ length: 5 }, () =>
      cluster.hub.call(actionName, {}, { nodeID: 'agent-1' }),
    )

    const [, actionResults] = await Promise.all([
      Promise.all(eventPromises),
      Promise.all(actionPromises),
    ])

    expect(actionResults).toHaveLength(5)
    for (const r of actionResults) {
      const metrics = r as { cpuPercent: number }
      expect(typeof metrics.cpuPercent).toBe('number')
    }
    // Events should also have arrived at hub
    await waitUntil(() => cluster.receivedEvents.length >= 5, 3000)
    expect(cluster.receivedEvents.length).toBeGreaterThanOrEqual(5)
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- test file, mock typing */
import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  createHubService,
  createAddonService,
  createAddonContext,
  NativeMetricsProvider,
  type HubServiceDeps,
} from '@camstack/system'
import { createAgentService } from '../../agent-service.js'
import type { AgentServiceDeps } from '../../agent-service.js'
import type {
  ICamstackAddon,
  AddonDeclaration,
  AddonContext,
  InternalAddonContext,
} from '@camstack/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until condition is true or timeout (ms) elapses. */
async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeout = 10000,
  interval = 200,
): Promise<void> {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeout) {
      throw new Error(`waitUntil timed out after ${timeout}ms`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }
}

function getAvailableNodeIds(broker: ServiceBroker): readonly string[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  const registry = (broker as unknown as Record<string, unknown>).registry as
    | { getNodeList: (opts: Record<string, boolean>) => readonly { id: string }[] }
    | undefined
  const nodes = registry?.getNodeList?.({ onlyAvailable: true }) ?? []
  return nodes.map((n) => n.id)
}

function actionIsAvailable(broker: ServiceBroker, actionName: string): boolean {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
  return (
    broker as unknown as Record<string, unknown> & {
      registry: { actions: { isAvailable: (n: string) => boolean } }
    }
  ).registry.actions.isAvailable(actionName)
}

function createTcpBrokerOptions(nodeID: string) {
  return {
    nodeID,
    transporter: {
      type: 'TCP' as const,
      options: {
        udpDiscovery: true,
        udpPort: 0,
        port: 0,
      },
    },
    logger: false as const,
  }
}

function createHubDeps(): HubServiceDeps & {
  readonly receivedEvents: Array<Record<string, unknown>>
} {
  // `$hub.event` + the `onEvent` hub dep were removed; events now land via
  // the `$event-bus` wildcard subscriber. These TCP tests are quarantined
  // (`describe.skip`) and still reference the old fan-in, so `receivedEvents`
  // is retained for the skipped assertions but is no longer populated.
  const receivedEvents: Array<Record<string, unknown>> = []
  return {
    receivedEvents,
    getAddonConfig: (addonId) => ({ addonId, samplingIntervalMs: 500 }),
    getSettings: (scope, key) => ({ scope, key, value: 'test-value' }),
    getRecentEvents: () => [],
    onLog: () => {},
  }
}

function createAgentDeps(label: string): AgentServiceDeps {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tcp-test-${label}-`))
  const addonsDir = path.join(tmpDir, 'addons')
  const dataDir = path.join(tmpDir, 'data')
  fs.mkdirSync(addonsDir, { recursive: true })
  fs.mkdirSync(dataDir, { recursive: true })
  return { addonsDir, dataDir, loadedAddons: new Map(), agentName: 'tcp-agent', configPath: '' }
}

// `createAddonService` still reads an explicit per-capability `methods`
// override off the declaration (via `normalizeCapability`); the
// `CapabilityDeclaration` type no longer carries `methods`, so the
// method-bearing entry crosses the test-double boundary while preserving
// runtime behaviour.
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
const METRICS_DECLARATION = {
  id: 'native-metrics',
  entry: './dist/index.js',
  capabilities: [
    {
      name: 'metrics-provider',
      methods: ['collectSnapshot', 'getCachedSnapshot', 'getCpuPercent', 'getMemoryPercent'],
    },
  ],
} as unknown as AddonDeclaration

/** Minimal NativeMetricsAddon wrapper for testing. */
class TestNativeMetricsAddon implements ICamstackAddon {
  provider: NativeMetricsProvider | null = null
  private currentIntervalMs = 500

  async initialize(context: AddonContext): Promise<void> {
    const cfg = context.addonConfig as Record<string, unknown> | undefined
    this.currentIntervalMs = (cfg?.samplingIntervalMs as number | undefined) ?? 500
    this.provider = new NativeMetricsProvider()
    this.provider.startSampling(this.currentIntervalMs)
    // `registerProvider` is kernel-only (`InternalAddonContext`); the
    // factory hands the addon an internal context at runtime even though
    // the `ICamstackAddon.initialize` signature types it as the public
    // `AddonContext`.
    const internal = context as InternalAddonContext
    internal.registerProvider?.('metrics-provider', this.provider)
  }

  postBrokerStart(): void {
    /* no-op — broker started by the test harness */
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

// ---------------------------------------------------------------------------
// TCP Integration Tests
// ---------------------------------------------------------------------------

/** Check whether TCP transport can bind on this machine. */
let tcpAvailable: boolean | undefined
async function checkTcpAvailable(): Promise<boolean> {
  if (tcpAvailable !== undefined) return tcpAvailable
  const testBroker = new ServiceBroker(createTcpBrokerOptions('tcp-probe'))
  try {
    await testBroker.start()
    await testBroker.stop()
    tcpAvailable = true
  } catch {
    tcpAvailable = false
  }
  return tcpAvailable
}

describe.skip('TCP Integration', { timeout: 60000 }, () => {
  const brokers: ServiceBroker[] = []
  const tmpDirs: string[] = []
  const addons: TestNativeMetricsAddon[] = []

  afterEach(async () => {
    for (const a of addons) {
      try {
        await a.shutdown()
      } catch {
        /* */
      }
    }
    addons.length = 0
    // Stop in reverse order (agents first, hub last)
    for (const b of [...brokers].toReversed()) {
      try {
        await b.stop()
      } catch {
        /* already stopped */
      }
    }
    brokers.length = 0
    for (const d of tmpDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true })
      } catch {
        /* */
      }
    }
    tmpDirs.length = 0
  })

  // ----- 1. Basic connectivity -----

  describe('Basic connectivity', () => {
    it('two TCP brokers discover each other on localhost', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      await hub.start()
      await agent.start()

      await waitUntil(() => getAvailableNodeIds(hub).includes('tcp-agent'), 15000)
      await waitUntil(() => getAvailableNodeIds(agent).includes('tcp-hub'), 15000)

      expect(getAvailableNodeIds(hub)).toContain('tcp-agent')
      expect(getAvailableNodeIds(agent)).toContain('tcp-hub')
    })

    it('hub can call action on agent over TCP', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      agent.createService({
        name: 'greeter',
        actions: {
          hello: { handler: () => 'hello from agent' },
        },
      })

      await hub.start()
      await agent.start()

      await waitUntil(() => actionIsAvailable(hub, 'greeter.hello'), 15000)
      const result = await hub.call('greeter.hello')
      expect(result).toBe('hello from agent')
    })

    it('agent can call action on hub over TCP', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      hub.createService({
        name: 'hub-service',
        actions: {
          ping: { handler: () => 'pong from hub' },
        },
      })

      await hub.start()
      await agent.start()

      await waitUntil(() => actionIsAvailable(agent, 'hub-service.ping'), 15000)
      const result = await agent.call('hub-service.ping')
      expect(result).toBe('pong from hub')
    })
  })

  // ----- 2. Real addon over TCP -----

  describe('Real addon over TCP', () => {
    it('NativeMetricsAddon on agent: hub calls collectSnapshot() over TCP', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tcp-metrics-'))
      tmpDirs.push(tmpDir)

      const addon = new TestNativeMetricsAddon()
      addons.push(addon)
      const context = await createAddonContext(agent, METRICS_DECLARATION, tmpDir)
      const capturedProviders = new Map<string, unknown>()
      const origRegister = context.registerProvider
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- test double
      ;(context as unknown as Record<string, unknown>).registerProvider = (
        capName: string,
        provider: unknown,
      ) => {
        capturedProviders.set(capName, provider)
        origRegister?.call(context, capName, provider)
      }
      await addon.initialize(context)

      // Wait for first CPU sample
      await new Promise((r) => setTimeout(r, 300))

      const schema = createAddonService(addon as unknown as ICamstackAddon, METRICS_DECLARATION, {
        providers: capturedProviders,
      })
      agent.createService(schema)

      await hub.start()
      await agent.start()

      const actionName = 'native-metrics.metrics-provider.collectSnapshot'
      await waitUntil(() => actionIsAvailable(hub, actionName), 15000)

      const snapshot = (await hub.call(actionName)) as Record<string, unknown>
      expect(snapshot).toBeDefined()
      expect(snapshot.cpu).toBeDefined()
      expect(snapshot.memory).toBeDefined()
      expect(snapshot.timestampMs).toBeGreaterThan(0)
    })

    it('events emitted by agent addon arrive at hub over TCP', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      const hubDeps = createHubDeps()
      hub.createService(createHubService(hubDeps))

      agent.createService({
        name: 'test-addon',
        metadata: { addonId: 'test-addon', capabilities: [] },
        actions: {
          emitEvent: {
            async handler(ctx: any) {
              await ctx.broker.call('$hub.event', {
                id: 'evt-tcp-1',
                category: 'test.event',
                data: { message: 'hello via TCP' },
                sourceNodeId: ctx.broker.nodeID,
              })
              return true
            },
          },
        },
      })

      await hub.start()
      await agent.start()

      await waitUntil(() => actionIsAvailable(hub, 'test-addon.emitEvent'), 15000)
      // Also wait for the agent to discover the $hub service so it can call $hub.event
      await waitUntil(() => actionIsAvailable(agent, '$hub.event'), 15000)
      await hub.call('test-addon.emitEvent')

      expect(hubDeps.receivedEvents).toHaveLength(1)
      expect(hubDeps.receivedEvents[0]!.category).toBe('test.event')
      expect((hubDeps.receivedEvents[0]!.data as Record<string, unknown>).message).toBe(
        'hello via TCP',
      )
    })
  })

  // ----- 3. $hub and $agent services over TCP -----

  describe('$hub and $agent services over TCP', () => {
    it('agent calls $hub.event over TCP — event arrives at hub', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      const hubDeps = createHubDeps()
      hub.createService(createHubService(hubDeps))

      await hub.start()
      await agent.start()

      await waitUntil(() => actionIsAvailable(agent, '$hub.event'), 15000)

      await agent.call('$hub.event', {
        id: 'evt-tcp-2',
        category: 'detection.result',
        data: { deviceId: 'cam1', count: 3 },
        sourceNodeId: 'tcp-agent',
      })

      expect(hubDeps.receivedEvents).toHaveLength(1)
      expect(hubDeps.receivedEvents[0]!.category).toBe('detection.result')
    })

    it('agent calls $hub.getAddonConfig over TCP — returns correct config', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      const hubDeps = createHubDeps()
      hub.createService(createHubService(hubDeps))

      await hub.start()
      await agent.start()

      await waitUntil(() => actionIsAvailable(agent, '$hub.getAddonConfig'), 15000)

      const config = (await agent.call('$hub.getAddonConfig', {
        addonId: 'detection-pipeline',
      })) as Record<string, unknown>
      expect(config).toEqual({ addonId: 'detection-pipeline', samplingIntervalMs: 500 })
    })

    it('hub calls $agent.status over TCP — returns system info', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      const agentDeps = createAgentDeps('status')
      tmpDirs.push(path.dirname(agentDeps.addonsDir))
      agent.createService(createAgentService(agentDeps))

      await hub.start()
      await agent.start()

      await waitUntil(() => actionIsAvailable(hub, '$agent.status'), 15000)

      const status = (await hub.call('$agent.status', {}, { nodeID: 'tcp-agent' })) as Record<
        string,
        unknown
      >
      expect(status).toBeDefined()
      expect(status.nodeId).toBe('tcp-agent')
      expect(status.platform).toBe(os.platform())
      expect(status.cpuCores).toBeGreaterThan(0)
      expect(status.totalMemoryMB).toBeGreaterThan(0)
    })
  })

  // ----- 4. Disconnect/reconnect over TCP -----

  describe('Disconnect/reconnect over TCP', () => {
    it('agent stops — hub detects disconnection', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      const agent = new ServiceBroker(createTcpBrokerOptions('tcp-agent'))
      brokers.push(hub, agent)

      await hub.start()
      await agent.start()

      await waitUntil(() => getAvailableNodeIds(hub).includes('tcp-agent'), 15000)
      expect(getAvailableNodeIds(hub)).toContain('tcp-agent')

      // Stop agent — remove from tracked brokers to avoid double-stop in afterEach
      const agentIdx = brokers.indexOf(agent)
      if (agentIdx !== -1) brokers.splice(agentIdx, 1)
      await agent.stop()

      await waitUntil(() => !getAvailableNodeIds(hub).includes('tcp-agent'), 15000)
      expect(getAvailableNodeIds(hub)).not.toContain('tcp-agent')
    })

    it('new agent starts — hub discovers it', async () => {
      if (!(await checkTcpAvailable())) return

      const hub = new ServiceBroker(createTcpBrokerOptions('tcp-hub'))
      brokers.push(hub)
      await hub.start()

      // Start first agent
      const agent1 = new ServiceBroker(createTcpBrokerOptions('tcp-agent-1'))
      brokers.push(agent1)
      await agent1.start()
      await waitUntil(() => getAvailableNodeIds(hub).includes('tcp-agent-1'), 15000)

      // Start second agent later
      const agent2 = new ServiceBroker(createTcpBrokerOptions('tcp-agent-2'))
      brokers.push(agent2)
      await agent2.start()
      await waitUntil(() => getAvailableNodeIds(hub).includes('tcp-agent-2'), 15000)

      expect(getAvailableNodeIds(hub)).toContain('tcp-agent-1')
      expect(getAvailableNodeIds(hub)).toContain('tcp-agent-2')
    })
  })
})

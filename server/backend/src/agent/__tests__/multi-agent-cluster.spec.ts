/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment */
/**
 * Multi-agent cluster integration tests.
 *
 * Each agent gets its own ServiceBroker + $agent service (matches
 * production). Tests call the local broker for each agent since Fake
 * transporter doesn't support cross-broker routing. The test validates
 * the agent-side contract that the hub relies on.
 *
 * Validates:
 *   1. Agent identity: stable nodeId, human-readable name, hostname
 *   2. Status reporting: each agent returns its own system info
 *   3. Rename: $agent.rename updates in-memory name + config file
 *   4. Config persistence: nodeId generated once, name survives round-trip
 *   5. Multiple agents have distinct identities
 */
import { describe, it, expect, afterAll } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createAgentService } from '../agent-service.js'
import type { LoadedAddonEntry } from '../agent-service.js'
import { loadAgentConfig } from '../agent-config.js'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AgentFixture {
  broker: ServiceBroker
  nodeId: string
  name: string
  dataDir: string
  configPath: string
  loadedAddons: Map<string, LoadedAddonEntry>
}

function createAgent(opts: {
  nodeId: string
  name: string
  dataDir: string
  addons?: ReadonlyArray<LoadedAddonEntry>
}): AgentFixture {
  const configPath = path.join(opts.dataDir, 'agent.json')
  const loadedAddons = new Map<string, LoadedAddonEntry>((opts.addons ?? []).map((a) => [a.id, a]))

  const broker = new ServiceBroker({
    nodeID: opts.nodeId,
    transporter: 'Fake',
    logger: false,
  })

  const schema = createAgentService({
    addonsDir: path.join(opts.dataDir, 'addons'),
    dataDir: opts.dataDir,
    agentName: opts.name,
    configPath,
    loadedAddons,
  })
  broker.createService(schema)
  // `$agent.restart` delegates to the agent's OWN `$process.restart`
  // (ac79ed4b — real respawn, no longer a fire-and-forget stub). The
  // real `$process` service belongs to the process supervisor, out of
  // scope here — stub the one action the restart path needs.
  broker.createService({
    name: '$process',
    actions: {
      restart: async () => ({ success: true, pid: 4242 }),
    },
  })

  return {
    broker,
    nodeId: opts.nodeId,
    name: opts.name,
    dataDir: opts.dataDir,
    configPath,
    loadedAddons,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Multi-agent cluster', { timeout: 15_000 }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-agent-test-'))
  const agents: AgentFixture[] = []
  const agentDefs = [
    { nodeId: 'agent-aaa11111', name: 'living-room' },
    { nodeId: 'agent-bbb22222', name: 'garage' },
    { nodeId: 'agent-ccc33333', name: 'garden' },
  ]

  // Create and start all agents
  for (const def of agentDefs) {
    const dataDir = path.join(tmpRoot, def.nodeId)
    fs.mkdirSync(dataDir, { recursive: true })
    agents.push(
      createAgent({
        ...def,
        dataDir,
        addons: [
          { id: 'metrics-native', status: 'running', version: '1.0.0' },
          { id: 'decoder-nodeav', status: 'running', version: '1.0.0' },
        ],
      }),
    )
  }

  // Start all brokers before any test runs
  const startedPromise = Promise.all(agents.map((a) => a.broker.start()))

  afterAll(async () => {
    for (const a of agents) {
      try {
        await a.broker.stop()
      } catch {
        /* already stopped */
      }
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  // ── 1. Identity ──────────────────────────────────────────────────

  it('each agent reports its unique nodeId and name in $agent.status', async () => {
    await startedPromise
    for (const agent of agents) {
      const status = (await agent.broker.call('$agent.status')) as Record<string, unknown>
      expect(status.nodeId).toBe(agent.nodeId)
      expect(status.name).toBe(agent.name)
      expect(status.hostname).toBe(os.hostname())
      expect(typeof status.cpuCores).toBe('number')
      expect(status.cpuCores).toBeGreaterThan(0)
      expect(typeof status.uptime).toBe('number')
      expect(status.platform).toBe(os.platform())
      expect(status.arch).toBe(os.arch())
      expect(typeof status.totalMemoryMB).toBe('number')
      expect(Array.isArray(status.localIps)).toBe(true)
    }
  })

  it('each agent reports its loaded addons in status', async () => {
    await startedPromise
    for (const agent of agents) {
      const status = (await agent.broker.call('$agent.status')) as Record<string, unknown>
      const addons = status.addons as readonly { id: string; status: string; version?: string }[]
      expect(addons).toHaveLength(2)
      const ids = addons.map((a) => a.id).toSorted()
      expect(ids).toEqual(['decoder-nodeav', 'metrics-native'])
      expect(addons.every((a) => a.status === 'running')).toBe(true)
    }
  })

  it('all 3 agents have distinct identities', async () => {
    await startedPromise
    const statuses = await Promise.all(
      agents.map((a) => a.broker.call('$agent.status') as Promise<Record<string, unknown>>),
    )
    const nodeIds = new Set(statuses.map((s) => s.nodeId as string))
    const names = new Set(statuses.map((s) => s.name as string))
    expect(nodeIds.size).toBe(3)
    expect(names.size).toBe(3)
    expect(names).toContain('living-room')
    expect(names).toContain('garage')
    expect(names).toContain('garden')
  })

  // ── 2. Rename ────────────────────────────────────────────────────

  it('$agent.rename updates in-memory name immediately', async () => {
    await startedPromise
    const agent = agents[1]! // garage

    const result = (await agent.broker.call('$agent.rename', { name: 'back-yard' })) as {
      success: boolean
      name: string
    }
    expect(result.success).toBe(true)
    expect(result.name).toBe('back-yard')

    // Subsequent status call reflects the new name
    const status = (await agent.broker.call('$agent.status')) as Record<string, unknown>
    expect(status.name).toBe('back-yard')
  })

  it('$agent.rename persists to config file', async () => {
    await startedPromise
    const agent = agents[2]! // garden

    await agent.broker.call('$agent.rename', { name: 'rooftop' })

    // Read the config file — name should be persisted
    expect(fs.existsSync(agent.configPath)).toBe(true)
    const configContent = JSON.parse(fs.readFileSync(agent.configPath, 'utf-8')) as Record<
      string,
      unknown
    >
    expect(configContent.name).toBe('rooftop')
  })

  it('$agent.rename trims whitespace', async () => {
    await startedPromise
    const agent = agents[0]! // living-room

    await agent.broker.call('$agent.rename', { name: '  kitchen  ' })

    const status = (await agent.broker.call('$agent.status')) as Record<string, unknown>
    expect(status.name).toBe('kitchen')

    // Config file also gets the trimmed value
    const configContent = JSON.parse(fs.readFileSync(agent.configPath, 'utf-8')) as Record<
      string,
      unknown
    >
    expect(configContent.name).toBe('kitchen')
  })

  it('$agent.rename rejects empty name', async () => {
    await startedPromise
    const agent = agents[0]!

    await expect(agent.broker.call('$agent.rename', { name: '' })).rejects.toThrow()
  })

  it('multiple renames preserve latest value', async () => {
    await startedPromise
    const agent = agents[1]! // was garage, renamed to back-yard

    await agent.broker.call('$agent.rename', { name: 'patio' })
    await agent.broker.call('$agent.rename', { name: 'terrace' })
    await agent.broker.call('$agent.rename', { name: 'balcony' })

    const status = (await agent.broker.call('$agent.status')) as Record<string, unknown>
    expect(status.name).toBe('balcony')

    const config = JSON.parse(fs.readFileSync(agent.configPath, 'utf-8')) as Record<string, unknown>
    expect(config.name).toBe('balcony')
  })

  // ── 3. Config persistence ───────────────────────────────────────

  it('loadAgentConfig reads persisted name from config file', () => {
    const agent = agents[2]! // rooftop (renamed)

    // Write a complete config file
    const configData = {
      nodeId: agent.nodeId,
      name: 'rooftop',
      hubAddress: 'ws://localhost:4443/agent',
    }
    fs.writeFileSync(agent.configPath, JSON.stringify(configData, null, 2))

    const config = loadAgentConfig(path.basename(agent.configPath), agent.dataDir)
    expect(config.name).toBe('rooftop')
    expect(config.nodeId).toBe(agent.nodeId)
    expect(config.hubAddress).toBe('ws://localhost:4443/agent')
  })

  it('ensurePersistedNodeId generates a stable ID on first boot', () => {
    const freshDir = path.join(tmpRoot, 'fresh-agent')
    fs.mkdirSync(freshDir, { recursive: true })
    const configFile = path.join(freshDir, 'agent.json')
    expect(fs.existsSync(configFile)).toBe(false)

    // Set env to trigger the env-var path
    const saved = {
      hub: process.env.CAMSTACK_HUB_ADDRESS,
      name: process.env.CAMSTACK_AGENT_NAME,
    }
    try {
      process.env.CAMSTACK_HUB_ADDRESS = 'ws://localhost:4443/agent'
      process.env.CAMSTACK_AGENT_NAME = 'fresh-agent'

      const config = loadAgentConfig('agent.json', freshDir)
      expect(config.nodeId).toMatch(/^agent-[a-f0-9]{8}$/)
      expect(config.name).toBe('fresh-agent')

      // Config file should now exist with the persisted nodeId
      expect(fs.existsSync(configFile)).toBe(true)
      const persisted = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>
      expect(persisted.nodeId).toBe(config.nodeId)

      // Second call returns the same ID (stable)
      const config2 = loadAgentConfig('agent.json', freshDir)
      expect(config2.nodeId).toBe(config.nodeId)
    } finally {
      if (saved.hub) process.env.CAMSTACK_HUB_ADDRESS = saved.hub
      else delete process.env.CAMSTACK_HUB_ADDRESS
      if (saved.name) process.env.CAMSTACK_AGENT_NAME = saved.name
      else delete process.env.CAMSTACK_AGENT_NAME
    }
  })

  // ── 4. Addon management ─────────────────────────────────────────

  it('$agent.listAddons returns loaded addon ids', async () => {
    await startedPromise
    for (const agent of agents) {
      const result = (await agent.broker.call('$agent.listAddons')) as readonly string[]
      expect(result).toContain('metrics-native')
      expect(result).toContain('decoder-nodeav')
      expect(result).toHaveLength(2)
    }
  })

  it('$agent.undeploy removes addon from loaded map', async () => {
    await startedPromise
    const agent = agents[2]!
    const before = (await agent.broker.call('$agent.listAddons')) as readonly string[]
    expect(before).toContain('decoder-nodeav')

    const result = (await agent.broker.call('$agent.undeploy', {
      addonId: 'decoder-nodeav',
    })) as { success: boolean }
    expect(result.success).toBe(true)

    const after = (await agent.broker.call('$agent.listAddons')) as readonly string[]
    expect(after).not.toContain('decoder-nodeav')
    expect(after).toContain('metrics-native')
  })

  // ── 5. Lifecycle ────────────────────────────────────────────────

  it('$agent.restart delegates to the own-node $process.restart and returns the pid', async () => {
    await startedPromise
    const agent = agents[0]!
    const result = (await agent.broker.call('$agent.restart', {
      addonId: 'metrics-native',
    })) as { success: boolean; addonId: string; pid: number }
    expect(result.success).toBe(true)
    expect(result.addonId).toBe('metrics-native')
    expect(result.pid).toBe(4242)
  })
})

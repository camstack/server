/**
 * Unit tests for the `hubConnectionState` derivation added in P1.
 *
 * `deriveHubConnectionState` is internal to `agent-http.ts` and not
 * exported — we test it indirectly via the `/api/agent/status` response
 * shape, which is the public contract the UI consumes.
 *
 * Uses Fastify's `inject` for lightweight in-process HTTP testing without
 * a real network socket or a live Moleculer broker.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createAgentHttpServer } from '../agent-http.js'
import type { AgentHttpConfig, HubConnectionState } from '../agent-http.js'
import type { ServiceBroker } from 'moleculer'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { writePairedConfig } from './helpers/paired-agent.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal broker stub that lets the status endpoint succeed. */
function makeStubBroker(opts: {
  nodeID?: string
  hubInRegistry?: boolean
  statusResponse?: Record<string, unknown>
}): ServiceBroker {
  const availableNodes: readonly { id: string }[] = opts.hubInRegistry ? [{ id: 'hub' }] : []
  return {
    nodeID: opts.nodeID ?? 'test-agent',
    call: async (_action: string) => {
      return (
        opts.statusResponse ?? {
          nodeId: opts.nodeID ?? 'test-agent',
          name: 'test-agent',
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname(),
          cpuCores: 2,
          totalMemoryMB: 4096,
          freeMemoryMB: 2048,
          cpuPercent: 0,
          memoryPercent: 0,
          uptime: 0,
          localIps: [],
          addons: [],
        }
      )
    },
    registry: {
      getNodeList: (_opts: { onlyAvailable: boolean }) => availableNodes,
    },
  } as unknown as ServiceBroker
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-connstate-'))
}

function makeConfig(tmpDir: string, partial: Partial<AgentHttpConfig> = {}): AgentHttpConfig {
  const configPath = path.join(tmpDir, 'agent.json')
  return {
    port: 0,
    nodeId: 'test-agent',
    dataDir: tmpDir,
    configPath,
    ...partial,
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('agent-http hubConnectionState', () => {
  const tmpDir = makeTempDir()
  const servers: Array<{ close: () => Promise<void> }> = []

  afterAll(async () => {
    for (const s of servers) {
      await s.close()
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function getStatus(
    broker: ServiceBroker,
    config: AgentHttpConfig,
  ): Promise<Record<string, unknown>> {
    const app = await createAgentHttpServer(() => broker, config)
    servers.push({ close: () => app.close() })
    const res = await app.inject({ method: 'GET', url: '/api/agent/status' })
    return res.json() as Record<string, unknown>
  }

  it('returns hubConnectionState="connected" when hub is in Moleculer registry', async () => {
    const broker = makeStubBroker({ hubInRegistry: true })
    const status = await getStatus(broker, makeConfig(tmpDir))
    expect(status['hubConnectionState']).toBe<HubConnectionState>('connected')
    expect(status['hubConnected']).toBe(true)
  })

  it('returns hubConnectionState="unpaired" while the agent holds no mesh certificate', async () => {
    const broker = makeStubBroker({ hubInRegistry: false })
    const status = await getStatus(broker, makeConfig(tmpDir))
    expect(status['hubConnectionState']).toBe<HubConnectionState>('unpaired')
    expect(status['paired']).toBe(false)
    expect(status['hubConnected']).toBe(false)
    expect(status).not.toHaveProperty('discoveryMode')
  })

  it('returns hubConnectionState="disconnected" when paired with a hub address and no hub in registry', async () => {
    const broker = makeStubBroker({ hubInRegistry: false })
    // Write a hubAddress to the config file so the endpoint sees direct mode.
    const subDir = path.join(tmpDir, 'disconnected')
    fs.mkdirSync(subDir, { recursive: true })
    const configPath = path.join(subDir, 'agent.json')
    await writePairedConfig(configPath, 'test-agent')
    const config = makeConfig(subDir, { configPath })
    const status = await getStatus(broker, config)
    expect(status['hubConnectionState']).toBe<HubConnectionState>('disconnected')
    expect(status['paired']).toBe(true)
  })

  it('returns hubConnectionState="unconfigured" when paired but no hub address is configured', async () => {
    const broker = makeStubBroker({ hubInRegistry: false })
    const subDir = path.join(tmpDir, 'unconfigured')
    fs.mkdirSync(subDir, { recursive: true })
    const configPath = path.join(subDir, 'agent.json')
    await writePairedConfig(configPath, 'test-agent')
    const written = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    delete written['hubAddress']
    fs.writeFileSync(configPath, JSON.stringify(written))
    const status = await getStatus(broker, makeConfig(subDir, { configPath }))
    expect(status['hubConnectionState']).toBe<HubConnectionState>('unconfigured')
  })

  it('returns hubConnectionState="certificate-rejected" when getHubConnectionState override says so', async () => {
    const broker = makeStubBroker({ hubInRegistry: false })
    // Simulate what agent-bootstrap does after a certificate-rejected error:
    // inject a getter that returns "certificate-rejected" regardless of registry state.
    const config = makeConfig(tmpDir, {
      getHubConnectionState: () => 'certificate-rejected' as HubConnectionState,
    })
    const status = await getStatus(broker, config)
    expect(status['hubConnectionState']).toBe<HubConnectionState>('certificate-rejected')
  })
})

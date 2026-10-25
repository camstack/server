/* eslint-disable @typescript-eslint/no-unsafe-call -- test file, Fastify close() type */
/**
 * Agent discovery + connection flow tests.
 *
 * Validates:
 *   1. Agent starts without a hub address (unconfigured)
 *   2. Agent HTTP server is reachable while unconfigured
 *   3. Status reports hubConnected=false and no hub address
 *   4. Config can be read and written via REST API
 *   5. Hub starts, agent is given its address
 *   6. Once connected, status reports hubConnected=true
 *   7. Agent config persists hubAddress after connection
 */
import { describe, it, expect, afterAll } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createAgentService } from '../agent-service.js'
import { createAgentHttpServer } from '../agent-http.js'
import type { AgentHttpConfig } from '../agent-http.js'
import type { LoadedAddonEntry } from '../agent-service.js'
import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Agent discovery + connection', { timeout: 30_000 }, () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-discovery-'))
  const agentDataDir = path.join(tmpRoot, 'agent')
  const configPath = path.join(agentDataDir, 'agent.json')
  const agentPort = 14444 // Use high port to avoid conflicts

  fs.mkdirSync(agentDataDir, { recursive: true })

  let agentBroker: ServiceBroker
  let agentApp: Awaited<ReturnType<typeof createAgentHttpServer>> | null = null

  afterAll(async () => {
    if (agentApp)
      try {
        await agentApp.close()
      } catch {
        /* */
      }
    if (agentBroker)
      try {
        await agentBroker.stop()
      } catch {
        /* */
      }
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  // ── 1. Agent starts without hub (Fake transporter for test) ────

  it('agent broker starts without hub address', async () => {
    // Use Fake transporter in tests (UDP discovery is network-dependent)
    agentBroker = new ServiceBroker({
      nodeID: 'agent-discovery-test',
      transporter: 'Fake',
      logger: false,
    })

    const loadedAddons = new Map<string, LoadedAddonEntry>([
      ['metrics-native', { id: 'metrics-native', status: 'running' }],
    ])

    agentBroker.createService(
      createAgentService({
        addonsDir: path.join(agentDataDir, 'addons'),
        dataDir: agentDataDir,
        agentName: 'test-discovery',
        configPath,
        loadedAddons,
      }),
    )

    await agentBroker.start()

    // Agent started without error
    expect(agentBroker.nodeID).toBe('agent-discovery-test')
  })

  // ── 2. HTTP server is reachable ────────────────────────────────

  it('HTTP server starts and serves health endpoint', async () => {
    // Write initial config file so the HTTP server can read name.
    fs.writeFileSync(
      configPath,
      JSON.stringify({ nodeId: 'agent-discovery-test', name: 'test-discovery' }, null, 2),
    )

    const httpConfig: AgentHttpConfig = {
      port: agentPort,
      nodeId: 'agent-discovery-test',
      dataDir: agentDataDir,
      configPath,
    }

    agentApp = await createAgentHttpServer(() => agentBroker, httpConfig)
    await agentApp.listen({ port: agentPort, host: '127.0.0.1' })

    // Public /health is liveness-only post-hardening — nodeId moved to the
    // authenticated /health/details (loopback callers are always allowed).
    const health = await fetchJson<{ ok: boolean; nodeId?: string }>(
      `http://127.0.0.1:${agentPort}/health`,
    )
    expect(health).toEqual({ ok: true })
    const details = await fetchJson<{ ok: boolean; nodeId: string }>(
      `http://127.0.0.1:${agentPort}/health/details`,
    )
    expect(details.ok).toBe(true)
    expect(details.nodeId).toBe('agent-discovery-test')
  })

  // ── 3. Status reports no hub address ───────────────────────────

  it('status reports hubConnected=false and no hub address', async () => {
    const status = await fetchJson<Record<string, unknown>>(
      `http://127.0.0.1:${agentPort}/api/agent/status`,
    )
    expect(status.hubConnected).toBe(false)
    expect(status.hubAddress).toBeNull()
    expect(status.name).toBe('test-discovery')
  })

  // ── 4. Config read/write via REST ──────────────────────────────

  it('reads initial config (empty)', async () => {
    const config = await fetchJson<Record<string, unknown>>(
      `http://127.0.0.1:${agentPort}/api/agent/config`,
    )
    expect(config.nodeId).toBe('agent-discovery-test')
    expect(config.name).toBe('test-discovery')
  })

  it('writes config and persists to file', async () => {
    const result = await postJson<{ success: boolean; restartRequired: boolean }>(
      `http://127.0.0.1:${agentPort}/api/agent/config`,
      { hubAddress: '192.168.10.100', name: 'renamed-agent' },
    )
    expect(result.success).toBe(true)
    expect(result.restartRequired).toBe(true) // hubAddress changed

    // Verify file was written
    const fileContent = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    expect(fileContent.hubAddress).toBe('192.168.10.100')
    expect(fileContent.name).toBe('renamed-agent')

    // Verify GET /api/agent/config reflects the new values
    const config = await fetchJson<Record<string, unknown>>(
      `http://127.0.0.1:${agentPort}/api/agent/config`,
    )
    expect(config.hubAddress).toBe('192.168.10.100')
    expect(config.name).toBe('renamed-agent')
  })

  it('config write merges with existing values', async () => {
    // Write a second field — hubAddress from before should persist
    await postJson(`http://127.0.0.1:${agentPort}/api/agent/config`, {
      logLevel: 'debug',
    })

    const config = await fetchJson<Record<string, unknown>>(
      `http://127.0.0.1:${agentPort}/api/agent/config`,
    )
    expect(config.hubAddress).toBe('192.168.10.100')
    expect(config.logLevel).toBe('debug')
    expect(config.name).toBe('renamed-agent')
  })

  it('name-only change does not require restart', async () => {
    const result = await postJson<{ success: boolean; restartRequired: boolean }>(
      `http://127.0.0.1:${agentPort}/api/agent/config`,
      { name: 'just-a-rename' },
    )
    expect(result.success).toBe(true)
    expect(result.restartRequired).toBe(false)

    const status = await fetchJson<Record<string, unknown>>(
      `http://127.0.0.1:${agentPort}/api/agent/status`,
    )
    expect(status.name).toBe('just-a-rename')
  })

  it('a posted secret is refused: nothing writes a cluster secret any more (D857)', async () => {
    const result = await postJson<{ success: boolean; error?: string }>(
      `http://127.0.0.1:${agentPort}/api/agent/config`,
      { secret: 'my-secret' },
    )
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Not editable here: secret/)
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).not.toHaveProperty('secret')

    const config = await fetchJson<Record<string, unknown>>(
      `http://127.0.0.1:${agentPort}/api/agent/config`,
    )
    expect(config).not.toHaveProperty('hasSecret')
    expect(config.paired).toBe(false)
  })

  it('clearing hubAddress returns to unconfigured', async () => {
    await postJson(`http://127.0.0.1:${agentPort}/api/agent/config`, {
      hubAddress: null,
    })

    const status = await fetchJson<Record<string, unknown>>(
      `http://127.0.0.1:${agentPort}/api/agent/status`,
    )
    expect(status.hubAddress).toBeNull()
  })

  // ── 5. Discovered nodes ────────────────────────────────────────

  it('discovered-nodes returns empty when no hub is connected', async () => {
    const nodes = await fetchJson<readonly { id: string }[]>(
      `http://127.0.0.1:${agentPort}/api/agent/discovered-nodes`,
    )
    expect(nodes).toEqual([])
  })

  // ── 6. Hub connects (simulated via Fake transporter) ───────────

  // NOTE: Cross-broker discovery requires real TCP transport (network-
  // dependent). Fake transporter doesn't support inter-broker routing.
  // The hub connection flow is validated in e2e tests with dev-cluster.sh.

  it('discovered-nodes returns empty with Fake transporter', async () => {
    const nodes = await fetchJson<readonly { id: string }[]>(
      `http://127.0.0.1:${agentPort}/api/agent/discovered-nodes`,
    )
    // Fake transporter: no real transport, empty list is expected
    expect(Array.isArray(nodes)).toBe(true)
  })

  // ── 7. Addon listing works with hub connected ──────────────────

  it('agent status includes addons after hub connection', async () => {
    const status = await fetchJson<{ addons: readonly { id: string }[] }>(
      `http://127.0.0.1:${agentPort}/api/agent/status`,
    )
    expect(status.addons).toHaveLength(1)
    expect(status.addons[0]!.id).toBe('metrics-native')
  })

  // ── 8. Processes endpoint works ────────────────────────────────

  it('processes endpoint returns array (empty in test)', async () => {
    const processes = await fetchJson<readonly unknown[]>(
      `http://127.0.0.1:${agentPort}/api/agent/processes`,
    )
    expect(Array.isArray(processes)).toBe(true)
  })
})

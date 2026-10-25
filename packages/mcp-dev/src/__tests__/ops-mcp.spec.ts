import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HubClient } from '@camstack/develop'
import { annotationsFor } from '../annotations.js'
import { parseApiIndex } from '../ops/api-index.js'
import { createGatedHub } from '../ops/hub.js'
import { createServer } from '../server.js'
import { OPS_TOOLSETS, DEV_TOOLSETS } from '../toolsets.js'

const INDEX = parseApiIndex(
  [
    '| `addons.listCapabilityProviders` | query | protected | addons |',
    '| `nodes.topology` | query | admin | nodes |',
    '| `nodes.restartNode` | mutation | admin | nodes |',
    '| `addonSettings.getGlobalSettings` | query | protected | addon-settings |',
  ].join('\n'),
)

const OPS_TOOLS = [
  'ops_status',
  'hub_query',
  'topology',
  'cap_providers',
  'recent_tracks',
  'track',
  'audit_tracks',
  'log_providers',
  'hub_logs',
  'loki_query',
  'model_pin_census',
  'retrain_census',
  'keyframe_presence',
]

describe('camstack-ops over MCP (in-memory)', () => {
  const sent: string[] = []
  const client: HubClient = {
    async call(_method, path) {
      sent.push(path)
      if (path === 'addonSettings.getGlobalSettings') {
        return {
          sections: [
            {
              fields: [
                { key: 'url', type: 'text', value: 'https://example.test' },
                { key: 'apiAccess', type: 'password', value: 'super-secret-value-1' },
              ],
            },
          ],
        }
      }
      return []
    },
  }
  const hub = createGatedHub({
    server: 'https://hub.example.test',
    tier: 'protected',
    source: 'session',
    index: INDEX,
    client,
  })
  const mcp = new Client({ name: 'ops-test', version: '0.0.0' })

  beforeAll(async () => {
    const server = createServer(OPS_TOOLSETS, { hub })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), mcp.connect(b)])
  })
  afterAll(async () => {
    await mcp.close()
  })

  it('lists every ops tool, and none of the offline dev tools', async () => {
    const names = (await mcp.listTools()).tools.map((t) => t.name)
    for (const t of OPS_TOOLS) expect(names, `missing ${t}`).toContain(t)
    expect(names).not.toContain('scaffold_capability')
    expect(names).not.toContain('ops_not_implemented')
  })

  it('annotates every ops tool read-only and open-world, none destructive', async () => {
    const tools = (await mcp.listTools()).tools.filter((t) => OPS_TOOLS.includes(t.name))
    expect(tools).toHaveLength(OPS_TOOLS.length)
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(true)
      expect(t.annotations?.destructiveHint, t.name).toBe(false)
      expect(t.annotations?.openWorldHint, t.name).toBe(true)
    }
  })

  it('refuses a mutation through hub_query and never sends it', async () => {
    const r = await mcp.callTool({ name: 'hub_query', arguments: { path: 'nodes.restartNode' } })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toMatch(/read-only/)
    expect(sent).not.toContain('nodes.restartNode')
  })

  it('refuses an admin-tier query with a protected credential and never sends it', async () => {
    const r = await mcp.callTool({ name: 'hub_query', arguments: { path: 'nodes.topology' } })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toMatch(/admin-tier|admin-scoped/)
    expect(sent).not.toContain('nodes.topology')
  })

  it('redacts a declared secret field in a hub_query answer', async () => {
    const r = await mcp.callTool({
      name: 'hub_query',
      arguments: { path: 'addonSettings.getGlobalSettings', input: { addonId: 'x' } },
    })
    const text = JSON.stringify(r.content)
    expect(text).not.toContain('super-secret-value')
    expect(text).toContain('https://example.test')
  })

  it('hub_logs asks which provider instead of querying one', async () => {
    const r = await mcp.callTool({ name: 'hub_logs', arguments: {} })
    expect(JSON.stringify(r.content)).toContain('Which log source')
  })
})

describe('camstack-dev (offline) tool surface', () => {
  it('every offline tool carries an annotation class', async () => {
    const server = createServer(DEV_TOOLSETS)
    const mcp = new Client({ name: 'dev-test', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), mcp.connect(b)])
    const tools = (await mcp.listTools()).tools
    expect(tools.length).toBeGreaterThan(20)
    for (const t of tools) {
      expect(t.annotations, t.name).toBeDefined()
      expect(() => annotationsFor(t.name)).not.toThrow()
      expect(t.annotations?.openWorldHint, t.name).toBe(false)
    }
    expect(tools.map((t) => t.name)).not.toContain('hub_query')
    await mcp.close()
  })
})

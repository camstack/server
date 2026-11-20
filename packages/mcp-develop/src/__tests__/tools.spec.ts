import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { registerDevelopTools, type RegisterDevelopOptions } from '../register.js'
import { findWorkspaceRoot, listAddonPackages, listSkills, readSkill } from '@camstack/develop'

describe('mcp-develop wiring (library surface)', () => {
  it('resolves the workspace and lists addons + skills', () => {
    const root = findWorkspaceRoot()
    expect(root).toBeTruthy()
    if (!root) return
    expect(listAddonPackages(root).length).toBeGreaterThan(5)
    const skills = listSkills()
    expect(skills.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'camstack-addon',
        'camstack-capability',
        'camstack-secrets',
        'camstack-docs',
        'architecture',
        'track-review',
      ]),
    )
    // The pre-rename ids still resolve, to the renamed files.
    expect(readSkill('track-review')?.content).toContain('track_review_apply')
    expect(readSkill('add-addon')?.info.id).toBe('camstack-addon')
    expect(readSkill('sync-docs')?.content).toContain('name: camstack-docs')
  })
})

describe('registerDevelopTools options', () => {
  async function toolNames(options?: RegisterDevelopOptions): Promise<string[]> {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerDevelopTools(server, options)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const { tools } = await client.listTools()
    return tools.map((t) => t.name).sort()
  }

  it('registers only the named tools, and no track review, when `only` is given', async () => {
    expect(await toolNames({ only: ['list_addons', 'validate_addon'] })).toEqual([
      'list_addons',
      'validate_addon',
    ])
  })

  it('registers everything, track review included, with no options', async () => {
    const all = await toolNames()
    expect(all).toContain('scaffold_cap_stub')
    expect(all.some((n) => n.startsWith('track_review_'))).toBe(true)
  })
})

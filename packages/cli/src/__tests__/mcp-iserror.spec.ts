import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MutationGate, type ConnectOutcome } from '@camstack/develop'
import type { McpContext } from '../mcp/context.js'
import { createPublicServer } from '../mcp/server.js'

const NO_SESSION: ConnectOutcome = {
  ok: false,
  reason: 'no-session',
  message: 'no usable hub session',
  action: 'run `camstack login <host>` in a terminal',
}

function context(hub: () => Promise<ConnectOutcome>): McpContext {
  return {
    cliVersion: '9.9.9',
    hub,
    gate: new MutationGate({ allowMutations: true }),
    fetch: async () => new Response('{}'),
  }
}

async function connect(ctx: McpContext): Promise<Client> {
  const server = createPublicServer({ toolsets: ['ops'], context: ctx })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(b)
  const client = new Client({ name: 't', version: '1' })
  await client.connect(a)
  return client
}

describe('MCP tool failures carry isError', () => {
  it('a no-session answer is an error result with a readable message', async () => {
    const client = await connect(context(async () => NO_SESSION))
    const res = await client.callTool({ name: 'ops_status', arguments: {} })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('camstack login')
  })

  it('a throwing tool yields isError true with the message', async () => {
    const client = await connect(
      context(async () => {
        throw new Error('hub exploded')
      }),
    )
    const res = await client.callTool({ name: 'ops_status', arguments: {} })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('hub exploded')
  })

  it('a healthy answer is not an error', async () => {
    const ok: ConnectOutcome = {
      ok: true,
      connection: {
        server: 'https://hub.example.test',
        token: 'tok-never-printed',
        tier: 'admin',
        source: 'session',
        tls: {},
        client: { call: async () => null },
        adminHint: null,
        loginCommand: 'camstack login',
      },
    }
    const client = await connect(context(async () => ok))
    const res = await client.callTool({ name: 'ops_whoami', arguments: {} })
    expect(res.isError).toBeUndefined()
    expect(JSON.stringify(res.content)).not.toContain('tok-never-printed')
  })
})

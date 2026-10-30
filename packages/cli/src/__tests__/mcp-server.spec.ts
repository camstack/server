import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  MutationGate,
  type AuditRecord,
  type ConnectOutcome,
  type HubClient,
  type HubHttpMethod,
} from '@camstack/develop'
import type { McpContext } from '../mcp/context.js'
import { createPublicServer } from '../mcp/server.js'
import type { Toolset } from '../mcp/toolsets.js'

interface Call {
  readonly method: HubHttpMethod
  readonly path: string
  readonly input: unknown
}

function fakeHubClient(deviceName: string | null): {
  client: HubClient
  calls: Call[]
} {
  const calls: Call[] = []
  return {
    calls,
    client: {
      async call(method, path, input) {
        calls.push({ method, path, input })
        if (path === 'deviceManager.getDevice') {
          return deviceName === null ? null : { id: 7, name: deviceName }
        }
        return null
      },
    },
  }
}

function connected(client: HubClient, tier: 'admin' | 'protected' = 'admin'): ConnectOutcome {
  return {
    ok: true,
    connection: {
      server: 'https://hub.example.test',
      token: 'tok-should-never-appear-in-output',
      tier,
      source: 'session',
      tls: {},
      client,
      adminHint: tier === 'admin' ? null : 'log in as admin',
      loginCommand: 'camstack login',
    },
  }
}

const NO_SESSION: ConnectOutcome = {
  ok: false,
  reason: 'no-session',
  message: 'no usable hub session',
  action: 'run `camstack login <host>` in a terminal',
}

function context(hub: ConnectOutcome, audit: AuditRecord[] = []): McpContext {
  return {
    cliVersion: '9.9.9',
    hub: async () => hub,
    gate: new MutationGate({
      allowMutations: true,
      audit: (r) => audit.push(r),
    }),
    fetch: async (url) =>
      new Response(JSON.stringify({ version: url.includes('server') ? '2.0.0' : '1.0.0' })),
  }
}

async function connect(
  toolsets: readonly Toolset[],
  ctx: McpContext,
  registerDevelop?: (server: McpServer) => void,
): Promise<Client> {
  const server = createPublicServer({
    toolsets,
    context: ctx,
    ...(registerDevelop ? { registerDevelop } : {}),
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  return client
}

async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map((t) => t.name).toSorted()
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = Array.isArray(result.content) ? result.content : []
  const first = content[0]
  return first && first.type === 'text' ? first.text : ''
}

const OPS_TOOLS = [
  'ops_accelerators',
  'ops_device',
  'ops_events',
  'ops_logs',
  'ops_status',
  'ops_track',
  'ops_unhealthy_devices',
  'ops_whoami',
]

describe('camstack mcp — toolset selection', () => {
  const ctx = context(NO_SESSION)

  it('serves setup, ops and configure by default, and no develop tools', async () => {
    const client = await connect(['setup', 'ops', 'configure'], ctx, () => {
      throw new Error('develop must not register')
    })
    expect(await toolNames(client)).toEqual([
      'configure_addon_install',
      'configure_addon_uninstall',
      'configure_addon_update',
      'configure_addons_search',
      'configure_camera_add',
      'configure_camera_discover',
      'configure_camera_providers',
      'configure_notification_target_test',
      'configure_notification_target_upsert',
      'configure_notification_targets',
      'configure_notifiers',
      'configure_rename_device',
      ...OPS_TOOLS,
      'setup_about',
      'setup_add_node',
      'setup_connect',
      'setup_discover_hubs',
      'setup_install_guide',
    ])
  })

  it('serves only the named toolset', async () => {
    expect(await toolNames(await connect(['setup'], ctx))).toContain('setup_about')
    expect(await toolNames(await connect(['ops'], ctx))).toEqual(OPS_TOOLS)
  })

  it('develop registers through the injected shared registration', async () => {
    const client = await connect(['develop'], ctx, (server) => {
      server.tool('list_addons', 'stand-in for the mcp-develop registration', {}, async () => ({
        content: [{ type: 'text', text: '[]' }],
      }))
    })
    expect(await toolNames(client)).toEqual(['list_addons'])
  })
})

describe('camstack mcp — hub-less and session behaviour', () => {
  it('setup_about needs no hub: versions and host kinds', async () => {
    const client = await connect(['setup'], context(NO_SESSION))
    const body = firstText(await client.callTool({ name: 'setup_about', arguments: {} }))
    expect(body).toContain('9.9.9')
    expect(body).toContain('2.0.0')
    expect(body).toContain('unraid')
  })

  it('without a session a hub tool answers "run camstack login", it does not throw', async () => {
    const client = await connect(['ops', 'configure'], context(NO_SESSION))
    const who = await client.callTool({ name: 'ops_whoami', arguments: {} })
    expect(who.isError).not.toBe(true)
    expect(firstText(who)).toContain('"status": "no-session"')
    expect(firstText(who)).toContain('camstack login')
    const rename = await client.callTool({
      name: 'configure_rename_device',
      arguments: { deviceId: 7, name: 'Porch' },
    })
    expect(rename.isError).not.toBe(true)
    expect(firstText(rename)).toContain('camstack login')
  })

  it('ops_whoami names the hub and never prints the credential', async () => {
    const { client } = fakeHubClient('Old')
    const mcp = await connect(['ops'], context(connected(client)))
    const body = firstText(await mcp.callTool({ name: 'ops_whoami', arguments: {} }))
    expect(body).toContain('https://hub.example.test')
    expect(body).not.toContain('tok-should-never-appear')
  })
})

describe('camstack mcp — configure writes are two-step through the gate', () => {
  async function rename(
    mcp: Client,
    args: { deviceId: number; name: string; confirm_token?: string },
  ): Promise<string> {
    return firstText(await mcp.callTool({ name: 'configure_rename_device', arguments: args }))
  }

  it('a call without a token previews and writes nothing', async () => {
    const { client, calls } = fakeHubClient('Old')
    const mcp = await connect(['configure'], context(connected(client)))
    const body = await rename(mcp, { deviceId: 7, name: 'Porch' })
    expect(body).toContain('"status": "dry-run"')
    expect(body).toContain('"from": "Old"')
    expect(body).toContain('cfm_')
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('the token applies exactly the previewed arguments, once', async () => {
    const { client, calls } = fakeHubClient('Old')
    const mcp = await connect(['configure'], context(connected(client)))
    const preview = await rename(mcp, { deviceId: 7, name: 'Porch' })
    const token = /cfm_[0-9a-f]+/.exec(preview)?.[0] ?? ''
    expect(await rename(mcp, { deviceId: 7, name: 'Porch', confirm_token: token })).toContain(
      '"status": "executed"',
    )
    const writes = calls.filter((c) => c.method === 'POST')
    expect(writes).toEqual([
      {
        method: 'POST',
        path: 'deviceManager.setName',
        input: { deviceId: 7, name: 'Porch' },
      },
    ])
    // single use
    expect(await rename(mcp, { deviceId: 7, name: 'Porch', confirm_token: token })).toContain(
      '"status": "refused"',
    )
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1)
  })

  it('a token does not apply different arguments', async () => {
    const { client, calls } = fakeHubClient('Old')
    const mcp = await connect(['configure'], context(connected(client)))
    const preview = await rename(mcp, { deviceId: 7, name: 'Porch' })
    const token = /cfm_[0-9a-f]+/.exec(preview)?.[0] ?? ''
    const body = await rename(mcp, {
      deviceId: 7,
      name: 'Garage',
      confirm_token: token,
    })
    expect(body).toContain('"status": "refused"')
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('a non-admin credential is refused before any hub call', async () => {
    const { client, calls } = fakeHubClient('Old')
    const mcp = await connect(['configure'], context(connected(client, 'protected')))
    expect(await rename(mcp, { deviceId: 7, name: 'Porch' })).toContain('"status": "refused"')
    expect(calls).toHaveLength(0)
  })
})

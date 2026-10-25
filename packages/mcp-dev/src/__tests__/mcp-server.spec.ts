import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireWorkspaceRoot } from '@camstack/develop'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '../..')
const SERVER_JS = path.join(PKG_ROOT, 'dist', 'server.js')

/**
 * Generous ceilings, not expectations: every wait ends on a CONDITION (the
 * server answering `initialize`, a tool answering its call), so a fast machine
 * never waits and a loaded runner is not cut off by a 5 s default.
 */
const READY_CEILING_MS = 90_000
const TEST_CEILING_MS = 120_000

interface RunningServer {
  readonly client: Client
  /** Close the session and reap the child; safe to call twice. */
  readonly stop: () => Promise<void>
}

/**
 * Spawn the built server and resolve once it has ANSWERED `initialize`
 * (`client.connect`). A failed start still reaps the child before throwing.
 */
async function startServer(
  clientName: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  cwd: string,
): Promise<RunningServer> {
  if (!fs.existsSync(SERVER_JS)) {
    throw new Error(
      `${SERVER_JS} is missing: this spec needs the package built first (nx test depends on build)`,
    )
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_JS, ...args],
    env: { ...env },
    cwd,
    stderr: 'pipe',
  })
  // Nothing reads the child's stderr; drain it so a chatty server never blocks on a full pipe.
  transport.stderr?.on('data', () => {})
  const client = new Client({ name: clientName, version: '0.0.0' })
  const stop = async (): Promise<void> => {
    await client.close()
  }
  try {
    await client.connect(transport, { timeout: READY_CEILING_MS })
  } catch (err) {
    await stop()
    throw err
  }
  return { client, stop }
}

describe('camstack-dev MCP server (stdio)', { timeout: TEST_CEILING_MS }, () => {
  const workspace = requireWorkspaceRoot()
  let server: RunningServer
  let client: Client

  beforeAll(async () => {
    server = await startServer(
      'mcp-dev-test',
      [],
      { ...process.env, CAMSTACK_WORKSPACE: workspace },
      workspace,
    )
    client = server.client
  }, READY_CEILING_MS + 5_000)

  afterAll(async () => {
    await server?.stop()
  }, 30_000)

  it('lists tools including knowledge/ui/caps/ci', async () => {
    const listed = await client.listTools()
    const names = new Set(listed.tools.map((t) => t.name))
    for (const required of [
      'search_knowledge',
      'read_section',
      'next_adr_number',
      'get_decision',
      'find_ui_component',
      'get_ui_component',
      'list_ui_tokens',
      'check_ui_file',
      'plan_capability',
      'scaffold_capability',
      'run_codegen',
      'method_tiers_diff',
      'cap_ship_plan',
      'affected_checks',
      'get_capability',
      'scaffold_ui_component',
      'release_plan',
    ]) {
      expect(names.has(required), `missing tool ${required}`).toBe(true)
    }
  })

  it('calls read tools successfully', async () => {
    const decision = await client.callTool({
      name: 'get_decision',
      arguments: { id: 'D2' },
    })
    expect(decision.isError).not.toBe(true)
    const decisionText = JSON.stringify(decision.content)
    expect(decisionText).toMatch(/D2|One addon/i)

    const search = await client.callTool({
      name: 'search_knowledge',
      arguments: { query: 'capability collection pin', limit: 5 },
    })
    expect(search.isError).not.toBe(true)

    const caps = await client.callTool({
      name: 'get_capability',
      arguments: { name: 'motion' },
    })
    expect(caps.isError).not.toBe(true)
    expect(JSON.stringify(caps.content)).toMatch(/deviceNative/)

    const ui = await client.callTool({
      name: 'find_ui_component',
      arguments: { need: 'confirm dialog' },
    })
    expect(ui.isError).not.toBe(true)

    const plan = await client.callTool({
      name: 'plan_capability',
      arguments: { purpose: 'internal in-process log sink with mount skip' },
    })
    expect(plan.isError).not.toBe(true)
    expect(JSON.stringify(plan.content)).toMatch(/internal/)

    const affected = await client.callTool({
      name: 'affected_checks',
      arguments: {
        paths: ['packages/types/src/capabilities/motion.cap.ts'],
        gitDiff: false,
      },
    })
    expect(affected.isError).not.toBe(true)
    expect(JSON.stringify(affected.content)).toMatch(/codegen/)
  })
})

describe('camstack-ops MCP server (stdio, --toolsets ops)', { timeout: TEST_CEILING_MS }, () => {
  const workspace = requireWorkspaceRoot()
  let server: RunningServer
  let client: Client
  let home: string

  beforeAll(async () => {
    // An empty HOME: the entry must find no session, whatever this machine has.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-stdio-home-'))
    server = await startServer(
      'mcp-ops-test',
      ['--toolsets', 'ops'],
      { PATH: process.env.PATH ?? '', HOME: home, CAMSTACK_WORKSPACE: workspace },
      workspace,
    )
    client = server.client
  }, READY_CEILING_MS + 5_000)

  afterAll(async () => {
    await server?.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }, 30_000)

  it('lists the read-only ops tools, all annotated, and none of the offline dev tools', async () => {
    const tools = (await client.listTools()).tools
    const names = tools.map((t) => t.name)
    for (const required of [
      'hub_query',
      'topology',
      'cap_providers',
      'recent_tracks',
      'track',
      'audit_tracks',
      'hub_logs',
      'log_providers',
      'loki_query',
      'model_pin_census',
      'retrain_census',
      'keyframe_presence',
      'ops_status',
      'birth_decisions',
      'event_density',
      'release_status',
      'model_floors',
      'eval_model',
      'fetch_retrain_export',
      'benchmark_status',
    ]) {
      expect(names, `missing ${required}`).toContain(required)
    }
    expect(names).not.toContain('scaffold_capability')
    // Without --allow-mutations the two cluster mutations do not exist at all.
    expect(names).not.toContain('benchmark_run')
    expect(names).not.toContain('model_studio_import')
    // Read-only everywhere except the two tools that write under scratchpad/ (never the cluster).
    const WRITES_WORKSPACE = ['eval_model', 'fetch_retrain_export']
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint, t.name).toBe(!WRITES_WORKSPACE.includes(t.name))
      expect(t.annotations?.destructiveHint, t.name).toBe(false)
    }
  })

  it('fails closed without a credential: a tool error, no crash, no password prompt', async () => {
    const r = await client.callTool({ name: 'ops_status', arguments: {} })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toMatch(/no hub address|Not logged in/)
  })
})

describe('camstack-ops MCP server (stdio, --allow-mutations)', { timeout: TEST_CEILING_MS }, () => {
  const workspace = requireWorkspaceRoot()
  let server: RunningServer
  let client: Client
  let home: string

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-stdio-mut-home-'))
    server = await startServer(
      'mcp-ops-mut-test',
      ['--toolsets', 'ops', '--allow-mutations'],
      { PATH: process.env.PATH ?? '', HOME: home, CAMSTACK_WORKSPACE: workspace },
      workspace,
    )
    client = server.client
  }, READY_CEILING_MS + 5_000)

  afterAll(async () => {
    await server?.stop()
    fs.rmSync(home, { recursive: true, force: true })
  }, 30_000)

  it('lists the two mutating tools, annotated as cluster mutations', async () => {
    const tools = (await client.listTools()).tools
    for (const name of ['benchmark_run', 'model_studio_import']) {
      const tool = tools.find((t) => t.name === name)
      expect(tool, `missing ${name}`).toBeDefined()
      expect(tool?.annotations?.readOnlyHint).toBe(false)
      expect(tool?.annotations?.destructiveHint).toBe(true)
      expect(tool?.annotations?.openWorldHint).toBe(true)
    }
  })

  it('a first call is a dry run that fails closed without a credential (nothing is sent)', async () => {
    const r = await client.callTool({
      name: 'benchmark_run',
      arguments: { nodeId: 'n1', devices: [{ deviceKey: 'cpu', modelIds: ['m'] }] },
    })
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.content)).toMatch(/no hub address|Not logged in/)
  })
})

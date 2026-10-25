import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { requireWorkspaceRoot } from '@camstack/develop'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MUTATING_TOOL_NAMES, annotationsFor } from '../annotations.js'
import { createServer } from '../server.js'
import { OPS_TOOLSETS } from '../toolsets.js'
import {
  PLAN,
  PREFLIGHT_OK,
  auditLog,
  fakeHub,
  fakeMutator,
  type FakeHub,
  type FakeMutator,
} from './model-fakes.js'

const MODEL_TOOLS = [
  'model_floors',
  'eval_model',
  'fetch_retrain_export',
  'benchmark_status',
  'birth_decisions',
  'event_density',
  'release_status',
]

async function connect(options: {
  allowMutations?: boolean
  hub: FakeHub
  mutator: FakeMutator
  audit?: ReturnType<typeof auditLog>
}): Promise<Client> {
  process.env.CAMSTACK_WORKSPACE = requireWorkspaceRoot()
  let n = 0
  const server = createServer(OPS_TOOLSETS, {
    hub: options.hub,
    mutator: options.mutator,
    allowMutations: options.allowMutations === true,
    audit: (options.audit ?? auditLog()).sink,
    newToken: () => `cfm_mcp${++n}`,
  })
  const client = new Client({ name: 'models-test', version: '0.0.0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

function textOf(result: unknown): string {
  const content: unknown =
    result !== null && typeof result === 'object' ? Reflect.get(result, 'content') : undefined
  const first: unknown = Array.isArray(content) ? content[0] : undefined
  const t: unknown =
    first !== null && typeof first === 'object' ? Reflect.get(first, 'text') : undefined
  return typeof t === 'string' ? t : ''
}

describe('models tools over MCP, mutations OFF (the default)', () => {
  let client: Client
  let mutator: FakeMutator
  beforeEach(async () => {
    mutator = fakeMutator()
    client = await connect({ hub: fakeHub({}), mutator })
  })
  afterEach(async () => client.close())

  it('lists the new read tools and NOT the two cluster mutations', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name)
    for (const t of MODEL_TOOLS) expect(names, `missing ${t}`).toContain(t)
    for (const t of MUTATING_TOOL_NAMES) expect(names).not.toContain(t)
  })

  it('calling a mutating tool that does not exist is an error and mutates nothing', async () => {
    await expect(
      client.callTool({ name: 'benchmark_run', arguments: { ...PLAN, confirm_token: 'cfm_x' } }),
    ).resolves.toMatchObject({ isError: true })
    expect(mutator.calls).toHaveLength(0)
  })

  it('model_floors answers from the committed table', async () => {
    const r = await client.callTool({
      name: 'model_floors',
      arguments: { modelId: 'yolo26l-int8' },
    })
    expect(r.isError).not.toBe(true)
    expect(textOf(r)).toMatch(/"person"/)
  })
})

describe('models tools over MCP, mutations ON', () => {
  let client: Client
  let hub: FakeHub
  let mutator: FakeMutator
  let audit: ReturnType<typeof auditLog>
  beforeEach(async () => {
    hub = fakeHub({ 'pipelineOrchestrator.getNodeBenchmarkPreflight': PREFLIGHT_OK })
    mutator = fakeMutator({
      'pipelineOrchestrator.startNodeBenchmark': { kind: 'started', runId: 'run-1' },
    })
    audit = auditLog()
    client = await connect({ allowMutations: true, hub, mutator, audit })
  })
  afterEach(async () => client.close())

  it('lists the mutating tools with destructive, non-read-only annotations', async () => {
    const tools = (await client.listTools()).tools
    for (const name of MUTATING_TOOL_NAMES) {
      const tool = tools.find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
      expect(annotationsFor(name).destructiveHint).toBe(true)
    }
  })

  it('dry run, then the token, then execution; the token is readable and single-use', async () => {
    const dry = await client.callTool({ name: 'benchmark_run', arguments: PLAN })
    expect(dry.isError).not.toBe(true)
    const body = textOf(dry)
    expect(body).toContain('"confirm_token": "cfm_mcp1"')
    expect(body).toMatch(/LOAD TEST/)
    expect(mutator.calls).toHaveLength(0)

    const mismatched = await client.callTool({
      name: 'benchmark_run',
      arguments: { ...PLAN, nodeId: 'someone-else', confirm_token: 'cfm_mcp1' },
    })
    expect(mismatched.isError).toBe(true)
    expect(mutator.calls).toHaveLength(0)

    const dry2 = await client.callTool({ name: 'benchmark_run', arguments: PLAN })
    expect(textOf(dry2)).toContain('cfm_mcp2')
    const done = await client.callTool({
      name: 'benchmark_run',
      arguments: { ...PLAN, confirm_token: 'cfm_mcp2' },
    })
    expect(done.isError).not.toBe(true)
    expect(textOf(done)).toContain('run-1')
    expect(mutator.calls).toHaveLength(1)

    const replay = await client.callTool({
      name: 'benchmark_run',
      arguments: { ...PLAN, confirm_token: 'cfm_mcp2' },
    })
    expect(replay.isError).toBe(true)
    expect(mutator.calls).toHaveLength(1)
    // every call is on the audit record, refusals included
    expect(audit.records.map((r) => r.phase)).toEqual([
      'dry-run',
      'refused',
      'dry-run',
      'execute',
      'executed',
      'refused',
    ])
  })

  it('benchmark_status is a plain read', async () => {
    const h = fakeHub({
      'pipelineOrchestrator.getNodeBenchmarkStatus': { modeNodeId: null, run: null },
    })
    const c = await connect({ hub: h, mutator })
    const r = await c.callTool({ name: 'benchmark_status', arguments: {} })
    expect(r.isError).not.toBe(true)
    expect(mutator.calls).toHaveLength(0)
    await c.close()
  })
})

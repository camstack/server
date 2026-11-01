import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  MutationGate,
  isSecretBearing,
  type ConnectOutcome,
  type HubClient,
  type HubHttpMethod,
} from '@camstack/develop'
import type { McpContext } from '../mcp/context.js'
import { createPublicServer } from '../mcp/server.js'

interface Call {
  readonly method: HubHttpMethod
  readonly path: string
}

type Answers = { readonly [path: string]: unknown }

const HEALTHY: Answers = {
  'userManagement.listUsers': [
    { id: 'u1', username: 'root', isAdmin: true, totpEnabled: true, passwordHash: 'SECRET-HASH' },
  ],
  'userPasskeys.listPasskeys': [],
  'localNetwork.getAddresses': {
    roles: { publicEndpoint: { resolved: 'https://hub.example.test' } },
  },
  'networkAccess.getStatus': { connected: true, endpoint: { stable: true } },
  'backup.listDestinations': [
    { id: 'a:b', enabled: true, cron: '0 3 * * *', lastSuccessAt: 1_700_000_000_000 },
  ],
  'deviceManager.listAll': [{ id: 7, name: 'Door' }],
  'nodes.topology': [
    { id: 'hub', isHub: true, isOnline: true },
    { id: 'agent1', isHub: false, isOnline: true },
  ],
  'notificationOutput.listTargets': [
    {
      id: 't1',
      name: 'Phone',
      kind: 'push',
      enabled: true,
      config: { token: 'SECRET-TARGET-TOKEN' },
    },
  ],
  'notificationRules.listRules': {
    rules: [
      {
        enabled: true,
        delivery: 'system-event',
        conditions: { systemEvent: { kinds: ['node-offline'] } },
      },
      { enabled: true, delivery: 'immediate', conditions: { devices: [7] } },
    ],
  },
}

function harness(
  answers: Answers,
  failing: readonly string[] = [],
  tier: 'admin' | 'protected' = 'admin',
  session = true,
): { ctx: McpContext; calls: Call[] } {
  const calls: Call[] = []
  const client: HubClient = {
    async call(method, path) {
      calls.push({ method, path })
      if (failing.includes(path)) throw new Error(`${path} exploded`)
      return answers[path] ?? null
    },
  }
  const outcome: ConnectOutcome = session
    ? {
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
    : {
        ok: false,
        reason: 'no-session',
        message: 'no usable hub session',
        action: 'run `camstack login`',
      }
  return {
    calls,
    ctx: {
      cliVersion: '9.9.9',
      hub: async () => outcome,
      gate: new MutationGate({ allowMutations: true, audit: () => {} }),
      fetch: async () => new Response(JSON.stringify({ version: '9.9.9' })),
    },
  }
}

async function connect(ctx: McpContext): Promise<Client> {
  const server = createPublicServer({
    toolsets: ['setup', 'ops', 'configure', 'support'],
    context: ctx,
    versionPreflight: false,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  return client
}

interface Step {
  id: string
  status: string
  reason?: string
  detail: string
  next: { tool?: string; ui?: string } | null
}
interface Wizard {
  status: string
  steps: Step[]
  nextStep: { id: string } | null
  unavailable: Record<string, string>
}

async function run(ctx: McpContext): Promise<{ raw: string; isError: boolean; body: Wizard }> {
  const client = await connect(ctx)
  const res = await client.callTool({ name: 'setup_wizard', arguments: {} })
  const content = Array.isArray(res.content) ? res.content : []
  const first = content[0]
  const raw = first && first.type === 'text' ? first.text : ''
  return { raw, isError: res.isError === true, body: JSON.parse(raw) }
}

function step(w: Wizard, id: string): Step {
  const s = w.steps.find((x) => x.id === id)
  if (!s) throw new Error(`no step ${id}`)
  return s
}

describe('setup_wizard', () => {
  it('is listed', async () => {
    const client = await connect(harness(HEALTHY).ctx)
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('setup_wizard')
  })

  it('judges a healthy hub: the first seven done, calibration suggested', async () => {
    const { body } = await run(harness(HEALTHY).ctx)
    expect(body.steps.map((s) => s.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'done',
      'suggested',
    ])
    expect(body.nextStep?.id).toBe('calibration-and-updates')
  })

  it.each([
    ['admin-account', 'userManagement.listUsers'],
    ['hub-address-remote-access', 'localNetwork.getAddresses', 'networkAccess.getStatus'],
    ['backups', 'backup.listDestinations'],
    ['cameras-and-agents', 'deviceManager.listAll'],
    ['notifiers', 'notificationOutput.listTargets'],
    ['admin-alert-rules', 'notificationRules.listRules'],
    ['household-rules', 'notificationRules.listRules'],
  ])('%s: a failing read is unknown with a reason, never missing', async (id, ...paths) => {
    const { body } = await run(harness(HEALTHY, paths).ctx)
    const s = step(body, id)
    expect(s.status).toBe('unknown')
    expect(s.reason).toContain('exploded')
    expect(body.unavailable[id]).toBe(s.reason)
  })

  it('an unreadable topology keeps the camera count and reports agents as unknown, not 0', async () => {
    const { body } = await run(harness(HEALTHY, ['nodes.topology']).ctx)
    const s = step(body, 'cameras-and-agents')
    expect(s.status).toBe('done')
    expect(s.detail).toContain('agents unknown')
    expect(s.detail).not.toContain('0 agent')
  })

  it('an empty answer IS missing (the read succeeded)', async () => {
    const { body } = await run(
      harness({ ...HEALTHY, 'deviceManager.listAll': [], 'notificationOutput.listTargets': [] })
        .ctx,
    )
    expect(step(body, 'cameras-and-agents').status).toBe('missing')
    expect(step(body, 'notifiers').status).toBe('missing')
    expect(body.nextStep?.id).toBe('cameras-and-agents')
  })

  it('a non-admin session never marks an admin step done, and says why', async () => {
    const h = harness(HEALTHY, [], 'protected')
    const { body } = await run(h.ctx)
    const calls = h.calls
    for (const id of ['admin-account', 'backups', 'admin-alert-rules', 'household-rules']) {
      const s = step(body, id)
      expect(s.status).toBe('unknown')
      expect(s.reason).toContain('not admin-scoped')
    }
    const adminPaths = [
      'userManagement.listUsers',
      'userPasskeys.listPasskeys',
      'backup.listDestinations',
      'notificationRules.listRules',
      'nodes.topology',
    ]
    expect(calls.filter((c) => adminPaths.includes(c.path))).toEqual([])
  })

  it('reports an admin without 2FA as missing and lists uncovered cameras', async () => {
    const { body } = await run(
      harness({
        ...HEALTHY,
        'userManagement.listUsers': [
          { id: 'u1', username: 'root', isAdmin: true, totpEnabled: false },
        ],
        'deviceManager.listAll': [
          { id: 7, name: 'Door' },
          { id: 8, name: 'Yard' },
        ],
      }).ctx,
    )
    expect(step(body, 'admin-account').status).toBe('missing')
    const house = step(body, 'household-rules')
    expect(house.status).toBe('missing')
    expect(house.detail).toContain('Yard (8)')
    expect(house.detail).not.toContain('Door (7)')
  })

  it('only reads, never touches a secret-bearing path, and leaks no token or config', async () => {
    const { ctx, calls } = harness(HEALTHY)
    const { raw } = await run(ctx)
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls.filter((c) => isSecretBearing(c.path))).toEqual([])
    for (const leak of [
      'tok-should-never-appear',
      'SECRET-HASH',
      'SECRET-TARGET-TOKEN',
      'passwordHash',
      '"config"',
    ]) {
      expect(raw).not.toContain(leak)
    }
  })

  it('nextStep is the first step that is not done', async () => {
    const { body } = await run(harness(HEALTHY, ['backup.listDestinations']).ctx)
    expect(body.nextStep?.id).toBe('backups')
  })

  it('answers no-session as an error result', async () => {
    const { body, isError } = await run(harness({}, [], 'admin', false).ctx)
    expect(isError).toBe(true)
    expect(body.status).toBe('no-session')
  })

  it('every next.tool names a registered tool', async () => {
    const healthy = await run(harness(HEALTHY).ctx)
    const empty = await run(
      harness({
        ...HEALTHY,
        'deviceManager.listAll': [],
        'notificationRules.listRules': { rules: [] },
      }).ctx,
    )
    const client = await connect(harness(HEALTHY).ctx)
    const registered = new Set((await client.listTools()).tools.map((t) => t.name))
    const named = [...healthy.body.steps, ...empty.body.steps]
      .map((s) => s.next?.tool)
      .filter((t): t is string => t !== undefined)
    expect(named.length).toBeGreaterThan(5)
    for (const tool of named) expect(registered.has(tool), tool).toBe(true)
  })
})

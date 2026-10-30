import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { opsUpdateCheck } from '../mcp/ops-update-check.js'
import { opsUpdateApply, type UpdateApplyDeps } from '../mcp/ops-update-apply.js'
import { detectCliInstall } from '../mcp/ops-update-cli.js'
import type { McpContext } from '../mcp/context.js'
import { fakeHub, type RecordedCall } from './ops-fake-hub.js'
import { withWrites } from './configure-gate-ctx.js'

const CheckView = z.looseObject({
  status: z.literal('ok'),
  nodes: z.array(
    z.looseObject({
      id: z.string(),
      serverNeedsUpdate: z.boolean().nullable(),
      wrapper: z
        .looseObject({
          behind: z.boolean().nullable(),
          kind: z.string().nullable(),
          instructions: z.array(z.string()),
        })
        .nullable(),
      addonsBehindHub: z.array(z.looseObject({})),
      flags: z.array(z.string()),
    }),
  ),
  summary: z.looseObject({}),
  cli: z.looseObject({}),
})

const ApplyView = z.looseObject({
  status: z.string(),
  confirm_token: z.string().optional(),
  result: z.looseObject({
    outcome: z.string(),
    stoppedAt: z.string().optional(),
    reason: z.string().optional(),
    mcpRestartNeeded: z.boolean().optional(),
    steps: z.array(z.looseObject({ step: z.string(), status: z.string() })),
    wrapperUpdates: z.array(z.looseObject({ nodeId: z.string() })).optional(),
  }),
})
type ApplyView = z.infer<typeof ApplyView>

const caps = [{ capabilities: ['a', 'b'] }]
const node = (id: string, over: object = {}): object => ({
  id,
  name: id,
  isHub: id === 'hub',
  isOnline: true,
  addons: caps,
  ...over,
})

function status(running: string, over: object = {}): object {
  return {
    packageName: '@camstack/server',
    runningVersion: running,
    installedVersion: running,
    latestVersion: '2.0.0',
    updateAvailable: running !== '2.0.0',
    restartRequired: false,
    updateState: 'idle',
    lastCheckedAtMs: 1_700_000_000_000,
    ...over,
  }
}

const NPM_OK = async (): Promise<Response> => new Response(JSON.stringify({ version: '1.0.0' }))

interface World {
  versions: { [nodeId: string]: string }
  topology: object[]
  applied: { nodeId: string; version: string }[]
  applyReply?: (nodeId: string) => unknown
  hubAddons: object[]
  installs: object[]
}

function world(over: Partial<World> = {}): World {
  return {
    versions: { hub: '1.0.0', a1: '1.0.0' },
    topology: [node('hub'), node('a1')],
    applied: [],
    hubAddons: [],
    installs: [],
    ...over,
  }
}

function answers(w: World): { [path: string]: unknown } {
  return {
    'nodes.topology': () => w.topology,
    'serverManagement.getServerPackageStatus': (i: { nodeId?: string } | undefined) =>
      status(w.versions[i?.nodeId ?? 'hub'] ?? '0', {
        imageContract: {
          state: 'behind-patch',
          seedVersion: '1.0.0',
          contractVersion: '2.0.0',
        },
        wrapper: { kind: 'docker' },
      }),
    'serverManagement.applyServerUpdate': (i: { nodeId?: string; version: string }) => {
      const id = i.nodeId ?? 'hub'
      w.applied.push({ nodeId: id, version: i.version })
      if (w.applyReply) return w.applyReply(id)
      w.versions[id] = i.version
      return { accepted: true, outcome: 'staged', restarting: true }
    },
    'addons.listUpdates': () => w.hubAddons,
    'addons.updatePackage': () => ({}),
    'addons.listInstallations': () => ({
      installations: w.installs,
      unreachable: [],
    }),
  }
}

function ctxFor(w: World, fetchFn = NPM_OK): { ctx: McpContext; calls: RecordedCall[] } {
  const hub = fakeHub(answers(w))
  return { ctx: withWrites({ ...hub.ctx, fetch: fetchFn }), calls: hub.calls }
}

let clock = 0
const FAST: UpdateApplyDeps = {
  sleep: async (ms) => {
    clock += ms
  },
  now: () => clock,
  pollMs: 1000,
  hubTimeoutMs: 5000,
  agentTimeoutMs: 5000,
  addonTimeoutMs: 5000,
  entryPath: '/usr/local/lib/node_modules/camstack/dist/cli.js',
}

async function confirmed(ctx: McpContext, args: object, deps: UpdateApplyDeps): Promise<ApplyView> {
  const preview = await opsUpdateApply(ctx, args, undefined, deps)
  if (preview.status !== 'dry-run' || preview.confirm_token === undefined)
    throw new Error(`preview was not confirmable: ${JSON.stringify(preview)}`)
  return ApplyView.parse(await opsUpdateApply(ctx, args, preview.confirm_token, deps))
}

describe('ops_update_check', () => {
  it('aggregates every node: hub, agent behind, offline agent and capless agent', async () => {
    const w = world({
      versions: { hub: '2.0.0', a1: '1.0.0', a2: '1.0.0', a3: '1.0.0' },
      topology: [
        node('hub'),
        node('a1'),
        node('a2', { isOnline: false }),
        node('a3', { addons: [], capabilitiesRegistered: false }),
      ],
      installs: [
        {
          packageName: 'p',
          nodeId: 'hub',
          isHub: true,
          isOnline: true,
          version: '3.0.0',
        },
        {
          packageName: 'p',
          nodeId: 'a1',
          isHub: false,
          isOnline: true,
          version: '2.0.0',
        },
      ],
    })
    const { ctx } = ctxFor(w, async () => new Response(JSON.stringify({ version: '9.9.10' })))
    const r = CheckView.parse(
      await opsUpdateCheck(ctx, {
        entryPath: '/x/lib/node_modules/camstack/cli.js',
      }),
    )
    expect(r.status).toBe('ok')
    expect(r.nodes.map((n) => n.id)).toEqual(['hub', 'a1', 'a2', 'a3'])
    const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]))
    expect(byId['hub'].serverNeedsUpdate).toBe(false)
    expect(byId['a1'].serverNeedsUpdate).toBe(true)
    expect(byId['a1'].wrapper).toMatchObject({ behind: true, kind: 'docker' })
    expect(byId['a1'].wrapper?.instructions.join(' ')).toContain('RECREATE')
    expect(byId['a1'].addonsBehindHub).toEqual([
      {
        packageName: 'p',
        nodeId: 'a1',
        hubVersion: '3.0.0',
        nodeVersion: '2.0.0',
      },
    ])
    expect(byId['a2']).toMatchObject({
      online: false,
      server: null,
      unreadable: 'node is offline',
    })
    expect(byId['a3'].flags).toEqual(['online-but-capless'])
    expect(r.summary.offline).toEqual(['a2'])
    expect(r.summary.capless).toEqual(['a3'])
    expect(r.cli).toMatchObject({
      installed: '9.9.9',
      latest: '9.9.10',
      updateAvailable: true,
    })
    expect(r.summary.cliUpdateNeeded).toBe(true)
  })
})

describe('ops_update_apply', () => {
  it('runs the hub before the agents, then addons, then the CLI last', async () => {
    const w = world({
      hubAddons: [
        {
          name: 'addon-x',
          currentVersion: '1',
          latestVersion: '2',
          category: 'addon',
          isSystem: false,
        },
      ],
    })
    w.installs = [
      {
        packageName: 'addon-x',
        nodeId: 'hub',
        isHub: true,
        isOnline: true,
        version: '2',
      },
      {
        packageName: 'addon-x',
        nodeId: 'a1',
        isHub: false,
        isOnline: true,
        version: '2',
      },
    ]
    const ran: string[][] = []
    const { ctx, calls } = ctxFor(
      w,
      async () => new Response(JSON.stringify({ version: '9.9.10' })),
    )
    const r = await confirmed(
      ctx,
      {},
      {
        ...FAST,
        runCommand: async (f, a) => {
          ran.push([f, ...a])
          return { ok: true, output: '' }
        },
      },
    )
    expect(r.status).toBe('executed')
    expect(r.result.outcome).toBe('complete')
    expect(w.applied.map((a) => a.nodeId)).toEqual(['hub', 'a1'])
    const order = r.result.steps.map((s) => s.step)
    expect(order).toEqual(['hub-server', 'agent-server', 'addons', 'cli'])
    expect(ran).toEqual([['npm', 'install', '-g', 'camstack@latest']])
    expect(r.result.mcpRestartNeeded).toBe(true)
    expect(calls.filter((c) => c.path === 'addons.updatePackage')).toHaveLength(1)
    expect(r.result.wrapperUpdates?.map((x) => x.nodeId)).toEqual(['hub', 'a1'])
  })

  it('stops on a failed hub step: no agent, no addons, no CLI', async () => {
    const w = world({
      hubAddons: [
        {
          name: 'addon-x',
          currentVersion: '1',
          latestVersion: '2',
          category: 'addon',
          isSystem: false,
        },
      ],
      applyReply: () => ({
        accepted: false,
        outcome: 'failed',
        error: 'npm ECONNRESET',
      }),
    })
    const ran: string[] = []
    const { ctx, calls } = ctxFor(
      w,
      async () => new Response(JSON.stringify({ version: '9.9.10' })),
    )
    const r = await confirmed(
      ctx,
      {},
      {
        ...FAST,
        runCommand: async (f) => {
          ran.push(f)
          return { ok: true, output: '' }
        },
      },
    )
    expect(r.result.outcome).toBe('failed')
    expect(r.result.stoppedAt).toBe('hub')
    expect(r.result.reason).toContain('ECONNRESET')
    expect(w.applied.map((a) => a.nodeId)).toEqual(['hub'])
    expect(calls.some((c) => c.path === 'addons.updatePackage')).toBe(false)
    expect(ran).toEqual([])
    expect(r.result.steps.at(-1)).toMatchObject({
      step: 'cli',
      status: 'skipped',
    })
  })

  it('fails (bounded) when an agent comes back online with zero capabilities', async () => {
    const w = world()
    const hub = fakeHub({
      ...answers(w),
      'nodes.topology': () => [node('hub'), node('a1', { addons: [] })],
    })
    const ctx = withWrites({ ...hub.ctx, fetch: NPM_OK })
    const r = await confirmed(ctx, { cli: false }, FAST)
    expect(r.result.outcome).toBe('failed')
    expect(r.result.reason).toContain('a1')
    expect(r.result.reason).toContain('no capabilities')
    expect(r.result.steps.map((s) => s.status)).toEqual(['ok', 'failed'])
  })

  it('reports a wrapper update as instructions and performs nothing for it', async () => {
    const w = world({ versions: { hub: '2.0.0', a1: '2.0.0' } })
    const { ctx, calls } = ctxFor(w)
    const r = await opsUpdateApply(ctx, { cli: false }, undefined, FAST)
    // the server is current, so nothing is confirmable, but the wrapper report is in the answer
    expect(r.status).toBe('dry-run')
    const text = JSON.stringify(r)
    expect(text).toContain('docker compose pull')
    expect(calls.some((c) => c.path === 'serverManagement.applyServerUpdate')).toBe(false)
  })

  it('an unknown CLI install method yields instructions and runs no command', async () => {
    const w = world({ versions: { hub: '2.0.0', a1: '2.0.0' } })
    const { ctx } = ctxFor(w, async () => new Response(JSON.stringify({ version: '9.9.10' })))
    const ran: string[] = []
    const r = await confirmed(
      ctx,
      {},
      {
        ...FAST,
        entryPath: '/home/u/.bun/install/global/node_modules/camstack/cli.js',
        runCommand: async (f) => {
          ran.push(f)
          return { ok: true, output: '' }
        },
      },
    )
    expect(r.result.steps).toEqual([
      expect.objectContaining({ step: 'cli', status: 'instructions' }),
    ])
    expect(ran).toEqual([])
    expect(r.result.mcpRestartNeeded).toBe(true)
  })
})

describe('detectCliInstall', () => {
  it('knows npm global and npx, and refuses to guess otherwise', () => {
    expect(detectCliInstall('/usr/lib/node_modules/camstack/dist/cli.js').method).toBe('npm-global')
    expect(detectCliInstall('/home/u/.npm/_npx/abc/node_modules/camstack/cli.js').method).toBe(
      'npx',
    )
    expect(detectCliInstall('/proj/node_modules/camstack/cli.js').command).toBeNull()
  })
})

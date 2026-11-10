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
  jobTimeoutMs: 5000,
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

/** One step of the hub's job, as `clusterUpdate.*` answers it. */
function step(kind: string, status: string, over: object = {}): object {
  return { kind, status, detail: `${kind} ${status}`, ...over }
}

function job(state: string, steps: object[], over: object = {}): object {
  return {
    id: 'job-1',
    state,
    targetVersion: '2.0.0',
    requestedBy: 'admin',
    startedAt: 1,
    steps,
    skippedOffline: [],
    ...over,
  }
}

const PLAN_STEPS = [
  step('backup', 'pending'),
  step('hub-server', 'pending', { nodeId: 'hub' }),
  step('agent-server', 'pending', { nodeId: 'a1' }),
  step('addons', 'pending', { packages: ['addon-x 1 -> 2'] }),
]

function plan(over: object = {}): object {
  return {
    targetVersion: '2.0.0',
    steps: PLAN_STEPS,
    skippedOffline: [],
    blocker: null,
    blockerDetail: null,
    ...over,
  }
}

interface ClusterHub {
  plan: object | Error
  start: object
  /** Successive `getClusterUpdateJob` answers; the last one repeats. */
  reads: (object | Error | null)[]
}

/** The cluster-update cap on top of the node reads the wrapper report uses. */
function clusterHub(c: ClusterHub, fetchFn = NPM_OK): { ctx: McpContext; calls: RecordedCall[] } {
  let read = 0
  const hub = fakeHub({
    ...answers(world({ versions: { hub: '2.0.0', a1: '2.0.0' } })),
    'clusterUpdate.previewClusterUpdate': c.plan,
    'clusterUpdate.startClusterUpdate': () => c.start,
    'clusterUpdate.getClusterUpdateJob': () => {
      const answer = c.reads[Math.min(read, c.reads.length - 1)] ?? null
      read += 1
      if (answer instanceof Error) throw answer
      return answer
    },
  })
  return { ctx: withWrites({ ...hub.ctx, fetch: fetchFn }), calls: hub.calls }
}

const STARTED = { accepted: true, jobId: 'job-1', blocker: null, message: 'started' }
const NEWER_CLI = async (): Promise<Response> => new Response(JSON.stringify({ version: '9.9.10' }))

function recorder(): { ran: string[][]; deps: UpdateApplyDeps } {
  const ran: string[][] = []
  return {
    ran,
    deps: {
      ...FAST,
      runCommand: async (f, a) => {
        ran.push([f, ...a])
        return { ok: true, output: '' }
      },
    },
  }
}

const orchestrationCalls = (calls: RecordedCall[]): string[] =>
  calls
    .map((c) => c.path)
    .filter(
      (p) =>
        p === 'serverManagement.applyServerUpdate' ||
        p === 'addons.updatePackage' ||
        p === 'backup.trigger',
    )

describe('ops_update_apply', () => {
  it('starts the hub-side job, follows it across the hub restart, then updates the CLI', async () => {
    const done = job('succeeded', [
      step('backup', 'ok'),
      step('hub-server', 'ok', { nodeId: 'hub' }),
      step('agent-server', 'ok', { nodeId: 'a1' }),
      step('addons', 'ok'),
    ])
    const { ctx, calls } = clusterHub(
      {
        plan: plan(),
        start: STARTED,
        reads: [
          job('running', PLAN_STEPS),
          new Error('fetch failed: ECONNREFUSED (the hub restarts)'),
          done,
        ],
      },
      NEWER_CLI,
    )
    const { ran, deps } = recorder()
    const r = await confirmed(ctx, { backup: false, version: '2.0.0' }, deps)
    expect(r.status).toBe('executed')
    expect(r.result.outcome).toBe('complete')
    expect(r.result.steps.map((s) => s.step)).toEqual([
      'backup',
      'hub-server',
      'agent-server',
      'addons',
      'cli',
    ])
    const start = calls.filter((c) => c.path === 'clusterUpdate.startClusterUpdate')
    expect(start).toEqual([
      expect.objectContaining({ method: 'POST', input: { backup: false, version: '2.0.0' } }),
    ])
    expect(calls.find((c) => c.path === 'clusterUpdate.previewClusterUpdate')?.input).toEqual({
      backup: false,
      version: '2.0.0',
    })
    // the MCP drives nothing itself any more: the hub runs every step
    expect(orchestrationCalls(calls)).toEqual([])
    expect(ran).toEqual([['npm', 'install', '-g', 'camstack@latest']])
    expect(r.result.mcpRestartNeeded).toBe(true)
    expect(r.result.wrapperUpdates?.map((x) => x.nodeId)).toEqual(['hub', 'a1'])
  })

  it('an agent back online without capabilities fails the job: named, typed, no CLI', async () => {
    const { ctx } = clusterHub(
      {
        plan: plan(),
        start: STARTED,
        reads: [
          job(
            'failed',
            [
              step('backup', 'ok'),
              step('hub-server', 'ok', { nodeId: 'hub' }),
              step('agent-server', 'failed', {
                nodeId: 'a1',
                reason: 'node-capless',
                detail: 'a1 runs 2.0.0 but registered no capabilities',
              }),
              step('addons', 'skipped', { detail: 'not run: a1 failed' }),
            ],
            { stoppedAt: 'a1', reason: 'node-capless' },
          ),
        ],
      },
      NEWER_CLI,
    )
    const { ran, deps } = recorder()
    const r = await confirmed(ctx, {}, deps)
    expect(r.result.outcome).toBe('failed')
    expect(r.result.stoppedAt).toBe('a1')
    expect(r.result.reason).toContain('node-capless')
    expect(r.result.reason).toContain('no capabilities')
    expect(r.result.steps.map((s) => s.status)).toEqual([
      'ok',
      'ok',
      'failed',
      'skipped',
      'skipped',
    ])
    expect(ran).toEqual([])
  })

  it('a refused start is a failure that names the blocker', async () => {
    const { ctx } = clusterHub({
      plan: plan(),
      start: {
        accepted: false,
        jobId: 'job-0',
        blocker: 'job-running',
        message: 'cluster update job-0 is already running',
      },
      reads: [null],
    })
    const r = await confirmed(ctx, { cli: false }, FAST)
    expect(r.result.outcome).toBe('failed')
    expect(r.result.reason).toContain('job-running')
  })

  it('a job still running past the bound is reported partial, never a loop', async () => {
    const { ctx } = clusterHub(
      { plan: plan(), start: STARTED, reads: [job('running', PLAN_STEPS)] },
      NEWER_CLI,
    )
    const { ran, deps } = recorder()
    const r = await confirmed(ctx, {}, deps)
    expect(r.result.outcome).toBe('partial')
    expect(r.result.reason).toContain('still running')
    expect(r.result.steps.at(-1)).toMatchObject({ step: 'cli', status: 'skipped' })
    expect(ran).toEqual([])
  })

  it('a hub without the cluster-update cap says to update the hub first', async () => {
    const { ctx, calls } = clusterHub({
      plan: new Error('No procedure found on path "clusterUpdate.previewClusterUpdate"'),
      start: STARTED,
      reads: [null],
    })
    const r = await opsUpdateApply(ctx, { cli: false }, undefined, FAST)
    expect(r.status).toBe('dry-run')
    expect(JSON.stringify(r)).toContain('predates the one-job cluster update')
    expect(calls.some((c) => c.path === 'clusterUpdate.startClusterUpdate')).toBe(false)
  })

  it('reports a wrapper update as instructions and performs nothing for it', async () => {
    const { ctx, calls } = clusterHub({
      plan: plan({ steps: [], blocker: 'nothing-to-do', blockerDetail: 'all current' }),
      start: STARTED,
      reads: [null],
    })
    const r = await opsUpdateApply(ctx, { cli: false }, undefined, FAST)
    // the cluster is current, so nothing is confirmable, but the wrapper report is in the answer
    expect(r.status).toBe('dry-run')
    expect(JSON.stringify(r)).toContain('docker compose pull')
    expect(calls.some((c) => c.path === 'clusterUpdate.startClusterUpdate')).toBe(false)
  })

  it('an unknown CLI install method yields instructions and runs no command', async () => {
    const { ctx, calls } = clusterHub(
      {
        plan: plan({ steps: [], blocker: 'nothing-to-do', blockerDetail: 'all current' }),
        start: STARTED,
        reads: [null],
      },
      NEWER_CLI,
    )
    const { ran, deps } = recorder()
    const r = await confirmed(
      ctx,
      {},
      {
        ...deps,
        entryPath: '/home/u/.bun/install/global/node_modules/camstack/cli.js',
      },
    )
    expect(r.result.steps).toEqual([
      expect.objectContaining({ step: 'cli', status: 'instructions' }),
    ])
    expect(ran).toEqual([])
    expect(r.result.mcpRestartNeeded).toBe(true)
    expect(calls.some((c) => c.path === 'clusterUpdate.startClusterUpdate')).toBe(false)
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

/**
 * `addons.uninstallPackage` reaches AGENTS (2026-10-08).
 *
 * `@camstack/addon-decoder-ffmpeg` was uninstalled on the hub and stayed
 * installed — runner running — on both agents: `uninstallPackage` took only a
 * package name and acted on the hub, and `startJob({ kind: 'uninstall',
 * nodeIds })` refuses agents. These specs drive the LIVE cap router (input
 * schema, `nodeIdMode: 'data'`, admin tier) into the real `buildAddonsProvider`
 * over a broker fake that answers `$agent.status` / `$agent.undeploy` the way an
 * agent does.
 */
import type { UninstallPackageResult } from '@camstack/types'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { buildAddonsProvider } from '../../api/core/cap-providers.js'
import { initLifecycleRunner } from '../../core/lifecycle/lifecycle-runner.singleton.js'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

const PKG = '@camstack/addon-decoder-ffmpeg'

interface AgentFake {
  readonly id: string
  readonly isOnline: boolean
  addons: { id: string; packageName: string; version: string }[]
}

interface Env {
  readonly router: ReturnType<typeof buildCapRouterForTest>
  readonly undeployCalls: { nodeId: string; params: unknown }[]
  readonly pruned: { nodeId: string; packageName: string }[]
  readonly hubUninstall: ReturnType<typeof vi.fn>
}

function makeEnv(options: {
  readonly hubHas: boolean
  readonly agents: readonly AgentFake[]
  readonly protectedPackages?: readonly string[]
  readonly recorded?: Readonly<Record<string, readonly string[]>>
  /** Agents running the pre-fix `$agent.undeploy`, which answers `{ success, addonId }`. */
  readonly legacyAgents?: readonly string[]
}): Env {
  const undeployCalls: { nodeId: string; params: unknown }[] = []
  const pruned: { nodeId: string; packageName: string }[] = []
  let hubHas = options.hubHas
  const hubUninstall = vi.fn(async () => {
    hubHas = false
    return { success: true }
  })
  const agentsById = new Map(options.agents.map((a) => [a.id, a]))

  const broker = {
    call: vi.fn(async (action: string, params: unknown, opts?: { nodeID?: string }) => {
      const agent = agentsById.get(opts?.nodeID ?? '')
      if (!agent?.isOnline) throw new Error(`node ${opts?.nodeID ?? '?'} unreachable`)
      if (action === '$agent.status') return { addons: agent.addons }
      if (action === '$agent.undeploy') {
        undeployCalls.push({ nodeId: agent.id, params })
        if ((options.legacyAgents ?? []).includes(agent.id)) {
          return { success: true, addonId: 'decoder-ffmpeg' }
        }
        const removed = agent.addons.filter((a) => a.packageName === PKG).map((a) => a.id)
        agent.addons = agent.addons.filter((a) => a.packageName !== PKG)
        return {
          success: true,
          outcome: removed.length > 0 ? 'uninstalled' : 'not-installed',
          scope: 'package',
          addonIds: removed,
          runnersStopped: removed,
          runnersRespawned: [],
          removedDirs: [],
          warnings: [],
        }
      }
      throw new Error(`unexpected ${action}`)
    }),
  }
  const ps = {
    isProtected: (name: string) => (options.protectedPackages ?? []).includes(name),
    listInstalled: () => (hubHas ? [{ name: PKG, version: '1.0.0' }] : []),
    uninstallAndReload: hubUninstall,
    getRollbackablePackages: () => new Set<string>(),
  }
  const ar = {
    listAddons: () => (hubHas ? [{ manifest: { id: 'decoder-ffmpeg', packageName: PKG } }] : []),
  }
  const agentRegistry = {
    listNodeDirectory: async () => ({
      complete: true,
      nodes: [
        { id: 'hub', name: 'Hub', isHub: true, isOnline: true },
        ...options.agents.map((a) => ({
          id: a.id,
          name: a.id,
          isHub: false,
          isOnline: a.isOnline,
        })),
      ],
    }),
    getRecordedPackages: async (nodeId: string) =>
      (options.recorded?.[nodeId] ?? []).map((name) => ({ name, version: '1.0.0' })),
    notePackageUndeployed: async (nodeId: string, packageName: string) => {
      pruned.push({ nodeId, packageName })
    },
  }

  // Documented type boundary: `buildAddonsProvider` takes concrete service
  // classes; these fakes implement exactly the members the uninstall path reads.
  const provider = buildAddonsProvider(
    ar as never,
    ps as never,
    { createLogger: () => undefined } as never,
    { broker } as never,
    {} as never,
    makeCtx('admin'),
    agentRegistry as never,
  )
  return {
    router: buildCapRouterForTest('addons', () => provider),
    undeployCalls,
    pruned,
    hubUninstall,
  }
}

function asResult(value: unknown): UninstallPackageResult {
  // Documented boundary: the router is a structural pass-through of the provider.
  return value as UninstallPackageResult
}

beforeAll(() => {
  initLifecycleRunner({
    dataDir: '/tmp/addons-uninstall-per-node-spec',
    fetchTarball: async () => Buffer.from(''),
    extract: async () => {},
    applyAddonUpdate: async () => {},
    emit: () => {},
  })
})

describe('addons.uninstallPackage — per node', () => {
  it('removes a package from ONE agent: $agent.undeploy in package mode, roster pruned, hub untouched', async () => {
    const env = makeEnv({
      hubHas: false,
      agents: [
        {
          id: 'MacMiniAgent.localdomain',
          isOnline: true,
          addons: [{ id: 'decoder-ffmpeg', packageName: PKG, version: '1.0.0' }],
        },
      ],
    })

    const out = await invokeProcedure(env.router, 'uninstallPackage', makeCtx('admin'), {
      packageName: PKG,
      nodeId: 'MacMiniAgent.localdomain',
    })

    expect(out.ok).toBe(true)
    const result = asResult(out.ok ? out.value : null)
    expect(result.success).toBe(true)
    expect(result.results).toEqual([
      expect.objectContaining({
        nodeId: 'MacMiniAgent.localdomain',
        outcome: 'uninstalled',
        runnersStopped: ['decoder-ffmpeg'],
      }),
    ])
    expect(env.undeployCalls).toEqual([
      {
        nodeId: 'MacMiniAgent.localdomain',
        params: { packageName: PKG, addonId: 'decoder-ffmpeg' },
      },
    ])
    expect(env.pruned).toEqual([{ nodeId: 'MacMiniAgent.localdomain', packageName: PKG }])
    expect(env.hubUninstall).not.toHaveBeenCalled()
  })

  it('without nodeId stays the hub-only call it always was', async () => {
    const env = makeEnv({
      hubHas: true,
      agents: [
        {
          id: 'agent-a',
          isOnline: true,
          addons: [{ id: 'decoder-ffmpeg', packageName: PKG, version: '1.0.0' }],
        },
      ],
    })

    const out = await invokeProcedure(env.router, 'uninstallPackage', makeCtx('admin'), {
      packageName: PKG,
    })

    expect(out.ok).toBe(true)
    expect(env.hubUninstall).toHaveBeenCalledWith(PKG)
    expect(env.undeployCalls).toEqual([])
  })

  it('everywhere: every holder, agents first, offline nodes pending-reconnect, hub last', async () => {
    const env = makeEnv({
      hubHas: true,
      agents: [
        {
          id: 'agent-a',
          isOnline: true,
          addons: [{ id: 'decoder-ffmpeg', packageName: PKG, version: '1.0.0' }],
        },
        { id: 'offline-agent', isOnline: false, addons: [] },
        { id: 'clean-agent', isOnline: true, addons: [] },
      ],
      recorded: { 'offline-agent': [PKG] },
    })

    const out = await invokeProcedure(env.router, 'uninstallPackage', makeCtx('admin'), {
      packageName: PKG,
      everywhere: true,
    })

    const result = asResult(out.ok ? out.value : null)
    expect(result.success).toBe(true)
    expect(result.results.map((r) => [r.nodeId, r.outcome])).toEqual([
      ['agent-a', 'uninstalled'],
      ['offline-agent', 'pending-reconnect'],
      ['hub', 'uninstalled'],
    ])
    expect(env.pruned.map((p) => p.nodeId).sort()).toEqual(['agent-a', 'offline-agent'])
  })

  it('refuses a protected package before touching any node', async () => {
    const env = makeEnv({
      hubHas: true,
      protectedPackages: [PKG],
      agents: [
        {
          id: 'agent-a',
          isOnline: true,
          addons: [{ id: 'decoder-ffmpeg', packageName: PKG, version: '1.0.0' }],
        },
      ],
    })

    const out = await invokeProcedure(env.router, 'uninstallPackage', makeCtx('admin'), {
      packageName: PKG,
      everywhere: true,
    })

    expect(out).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    expect(env.undeployCalls).toEqual([])
    expect(env.hubUninstall).not.toHaveBeenCalled()
  })

  it('reports an unknown node per node instead of throwing', async () => {
    const env = makeEnv({ hubHas: false, agents: [] })
    const out = await invokeProcedure(env.router, 'uninstallPackage', makeCtx('admin'), {
      packageName: PKG,
      nodeId: 'nobody',
    })
    const result = asResult(out.ok ? out.value : null)
    expect(result.success).toBe(false)
    expect(result.results[0]).toMatchObject({ nodeId: 'nobody', outcome: 'failed' })
  })

  it('an agent that predates package mode still loses the package, and the result says its runner survives', async () => {
    const env = makeEnv({
      hubHas: false,
      agents: [
        {
          id: 'old-agent',
          isOnline: true,
          addons: [{ id: 'decoder-ffmpeg', packageName: PKG, version: '1.0.0' }],
        },
      ],
      legacyAgents: ['old-agent'],
    })
    const out = await invokeProcedure(env.router, 'uninstallPackage', makeCtx('admin'), {
      packageName: PKG,
      nodeId: 'old-agent',
    })
    const result = asResult(out.ok ? out.value : null)
    expect(result.results[0]).toMatchObject({ nodeId: 'old-agent', outcome: 'uninstalled' })
    expect(result.results[0]?.warnings[0]).toContain('predates runner teardown')
  })

  it('is admin-only', async () => {
    const env = makeEnv({ hubHas: true, agents: [] })
    const out = await invokeProcedure(env.router, 'uninstallPackage', makeCtx('user'), {
      packageName: PKG,
      nodeId: 'agent-a',
    })
    expect(out.ok).toBe(false)
    expect(env.hubUninstall).not.toHaveBeenCalled()
  })
})

describe('addons.listInstallations', () => {
  it('lists the hub copy, live agent copies and offline recorded copies, flagging orphans', async () => {
    const env = makeEnv({
      hubHas: false,
      agents: [
        {
          id: 'MacMiniAgent.localdomain',
          isOnline: true,
          addons: [{ id: 'decoder-ffmpeg', packageName: PKG, version: '1.0.0' }],
        },
        { id: 'offline-agent', isOnline: false, addons: [] },
      ],
      recorded: { 'offline-agent': [PKG] },
    })

    const out = await invokeProcedure(env.router, 'listInstallations', makeCtx('admin'), {
      packageName: PKG,
    })

    expect(out.ok).toBe(true)
    expect(out.ok ? out.value : null).toEqual({
      installations: [
        expect.objectContaining({
          nodeId: 'MacMiniAgent.localdomain',
          source: 'live',
          onHub: false,
          addonIds: ['decoder-ffmpeg'],
        }),
        expect.objectContaining({ nodeId: 'offline-agent', source: 'recorded', onHub: false }),
      ],
      unreachable: [],
    })
  })
})

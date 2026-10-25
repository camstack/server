/**
 * Updating an addon from the agent (D840) goes THROUGH THE HUB: the hub's own
 * installed version is what its reconcile restores on every reconnect, so the
 * only reconciliation-safe update brings this node to THAT version, by asking
 * the hub. A fake `callHub` is the only seam; nothing is installed locally.
 */
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { AgentAddonUpdateReport } from '../agent-addon-updates.js'
import {
  HUB_ADDON_LIST_ACTION,
  HUB_ADDON_UPDATE_ACTION,
  type HubCall,
  createAgentHubAddonControls,
  hubVersionsFromList,
  isBehindHub,
} from '../agent-hub-addon-update.js'
import { type AgentAddonUpdateView, registerAgentUpdateRoutes } from '../agent-update-routes.js'

const hubList = (versions: Record<string, string>): unknown =>
  Object.entries(versions).map(([packageName, packageVersion]) => ({
    manifest: { id: packageName, packageName, packageVersion },
    source: 'npm',
  }))

interface Call {
  readonly action: string
  readonly params: unknown
}

/** A hub that has `versions` installed and answers updatePackage with `reply`. */
function fakeHub(versions: Record<string, string>, reply: () => Promise<unknown>) {
  const calls: Call[] = []
  const callHub: HubCall = async (action, params) => {
    calls.push({ action, params })
    if (action === HUB_ADDON_LIST_ACTION) return hubList(versions)
    return reply()
  }
  return { calls, callHub }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('hub versions', () => {
  it('reads package versions from an addons.list answer and skips unreadable rows', () => {
    const map = hubVersionsFromList([
      ...(hubList({ '@camstack/addon-a': '1.2.0' }) as unknown[]),
      null,
      { manifest: 3 },
    ])
    expect([...map]).toEqual([['@camstack/addon-a', '1.2.0']])
  })

  it('differs from the hub in either direction; unknown is never a move', () => {
    expect(isBehindHub('1.0.0', '1.0.1')).toBe(true)
    expect(isBehindHub('1.0.1', '1.0.1')).toBe(false)
    expect(isBehindHub('1.0.2', '1.0.1')).toBe(true)
    expect(isBehindHub(null, '1.0.1')).toBe(false)
    expect(isBehindHub('1.0.0', null)).toBe(false)
  })
})

describe('Update asks the hub', () => {
  it('asks the hub for the hub version even when that version is lower, and never calls the registry', async () => {
    const fetches: string[] = []
    const original = globalThis.fetch
    const denyRegistry: typeof globalThis.fetch = async (input) => {
      fetches.push(typeof input === 'string' ? input : input.toString())
      throw new Error('registry must not be called')
    }
    globalThis.fetch = denyRegistry
    try {
      const hub = fakeHub({ '@camstack/addon-a': '1.0.0' }, async () => ({ success: true }))
      const controls = createAgentHubAddonControls({ nodeId: 'agent-1', callHub: hub.callHub })
      const res = await controls.start('@camstack/addon-a', ['@camstack/addon-a'])
      expect(res).toEqual({ started: true, message: null })
      await settle()
      expect(hub.calls.map((c) => c.action)).toEqual([
        HUB_ADDON_LIST_ACTION,
        HUB_ADDON_UPDATE_ACTION,
      ])
      expect(hub.calls[1]?.params).toEqual({
        name: '@camstack/addon-a',
        version: '1.0.0',
        nodeId: 'agent-1',
      })
      expect(fetches).toEqual([])
    } finally {
      globalThis.fetch = original
    }
  })

  it("deploys the HUB's version to THIS node through the hub, and records done", async () => {
    const hub = fakeHub({ '@camstack/addon-a': '1.2.0' }, async () => ({ success: true }))
    const controls = createAgentHubAddonControls({ nodeId: 'agent-1', callHub: hub.callHub })
    const res = await controls.start('@camstack/addon-a', ['@camstack/addon-a'])
    expect(res).toEqual({ started: true, message: null })
    await settle()
    const update = hub.calls.find((c) => c.action === HUB_ADDON_UPDATE_ACTION)
    expect(update?.params).toEqual({
      name: '@camstack/addon-a',
      version: '1.2.0',
      nodeId: 'agent-1',
    })
    expect(controls.progress().get('@camstack/addon-a')).toEqual({
      status: 'done',
      targetVersion: '1.2.0',
      message: null,
    })
  })

  it("shows the hub's refusal as the failure reason", async () => {
    const problems: string[] = []
    const hub = fakeHub({ '@camstack/addon-a': '1.2.0' }, async () => {
      throw new Error('"addons.updatePackage" is not on the remote privilege grant')
    })
    const controls = createAgentHubAddonControls({
      nodeId: 'agent-1',
      callHub: hub.callHub,
      onProblem: (m) => problems.push(m),
    })
    await controls.start('@camstack/addon-a', ['@camstack/addon-a'])
    await settle()
    const state = controls.progress().get('@camstack/addon-a')
    expect(state?.status).toBe('failed')
    expect(state?.message).toContain('not on the remote privilege grant')
    expect(problems.join()).toContain('@camstack/addon-a')
  })

  it('reports a hub-side { success: false } as a failure with its error', async () => {
    const hub = fakeHub({ '@camstack/addon-a': '1.2.0' }, async () => ({
      success: false,
      error: 'agent unreachable',
    }))
    const controls = createAgentHubAddonControls({ nodeId: 'agent-1', callHub: hub.callHub })
    await controls.start('@camstack/addon-a', ['@camstack/addon-a'])
    await settle()
    expect(controls.progress().get('@camstack/addon-a')).toMatchObject({
      status: 'failed',
      message: 'agent unreachable',
    })
  })

  it('refuses, naming why, what it cannot honestly start', async () => {
    const hub = fakeHub({ '@camstack/addon-a': '1.2.0' }, async () => ({ success: true }))
    const controls = createAgentHubAddonControls({ nodeId: 'agent-1', callHub: hub.callHub })
    expect((await controls.start('@camstack/addon-x', ['@camstack/addon-a'])).message).toContain(
      'not installed',
    )
    expect((await controls.start('@camstack/addon-b', ['@camstack/addon-b'])).message).toContain(
      'does not install',
    )
    const down = createAgentHubAddonControls({
      nodeId: 'agent-1',
      callHub: async () => {
        throw new Error('no hub')
      },
    })
    const refused = await down.start('@camstack/addon-a', ['@camstack/addon-a'])
    expect(refused.started).toBe(false)
    expect(refused.message).toContain('no hub')
    // Nothing was deployed by any refused start.
    expect(hub.calls.filter((c) => c.action === HUB_ADDON_UPDATE_ACTION)).toHaveLength(0)
  })

  it('does not start a second update of a package that is running', async () => {
    let release: () => void = () => {}
    const hub = fakeHub(
      { '@camstack/addon-a': '1.2.0' },
      () => new Promise((resolve) => (release = () => resolve({ success: true }))),
    )
    const controls = createAgentHubAddonControls({ nodeId: 'agent-1', callHub: hub.callHub })
    await controls.start('@camstack/addon-a', ['@camstack/addon-a'])
    const second = await controls.start('@camstack/addon-a', ['@camstack/addon-a'])
    expect(second.started).toBe(false)
    release()
    await settle()
  })
})

describe('addon-updates routes', () => {
  const report: AgentAddonUpdateReport = {
    entries: [
      {
        packageName: '@camstack/addon-a',
        installedVersion: '1.0.0',
        latestVersion: '1.3.0',
        updateAvailable: true,
        error: null,
      },
      {
        packageName: '@camstack/addon-b',
        installedVersion: '2.0.0',
        latestVersion: '2.0.0',
        updateAvailable: false,
        error: null,
      },
    ],
    checkedAtMs: 1,
    error: null,
    hubReachable: true,
  }

  async function serve(callHub: HubCall) {
    const app = Fastify()
    const hub = createAgentHubAddonControls({ nodeId: 'agent-1', callHub })
    registerAgentUpdateRoutes(app, { addons: { getReport: async () => report, hub } })
    return app
  }

  it('joins the hub version: behind only where the hub is newer', async () => {
    const hub = fakeHub(
      { '@camstack/addon-a': '1.2.0', '@camstack/addon-b': '2.0.0' },
      async () => ({ success: true }),
    )
    const app = await serve(hub.callHub)
    const body = (await app.inject({ method: 'GET', url: '/api/agent/addon-updates' })).json<
      { available: true } & AgentAddonUpdateView
    >()
    const byName = new Map(body.entries.map((e) => [e.packageName, e]))
    expect(byName.get('@camstack/addon-a')).toMatchObject({ hubVersion: '1.2.0', behindHub: true })
    expect(byName.get('@camstack/addon-b')).toMatchObject({ hubVersion: '2.0.0', behindHub: false })
    expect(body.hubVersionsError).toBeNull()
  })

  it('says why the hub versions are unknown instead of showing aligned', async () => {
    const app = await serve(async () => {
      throw new Error('hub offline')
    })
    const body = (
      await app.inject({ method: 'GET', url: '/api/agent/addon-updates' })
    ).json<AgentAddonUpdateView>()
    expect(body.hubVersionsError).toContain('hub offline')
    expect(body.entries.every((e) => e.behindHub === false && e.hubVersion === null)).toBe(true)
  })

  it('POST update calls the hub, never a local install', async () => {
    const hub = fakeHub({ '@camstack/addon-a': '1.2.0' }, async () => ({ success: true }))
    const app = await serve(hub.callHub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/addon-updates/update',
      payload: { packageName: '@camstack/addon-a' },
    })
    expect(res.json()).toEqual({ started: true, message: null })
    await settle()
    expect(hub.calls.map((c) => c.action)).toContain(HUB_ADDON_UPDATE_ACTION)
    const missing = await app.inject({
      method: 'POST',
      url: '/api/agent/addon-updates/update',
      payload: {},
    })
    expect(missing.statusCode).toBe(400)
  })
})

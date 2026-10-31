import { describe, expect, it, vi } from 'vitest'
import { buildAddonsProvider } from '../api/core/cap-providers.js'
import { initLifecycleRunner } from '../core/lifecycle/lifecycle-runner.singleton.js'
import { makeCtx } from './cap-routers/harness.js'

/**
 * D982 — `addons.updatePackage` for an agent-only package the hub tracks
 * (agent-ui) fans out to every online agent. Before, the call went to the hub's
 * lifecycle runner and failed with "not currently tracked in manifest".
 */

function build(agentIds: readonly string[]) {
  initLifecycleRunner({
    dataDir: '/tmp/addons-update-tracked-package-spec',
    fetchTarball: async () => Buffer.from(''),
    extract: async () => {},
    applyAddonUpdate: async () => {},
    emit: () => {},
  })
  const startJob = vi.fn()
  const brokerCall = vi.fn().mockResolvedValue({})
  const packPackage = vi
    .fn()
    .mockResolvedValue({ buffer: Buffer.from('tgz'), version: '1.3.0', filename: 'x.tgz' })
  const agentRegistry = {
    onlineAgentIds: () => agentIds,
    noteExplicitDelivery: vi.fn().mockResolvedValue(undefined),
    requestConvergence: vi.fn().mockResolvedValue(undefined),
  }
  const provider = buildAddonsProvider(
    { listAddons: () => [] } as never,
    { packPackage, getRollbackablePackages: () => new Set() } as never,
    {} as never,
    { broker: { call: brokerCall } } as never,
    {} as never,
    makeCtx('admin'),
    agentRegistry as never,
  )
  return { provider, brokerCall, packPackage, agentRegistry, startJob }
}

describe('addons.updatePackage — an agent-tracked package', () => {
  it('fans out to every online agent instead of the hub lifecycle runner', async () => {
    const env = build(['agent-a', 'agent-b'])

    const result = await env.provider.updatePackage({ name: '@camstack/addon-agent-ui' })

    expect(result).toMatchObject({ success: true, version: '1.3.0' })
    expect(env.packPackage).toHaveBeenCalledTimes(1)
    const deploys = env.brokerCall.mock.calls.filter(([action]) => action === '$agent.deploy')
    expect(deploys.map(([, , opts]) => opts.nodeID)).toEqual(['agent-a', 'agent-b'])
    expect(env.agentRegistry.noteExplicitDelivery).toHaveBeenCalledWith(
      'agent-a',
      '@camstack/addon-agent-ui',
    )
  })

  it('reports a node that failed instead of claiming success', async () => {
    const env = build(['agent-a'])
    env.brokerCall.mockRejectedValueOnce(new Error('node went away'))

    const result = await env.provider.updatePackage({ name: '@camstack/addon-agent-ui' })

    expect(result).toMatchObject({ success: false })
    expect(JSON.stringify(result)).toContain('agent-a')
  })
})

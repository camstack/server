/**
 * A grouped addon on an AGENT is believed by the hub (2026-11-06: `pipeline-runner` in the
 * `detection` runner had its migrations refused, "no caller identity"). Its stamp is the member
 * addon id; the hub checks it against the manifest the agent registered, which at the child's
 * PRE-INIT register carried no caps, so the addon was unknown until after its init had run.
 */
import { HubNodeRegistry, RunnerOfAddon } from '@camstack/server/system'
import { describe, expect, it } from 'vitest'
import { isRunnerHostedByNode } from '../../core/moleculer/runner-hosted-on-node.js'
import { buildAgentChildUdsManifest } from '../agent-child-manifest.js'
import { createAgentHubRegistration } from '../agent-hub-registration.js'

const GROUP_OF: Readonly<Record<string, string>> = {
  'pipeline-runner': 'detection',
  'detection-pipeline': 'detection',
}
const hubResolver = (addonId: string): string => GROUP_OF[addonId] ?? addonId

/** What the hub holds for the agent after the child's PRE-INIT register (no caps yet). */
function hubAfterPreInitRegister(): HubNodeRegistry {
  const plan = new RunnerOfAddon()
  plan.record('pipeline-runner', 'detection')
  plan.record('detection-pipeline', 'detection')
  const child = buildAgentChildUdsManifest(
    'little-unraid/detection',
    'detection',
    [],
    plan.addonsOf('detection'),
  )
  const subtree = new HubNodeRegistry()
  subtree.registerNode(child)
  const hub = new HubNodeRegistry()
  hub.registerNode({
    nodeId: 'little-unraid',
    addons: subtree.listNodeIds().flatMap((id) => subtree.getNodeManifest(id) ?? []),
  })
  return hub
}

describe('grouped child on an agent: caller stamp verification', () => {
  it('accepts a member addon of a grouped runner before the child has declared any cap', () => {
    const hub = hubAfterPreInitRegister()
    expect(isRunnerHostedByNode(hub, hubResolver, 'little-unraid', 'pipeline-runner')).toBe(true)
    expect(isRunnerHostedByNode(hub, hubResolver, 'little-unraid', 'detection')).toBe(true)
  })

  it('still drops a stamp naming an addon or runner the sender does not host', () => {
    const hub = hubAfterPreInitRegister()
    expect(isRunnerHostedByNode(hub, hubResolver, 'little-unraid', 'keychain')).toBe(false)
    expect(isRunnerHostedByNode(hub, hubResolver, 'amd-proxmox', 'pipeline-runner')).toBe(false)
  })
})

describe('agent registration: settled()', () => {
  it('resolves only after the registration in flight was acked', async () => {
    let ack: (v: unknown) => void = () => {}
    const reg = createAgentHubRegistration({
      buildManifest: () => ({ nodeId: 'little-unraid', addons: [] }),
      broker: () => ({
        call: () => new Promise((resolve) => (ack = resolve)),
      }),
      log: () => {},
    })
    reg.trigger('child connected')
    let settled = false
    void reg.settled().then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    ack({})
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(true)
  })

  it('resolves at once when nothing is pending', async () => {
    const reg = createAgentHubRegistration({
      buildManifest: () => ({ nodeId: 'little-unraid', addons: [] }),
      broker: () => ({ call: async () => ({}) }),
      log: () => {},
    })
    await expect(reg.settled()).resolves.toBeUndefined()
  })
})

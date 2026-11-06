/**
 * A grouped addon on an AGENT is believed by the hub (2026-11-06: `pipeline-runner` in the
 * `detection` runner had its migrations refused, "no caller identity"). Its stamp is the member
 * addon id; the hub checks it against the manifest the agent registered, which at the child's
 * PRE-INIT register carried no caps, so the addon was unknown until after its init had run.
 */
import { HubNodeRegistry, RunnerOfAddon } from '@camstack/server/system'
import { describe, expect, it, vi } from 'vitest'
import { isRunnerHostedByNode } from '../../core/moleculer/runner-hosted-on-node.js'
import { buildAgentChildUdsManifest } from '../agent-child-manifest.js'
import { createForwardToHub } from '../forward-to-hub.js'
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

describe('forwardToHub: the registration wait is bounded by the call budget', () => {
  const stamped = {
    capName: 'migrations',
    method: 'declareOwner',
    args: {},
    callerAddonId: 'pipeline-runner',
  }

  it('goes out anyway at the deadline, with the remaining budget, when settled() never resolves', async () => {
    vi.useFakeTimers()
    try {
      const calls: Array<{
        envelope: Record<string, unknown>
        timeoutMs: number
      }> = []
      const warns: string[] = []
      const forward = createForwardToHub({
        settled: () => new Promise<void>(() => {}),
        call: async (envelope, timeoutMs) => void calls.push({ envelope, timeoutMs }),
        log: { warn: (m) => void warns.push(m) },
        timeoutMs: 1000,
      })
      const done = forward(stamped)
      await vi.advanceTimersByTimeAsync(1000)
      await done
      expect(calls).toHaveLength(1)
      expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(1)
      expect(warns).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('carries the stamp, with nearly the full budget, once settled() resolves', async () => {
    const calls: Array<{
      envelope: Record<string, unknown>
      timeoutMs: number
    }> = []
    const forward = createForwardToHub({
      settled: async () => {},
      call: async (envelope, timeoutMs) => void calls.push({ envelope, timeoutMs }),
      log: { warn: () => {} },
      timeoutMs: 60_000,
    })
    await forward(stamped)
    expect(calls[0]?.envelope['callerAddonId']).toBe('pipeline-runner')
    expect(calls[0]?.timeoutMs).toBeGreaterThan(59_000)
  })
})

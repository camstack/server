/**
 * `$agent.reload` must reconcile this node's manifest with the hub.
 *
 * The hub's `HubNodeRegistry` is a pure PUSH: `triggerUpwardRegistration`
 * fires on agent boot, on a child's `$agent.registerNode`, and on hub
 * `$node.connected` — nowhere else. `$agent.reload` (the last step of every
 * `camstack deploy` to an agent) mutates `loadedAddons` and the capability
 * registry without any of those three happening, so a capability the node
 * GAINS after boot stayed invisible to the hub until the next restart or
 * reconnect.
 *
 * That matters because `CapRouteResolver.nodeKnowsCap` reads exactly that
 * manifest (`cap-route-authority.ts`): an unlearned cap is not merely missing
 * from a list, it is UNROUTABLE — the hub answers `no-provider` for a node
 * that is demonstrably providing it.
 *
 * Reconcile hung on an existing trigger, no timer (D3).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ServiceBroker } from 'moleculer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgentService } from '../agent-service.js'

interface ReloadResult {
  readonly success: boolean
  readonly loaded: readonly string[]
}

describe('$agent.reload — node-manifest reconcile', () => {
  let broker: ServiceBroker
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reload-'))
  })

  afterEach(async () => {
    if (broker) await broker.stop()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  async function startWith(
    reload: () => Promise<readonly string[]>,
    reconcile: () => void,
  ): Promise<ReloadResult> {
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    broker.createService(
      createAgentService({
        addonsDir: path.join(tmpDir, 'addons'),
        agentName: 'test-agent',
        configPath: path.join(tmpDir, 'agent.json'),
        dataDir: tmpDir,
        loadedAddons: new Map(),
        reloadDeployedAddons: reload,
        reconcileNodeRegistration: reconcile,
      }),
    )
    await broker.start()
    return (await broker.call('$agent.reload')) as ReloadResult
  }

  it('re-runs registerNode after a reload that loaded a new addon', async () => {
    let reconciled = 0
    const result = await startWith(
      () => Promise.resolve(['platform-probe']),
      () => {
        reconciled += 1
      },
    )
    expect(result.success).toBe(true)
    expect(result.loaded).toEqual(['platform-probe'])
    expect(reconciled).toBe(1)
  })

  it('re-runs registerNode even when the reload loaded nothing NEW', async () => {
    // A RE-load of an already-present addon whose manifest gained a capability
    // reports `loaded: []` — gating the reconcile on a non-empty diff would
    // miss exactly that case. registerNode is an idempotent replace (D3), so a
    // no-op re-register costs one acked RPC.
    let reconciled = 0
    const result = await startWith(
      () => Promise.resolve([]),
      () => {
        reconciled += 1
      },
    )
    expect(result.loaded).toEqual([])
    expect(reconciled).toBe(1)
  })

  it('does not reconcile when there is no reload to perform', async () => {
    // No `reloadDeployedAddons` wired → the handler returns early; there is no
    // capability change to publish.
    broker = new ServiceBroker({ nodeID: 'agent-test', transporter: 'Fake', logger: false })
    let reconciled = 0
    broker.createService(
      createAgentService({
        addonsDir: path.join(tmpDir, 'addons'),
        agentName: 'test-agent',
        configPath: path.join(tmpDir, 'agent.json'),
        dataDir: tmpDir,
        loadedAddons: new Map(),
        reconcileNodeRegistration: () => {
          reconciled += 1
        },
      }),
    )
    await broker.start()
    const result = (await broker.call('$agent.reload')) as ReloadResult
    expect(result.success).toBe(false)
    expect(reconciled).toBe(0)
  })
})

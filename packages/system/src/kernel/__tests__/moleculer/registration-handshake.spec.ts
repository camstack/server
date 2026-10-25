import { describe, it, expect, afterEach } from 'vitest'
import type { Context } from 'moleculer'
import { ServiceBroker } from 'moleculer'
import { createHubService } from '../../moleculer/hub-service.js'
import { HubNodeRegistry } from '../../moleculer/node-registry.js'
import type {
  RegisterNodeParams,
  RegisterNodeResult,
  RegisteredNativeCap,
} from '../../moleculer/node-registry.js'
import {
  callRegisterNodeWithRetry,
  buildNodeManifest,
} from '../../moleculer/register-node-client.js'

describe('D3 registration handshake — end to end', () => {
  const brokers: ServiceBroker[] = []
  afterEach(async () => {
    for (const b of brokers) {
      try {
        await b.stop()
      } catch {
        /* */
      }
    }
    brokers.length = 0
  })

  it('a node handshake populates the hub registry with its complete manifest', async () => {
    const registry = new HubNodeRegistry()
    const hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    const worker = new ServiceBroker({ nodeID: 'hub/reolink', transporter: 'Fake', logger: false })
    brokers.push(hub, worker)
    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
        onRegisterNode: (p) => registry.registerNode(p),
        onUnregisterNode: (id) => registry.removeNode(id),
      }),
    )
    await hub.start()
    await worker.start()
    await worker.waitForServices(['$hub'])

    await callRegisterNodeWithRetry(
      worker,
      buildNodeManifest('hub/reolink', [{ addonId: 'reolink', capabilities: ['switch', 'ptz'] }]),
      { target: 'hub', baseDelayMs: 10 },
    )

    expect(registry.listEntries()).toEqual([
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'switch' },
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'ptz' },
    ])
  }, 30_000)

  it('a re-handshake REPLACES the prior manifest (idempotent reconnect)', async () => {
    const registry = new HubNodeRegistry()
    const hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    const worker = new ServiceBroker({ nodeID: 'hub/reolink', transporter: 'Fake', logger: false })
    brokers.push(hub, worker)
    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
        onRegisterNode: (p) => registry.registerNode(p),
      }),
    )
    await hub.start()
    await worker.start()
    await worker.waitForServices(['$hub'])

    await callRegisterNodeWithRetry(
      worker,
      buildNodeManifest('hub/reolink', [{ addonId: 'reolink', capabilities: ['switch', 'ptz'] }]),
      { target: 'hub', baseDelayMs: 10 },
    )
    await callRegisterNodeWithRetry(
      worker,
      buildNodeManifest('hub/reolink', [{ addonId: 'reolink', capabilities: ['switch'] }]),
      { target: 'hub', baseDelayMs: 10 },
    )

    expect(registry.listEntries()).toEqual([
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'switch' },
    ])
  }, 30_000)

  it('agent subtree: child→agent→hub aggregation registers child caps under agent nodeId', async () => {
    // Hub registry — the authoritative view the hub maintains.
    const hubRegistry = new HubNodeRegistry()
    // Agent-side subtree registry — accumulates child manifests.
    const agentSubtree = new HubNodeRegistry()

    const hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    // The agent broker (represents the remote agent node).
    const agent = new ServiceBroker({ nodeID: 'agent-1', transporter: 'Fake', logger: false })
    // A group-runner child broker (simulates a forked worker under the agent).
    const child = new ServiceBroker({
      nodeID: 'agent-1/group-a',
      transporter: 'Fake',
      logger: false,
    })
    brokers.push(hub, agent, child)

    // ── Hub service ──────────────────────────────────────────────────────────
    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
        onRegisterNode: (p) => hubRegistry.registerNode(p),
        onUnregisterNode: (id) => hubRegistry.removeNode(id),
      }),
    )

    // ── Agent $agent service — minimal, with registerNode action ─────────────
    // Wires `onChildRegistered` to aggregate-and-forward, mirroring what
    // agent-bootstrap.ts does in production.
    const agentAbort = new AbortController()
    agent.createService({
      name: '$agent',
      actions: {
        registerNode: {
          handler(ctx: Context<RegisterNodeParams>): RegisterNodeResult {
            const params = ctx.params
            // Merge child manifest into the agent's subtree registry.
            agentSubtree.registerNode(params)
            // Aggregate and re-register the union upward with the hub.
            // In this test the agent has no in-process addons of its own —
            // the full manifest is the union of all children's manifests.
            const allAddons = agentSubtree
              .listNodeIds()
              .flatMap((id) => agentSubtree.getNodeManifest(id) ?? [])
            const allNativeCaps = agentSubtree
              .listNodeIds()
              .flatMap((id) => agentSubtree.getNodeNativeCaps(id) ?? [])
            const agentManifest = buildNodeManifest(
              'agent-1',
              allAddons,
              allNativeCaps.length > 0 ? allNativeCaps : undefined,
            )
            void callRegisterNodeWithRetry(agent, agentManifest, {
              target: 'hub',
              signal: agentAbort.signal,
              baseDelayMs: 10,
            })
            return { ok: true }
          },
        },
      },
    })

    await hub.start()
    await agent.start()
    await child.start()
    // Child waits for `$agent` (its parent) to be reachable.
    await child.waitForServices(['$agent'])

    // ── Child calls `$agent.registerNode` with its capability manifest ───────
    await callRegisterNodeWithRetry(
      child,
      buildNodeManifest('agent-1/group-a', [
        { addonId: 'reolink', capabilities: ['switch', 'ptz'] },
        { addonId: 'onvif', capabilities: ['stream'] },
      ]),
      { target: 'agent', targetNodeId: 'agent-1', baseDelayMs: 10 },
    )

    // Give the async upward registration a moment to reach the hub.
    await new Promise((r) => setTimeout(r, 200))
    agentAbort.abort()

    // ── Assert: hub sees the child's caps under the agent's nodeId ───────────
    expect(hubRegistry.listEntries()).toEqual([
      { nodeId: 'agent-1', addonId: 'reolink', capName: 'switch' },
      { nodeId: 'agent-1', addonId: 'reolink', capName: 'ptz' },
      { nodeId: 'agent-1', addonId: 'onvif', capName: 'stream' },
    ])
  }, 30_000)

  /**
   * D3 boot-race acceptance assertion (aggregate boot-race, D3 fix).
   *
   * Before D3 the hub discovered native caps via a timer+scan sweep; there was
   * a window where the hub's CapabilityRegistry had a node's system caps but
   * NOT yet its device-scoped native caps. Any `getDeviceAggregate` call in
   * that window enumerated a PARTIAL native-cap set, causing `contribution
   * method failed` WARNs from device-manager when providers that do not own
   * the device were called.
   *
   * D3 closes the window: `$hub.registerNode` delivers the node's COMPLETE
   * manifest (system caps + native caps) atomically. This test proves it:
   * immediately after `callRegisterNodeWithRetry` acks, `listNativeCapEntries`
   * already contains the device-scoped cap — there is no partial-state window.
   */
  it('D3 boot-race: native caps are present in the hub registry immediately after handshake acks (atomic delivery)', async () => {
    const registry = new HubNodeRegistry()
    const hub = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    const worker = new ServiceBroker({ nodeID: 'hub/reolink', transporter: 'Fake', logger: false })
    brokers.push(hub, worker)
    hub.createService(
      createHubService({
        getAddonConfig: () => ({}),
        getSettings: () => ({}),
        getRecentEvents: () => [],
        onLog: () => {},
        onRegisterNode: (p) => registry.registerNode(p),
        onUnregisterNode: (id) => registry.removeNode(id),
      }),
    )
    await hub.start()
    await worker.start()
    await worker.waitForServices(['$hub'])

    // Manifest includes both system caps AND device-scoped native caps in one
    // atomic payload — this is exactly what the re-handshake fired by a
    // group-runner after `runWorkerDeviceRestoreWithRetry` completes looks like.
    const nativeCaps: readonly RegisteredNativeCap[] = [
      { capName: 'switch', addonId: 'reolink', deviceIds: [7] },
    ]
    const params: RegisterNodeParams = {
      nodeId: 'hub/reolink',
      addons: [{ addonId: 'reolink', capabilities: ['switch', 'ptz'] }],
      nativeCaps,
    }
    // One ack — the protocol guarantees the hub processed the full manifest.
    await callRegisterNodeWithRetry(worker, params, { target: 'hub', baseDelayMs: 10 })

    // System caps must be present.
    expect(registry.listEntries()).toEqual([
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'switch' },
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'ptz' },
    ])

    // Native caps must ALSO be present — no timer, no gap, no partial state.
    // This is the D3 acceptance criterion: zero boot-race window.
    expect(registry.listNativeCapEntries()).toEqual([
      { nodeId: 'hub/reolink', addonId: 'reolink', capName: 'switch', deviceId: 7 },
    ])

    // The registry held both sets simultaneously — getNodeNativeCaps confirms
    // the node's native-cap slice is non-empty right after the ack.
    expect(registry.getNodeNativeCaps('hub/reolink')).toEqual([
      { capName: 'switch', addonId: 'reolink', deviceIds: [7] },
    ])
  }, 30_000)
})

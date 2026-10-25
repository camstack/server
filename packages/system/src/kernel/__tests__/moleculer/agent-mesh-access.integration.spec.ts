/**
 * The agent's inbound mesh gate over real Moleculer brokers (Fake transporter).
 *
 * Mirrors the hub's containment on the agent receive path (D802, D857):
 *  - a peer that is not the certified hub is refused;
 *  - the hub is served once the agent's TLS listener has verified its
 *    certificate (`certified` stands in for `TlsTcpTransporter.verifiedPeer`);
 *  - a forged `caller` is stripped before an addon handler runs;
 *  - `$process.list` stays reachable from the certified hub;
 *  - a stranger cannot call `$agent.status` / `$process.spawnRunner`;
 *  - an agent that is not paired (holds no certificate) admits nobody.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceBroker } from 'moleculer'
import type { AddonDeclaration, ICamstackAddon } from '@camstack/types'
import { createAddonService } from '../../moleculer/addon-service-factory.js'
import { createMeshAccessMiddleware } from '../../moleculer/mesh-access-middleware.js'
import {
  AgentMeshIdentityGate,
  meshErrorType,
  MESH_NODE_UNAUTHENTICATED_TYPE,
} from '../../moleculer/mesh-identity.js'

const FORGED_CALLER = { userId: 'admin-user-id', isAdmin: true }

const brokers: ServiceBroker[] = []
let seq = 0

afterEach(async () => {
  for (const b of brokers.splice(0)) {
    try {
      await b.stop()
    } catch {
      /* already stopped */
    }
  }
})

function freshNs(): string {
  seq += 1
  return `agent-mesh-it-${seq}`
}

async function typeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (err) {
    return meshErrorType(err)
  }
}

interface Cluster {
  readonly ns: string
  readonly hub: ServiceBroker
  readonly agent: ServiceBroker
  /** Node ids the agent's TLS listener verified. */
  readonly certified: Set<string>
  readonly revealedFor: string[]
}

async function startCluster(): Promise<Cluster> {
  const ns = freshNs()
  const revealedFor: string[] = []
  const certified = new Set<string>()
  const hub = new ServiceBroker({
    nodeID: 'hub',
    namespace: ns,
    transporter: 'Fake',
    logger: false,
  })
  const gate = new AgentMeshIdentityGate({
    ownNodeId: 'agent-a',
    isVerifiedPeer: (nodeId) => certified.has(nodeId),
  })
  const agent = new ServiceBroker({
    nodeID: 'agent-a',
    namespace: ns,
    transporter: 'Fake',
    logger: false,
    middlewares: [createMeshAccessMiddleware({ ownNodeId: 'agent-a', gate })],
  })
  brokers.push(hub, agent)

  agent.createService({
    name: '$agent',
    actions: {
      status: () => ({ nodeId: 'agent-a', ok: true }),
      deploy: () => ({ ok: true }),
    },
  })
  agent.createService({
    name: '$process',
    actions: {
      list: () => [{ name: 'decoder', addonIds: ['decoder'] }],
      spawnRunner: () => ({ pid: 1 }),
    },
  })
  const declaration: AddonDeclaration = {
    id: 'demo',
    entry: 'x',
    capabilities: [{ name: 'demo-cap', methods: ['echo'] }],
  } as unknown as AddonDeclaration
  const provider = {
    echo: (input: { caller?: { userId: string }; value: string }) => {
      if (input.caller?.userId !== undefined) revealedFor.push(input.caller.userId)
      return { value: input.value, caller: input.caller ?? null }
    },
  }
  agent.createService(
    createAddonService({} as unknown as ICamstackAddon, declaration, {
      providers: new Map([['demo-cap', provider]]),
    }),
  )

  await hub.start()
  await agent.start()
  await hub.waitForServices(['$agent', '$process', 'demo'])
  return { ns, hub, agent, certified, revealedFor }
}

describe('agent inbound mesh gate (certificate identity, D857)', () => {
  it('a stranger is refused before $agent / $process / addon run', async () => {
    const c = await startCluster()
    c.certified.add('hub')
    const stranger = new ServiceBroker({
      nodeID: 'lan-intruder',
      namespace: c.ns,
      transporter: 'Fake',
      logger: false,
    })
    brokers.push(stranger)
    await stranger.start()
    await stranger.waitForServices(['$agent', '$process', 'demo'])

    expect(await typeOf(stranger.call('$agent.status', {}, { nodeID: 'agent-a' }))).toBe(
      MESH_NODE_UNAUTHENTICATED_TYPE,
    )
    expect(
      await typeOf(stranger.call('$process.spawnRunner', { runnerId: 'x' }, { nodeID: 'agent-a' })),
    ).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
    expect(
      await typeOf(
        stranger.call(
          'demo.demo-cap.echo',
          { value: 'hi', caller: FORGED_CALLER },
          { nodeID: 'agent-a' },
        ),
      ),
    ).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
    expect(c.revealedFor).toEqual([])
  }, 30_000)

  it('the certified hub may call $agent.status and $process.list', async () => {
    const c = await startCluster()
    c.certified.add('hub')
    await expect(c.hub.call('$agent.status', {}, { nodeID: 'agent-a' })).resolves.toEqual({
      nodeId: 'agent-a',
      ok: true,
    })
    await expect(c.hub.call('$process.list', {}, { nodeID: 'agent-a' })).resolves.toEqual([
      { name: 'decoder', addonIds: ['decoder'] },
    ])
  }, 30_000)

  it('a node answering as "hub" without a verified certificate is refused (an unpaired agent admits nobody)', async () => {
    const c = await startCluster()
    expect(await typeOf(c.hub.call('$agent.status', {}, { nodeID: 'agent-a' }))).toBe(
      MESH_NODE_UNAUTHENTICATED_TYPE,
    )
    // The certificate is what changes the verdict — nothing else.
    c.certified.add('hub')
    await expect(c.hub.call('$agent.status', {}, { nodeID: 'agent-a' })).resolves.toEqual({
      nodeId: 'agent-a',
      ok: true,
    })
    c.certified.delete('hub')
    expect(await typeOf(c.hub.call('$agent.status', {}, { nodeID: 'agent-a' }))).toBe(
      MESH_NODE_UNAUTHENTICATED_TYPE,
    )
  }, 30_000)

  it('the certified hub cannot forge a caller on an agent addon action', async () => {
    const c = await startCluster()
    c.certified.add('hub')
    const result = (await c.hub.call(
      'demo.demo-cap.echo',
      { value: 'hi', caller: FORGED_CALLER },
      { nodeID: 'agent-a' },
    )) as { value: string; caller: unknown }
    expect(result.value).toBe('hi')
    expect(result.caller).toBeNull()
    expect(c.revealedFor).toEqual([])
  }, 30_000)
})

/**
 * The hub's mesh gate over real Moleculer brokers (Fake transporter) — D802, D857.
 *
 * The hub broker carries the production pieces: `createMeshAccessMiddleware`,
 * `createHubService` with a `MeshIdentityGate`, `$hub-cap-fwd`, and an addon
 * service built by the real `createAddonService` exposing a `keychain-admin`
 * provider whose `reveal` is wired exactly like `keychain.addon.ts`
 * (`service.reveal(input.caller.userId, input.ref)`).
 *
 * The certificate table (`certified`) stands in for what the TLS transporter
 * knows (`TlsTcpTransporter.verifiedPeer`, covered with real sockets in
 * `mesh-mtls/__tests__/peer-identity.spec.ts`): adding a node id is a completed
 * handshake, removing it is a revocation or a closed connection.
 *
 * Security tests:
 *  - `keychain-admin.reveal` is unreachable with a forged `caller` — directly
 *    on the addon service and through `$hub-cap-fwd.forward`, from a node
 *    without a certificate AND from a certified one;
 *  - a node without a certificate is refused; one that holds it is served;
 *    removing the certificate refuses it on the very next call;
 *  - a node registers only itself;
 *  - a pre-D857 agent's join messages are not an action any more (it falls back
 *    to its "hub predates the join" path) and its `clusterSecretHash` is ignored;
 *  - `$process` is never callable from another node;
 *  - events from a node without a certificate are dropped.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceBroker } from 'moleculer'
import type { AddonDeclaration, ICamstackAddon } from '@camstack/types'
import { createAddonService } from '../../moleculer/addon-service-factory.js'
import { createHubService } from '../../moleculer/hub-service.js'
import { createMeshAccessMiddleware } from '../../moleculer/mesh-access-middleware.js'
import {
  meshErrorType,
  MESH_ACTION_FORBIDDEN_TYPE,
  MESH_NODE_UNAUTHENTICATED_TYPE,
  MeshIdentityGate,
} from '../../moleculer/mesh-identity.js'
import { createHubCapForwardService } from '../../transport/hub-cap-forward.js'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'

const FORGED_CALLER = { userId: 'admin-user-id', isAdmin: true }

interface Harness {
  readonly ns: string
  readonly hub: ServiceBroker
  /** Node ids that completed a certificate-verified handshake. */
  readonly certified: Set<string>
  /** Every user id the keychain service was asked to reveal for. */
  readonly revealedFor: string[]
  /** Every args object `$hub-cap-fwd` routed into the hub. */
  readonly forwarded: CapCallInput[]
  readonly events: string[]
  readonly registered: string[]
}

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

/** The keychain-admin provider, wired like `keychain.addon.ts`. */
function keychainAdminProvider(revealedFor: string[]) {
  const service = {
    reveal: (userId: string, ref: string) => {
      revealedFor.push(userId)
      return { ref, value: 'the-camera-password' }
    },
  }
  return {
    reveal: (input: { caller: { userId: string }; ref: string }) =>
      service.reveal(input.caller.userId, input.ref),
  }
}

async function startHub(): Promise<Harness> {
  const ns = freshNs()
  const certified = new Set<string>()
  const revealedFor: string[] = []
  const forwarded: CapCallInput[] = []
  const events: string[] = []
  const registered: string[] = []
  const gate = new MeshIdentityGate({
    ownNodeId: 'hub',
    isVerifiedPeer: (nodeId) => certified.has(nodeId),
  })
  const hub = new ServiceBroker({
    nodeID: 'hub',
    namespace: ns,
    transporter: 'Fake',
    logger: false,
    middlewares: [createMeshAccessMiddleware({ ownNodeId: 'hub', gate })],
  })
  brokers.push(hub)
  hub.createService(
    createHubService({
      getAddonConfig: () => ({}),
      getSettings: () => ({}),
      getRecentEvents: () => [],
      onLog: () => {},
      onRegisterNode: (params) => registered.push(params.nodeId),
      meshIdentity: gate,
    }),
  )
  const provider = keychainAdminProvider(revealedFor)
  const declaration: AddonDeclaration = {
    id: 'keychain',
    entry: 'x',
    capabilities: [{ name: 'keychain-admin', methods: ['reveal'] }],
  } as unknown as AddonDeclaration
  hub.createService(
    createAddonService({} as unknown as ICamstackAddon, declaration, {
      providers: new Map([['keychain-admin', provider]]),
    }),
  )
  // `$hub-cap-fwd` routes into the hub's resolver; here the resolver is the
  // keychain provider itself, the in-process route `keychain-admin` takes.
  hub.createService(
    createHubCapForwardService(async (input) => {
      forwarded.push(input)
      if (input.capName === 'keychain-admin' && input.method === 'reveal') {
        return provider.reveal(input.args as { caller: { userId: string }; ref: string })
      }
      return null
    }),
  )
  hub.createService({
    name: '$process',
    actions: { spawnRunner: { handler: () => ({ pid: 1 }) } },
  })
  hub.createService({
    name: 'probe-listener',
    events: {
      'camstack.evt.probe': (ctx: { params: { tag: string } }) => {
        events.push(ctx.params.tag)
      },
    },
  })
  await hub.start()
  return { ns, hub, certified, revealedFor, forwarded, events, registered }
}

async function startNode(nodeID: string, ns: string) {
  const node = new ServiceBroker({ nodeID, namespace: ns, transporter: 'Fake', logger: false })
  brokers.push(node)
  await node.start()
  await node.waitForServices(['$hub', 'keychain', '$hub-cap-fwd', '$process'])
  return node
}

async function typeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (err) {
    return meshErrorType(err) ?? (err instanceof Error ? `Error: ${err.message}` : 'unknown')
  }
}

function freshNs(): string {
  seq += 1
  return `mesh-it-${seq}`
}

const FORWARD = { capName: 'x', method: 'y', args: {} }

describe('mesh gate — keychain-admin.reveal with a forged caller', () => {
  it('a node without a certificate is refused before the keychain is touched', async () => {
    const h = await startHub()
    const node = await startNode('lan-intruder', h.ns)

    const direct = await typeOf(
      node.call('keychain.keychain-admin.reveal', { ref: 'secret://x', caller: FORGED_CALLER }),
    )
    const viaForward = await typeOf(
      node.call('$hub-cap-fwd.forward', {
        capName: 'keychain-admin',
        method: 'reveal',
        args: { ref: 'secret://x', caller: FORGED_CALLER },
      }),
    )
    expect(direct).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
    expect(viaForward).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
    expect(h.revealedFor).toEqual([])
  }, 30_000)

  it('a CERTIFIED agent cannot forge a caller either', async () => {
    const h = await startHub()
    h.certified.add('agent-a')
    const node = await startNode('agent-a', h.ns)

    const direct = await typeOf(
      node.call('keychain.keychain-admin.reveal', { ref: 'secret://x', caller: FORGED_CALLER }),
    )
    const viaForward = await typeOf(
      node.call('$hub-cap-fwd.forward', {
        capName: 'keychain-admin',
        method: 'reveal',
        args: { ref: 'secret://x', caller: FORGED_CALLER, callerAddonId: 'keychain' },
      }),
    )
    expect(direct).not.toBeNull()
    expect(viaForward).not.toBeNull()
    expect(h.revealedFor).toEqual([])
    expect(h.forwarded[0]?.args).toEqual({ ref: 'secret://x' })
  }, 30_000)
})

describe('mesh gate — node identity is the certificate', () => {
  it('a certified agent is served, one without a certificate is refused, a revoked one is refused at once', async () => {
    const h = await startHub()
    h.certified.add('agent-a')
    const good = await startNode('agent-a', h.ns)
    const bare = await startNode('mac', h.ns)

    await expect(good.call('$hub-cap-fwd.forward', FORWARD)).resolves.toBeNull()
    expect(await typeOf(bare.call('$hub-cap-fwd.forward', FORWARD))).toBe(
      MESH_NODE_UNAUTHENTICATED_TYPE,
    )

    // Revocation / a dropped connection: the very next call is refused, no state to expire.
    h.certified.delete('agent-a')
    expect(await typeOf(good.call('$hub-cap-fwd.forward', FORWARD))).toBe(
      MESH_NODE_UNAUTHENTICATED_TYPE,
    )
  }, 30_000)

  it('a node registers only itself, and only with a certificate', async () => {
    const h = await startHub()
    h.certified.add('agent-a')
    const node = await startNode('agent-a', h.ns)
    const bare = await startNode('mac', h.ns)

    await expect(
      node.call('$hub.registerNode', { nodeId: 'agent-a', addons: [] }, { nodeID: 'hub' }),
    ).resolves.toEqual({ ok: true })
    expect(h.registered).toEqual(['agent-a'])
    expect(
      await typeOf(
        node.call('$hub.registerNode', { nodeId: 'someone-else', addons: [] }, { nodeID: 'hub' }),
      ),
    ).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
    expect(
      await typeOf(
        bare.call('$hub.registerNode', { nodeId: 'mac', addons: [] }, { nodeID: 'hub' }),
      ),
    ).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
    expect(h.registered).toEqual(['agent-a'])
  }, 30_000)

  it('a pre-D857 agent still works: its join is no action, its secret hash is ignored', async () => {
    const h = await startHub()
    h.certified.add('old-agent')
    const old = await startNode('old-agent', h.ns)

    // What the old MeshJoinClient sends first: it reads "no such action" as "the hub predates the
    // join" and goes on without one.
    const challenge = await typeOf(old.call('$hub.joinChallenge', {}, { nodeID: 'hub' }))
    expect(['SERVICE_NOT_FOUND', 'SERVICE_NOT_AVAILABLE']).toContain(challenge)
    const authenticate = await typeOf(
      old.call('$hub.authenticateNode', { nodeId: 'old-agent' }, { nodeID: 'hub' }),
    )
    expect(['SERVICE_NOT_FOUND', 'SERVICE_NOT_AVAILABLE']).toContain(authenticate)

    // Its registration carries the legacy hash; the certificate is what admits it.
    await expect(
      old.call(
        '$hub.registerNode',
        { nodeId: 'old-agent', addons: [], clusterSecretHash: 'a'.repeat(64) },
        { nodeID: 'hub' },
      ),
    ).resolves.toEqual({ ok: true })
    expect(h.registered).toEqual(['old-agent'])
  }, 30_000)

  it('$process is never callable from another node, even a certified one', async () => {
    const h = await startHub()
    h.certified.add('agent-a')
    const node = await startNode('agent-a', h.ns)
    expect(
      await typeOf(node.call('$process.spawnRunner', { runnerId: 'x', addons: [{}], env: {} })),
    ).toBe(MESH_ACTION_FORBIDDEN_TYPE)
  }, 30_000)

  it('events from a node without a certificate are dropped', async () => {
    const h = await startHub()
    const bare = await startNode('mac', h.ns)
    h.certified.add('agent-a')
    const good = await startNode('agent-a', h.ns)
    await good.waitForServices(['probe-listener'])
    await bare.waitForServices(['probe-listener'])

    bare.broadcast('camstack.evt.probe', { tag: 'from-bare' })
    good.broadcast('camstack.evt.probe', { tag: 'from-good' })
    await new Promise((r) => setTimeout(r, 100))
    expect(h.events).toEqual(['from-good'])
  }, 30_000)
})

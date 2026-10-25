/**
 * The two-step rollout of D857, removal-release half: the REAL step-2 hub against a step-1 agent.
 *
 * The step-1 (transition) release shipped a rollout matrix against real step-1 classes. Those
 * classes - the join client, the mutual-join gate - are removed here, so this spec keeps the
 * step-1 agent's OBSERVABLE moves as a small emulation and runs the real step-2 hub against it:
 *
 *   hub     agent                       registers   hub -> agent call
 *   step 2  step 1, with a secret       yes         yes   (the join is gone: the certificate serves)
 *   step 2  step 1, no secret           yes         yes
 *   step 2  anything with no certificate no          no
 *
 * What a step-1 agent does, which the hub must not break:
 *  - asks `$hub.joinChallenge`; a hub without it ("no such action") means "this hub predates the
 *    join": it goes on, and sends its registration WITH the legacy `clusterSecretHash`;
 *  - serves the hub when the hub's certificate is verified, whatever the join says.
 * `certified` stands in for `TlsTcpTransporter.verifiedPeer` (real sockets:
 * `mesh-mtls/__tests__/peer-identity.spec.ts`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createHubService } from '../../moleculer/hub-service.js'
import { createMeshAccessMiddleware } from '../../moleculer/mesh-access-middleware.js'
import {
  meshErrorType,
  MESH_NODE_UNAUTHENTICATED_TYPE,
  MeshIdentityGate,
  type MeshCallVerdict,
} from '../../moleculer/mesh-identity.js'

const AGENT = 'agent-a'
const LEGACY_HASH = 'a'.repeat(64)

const brokers: ServiceBroker[] = []
let seq = 0
afterEach(async () => {
  for (const b of brokers.splice(0)) await b.stop().catch(() => undefined)
})

/** The step-1 agent's inbound rule that matters here: the hub is served when certified. */
class Step1AgentInbound {
  constructor(private readonly certified: Set<string>) {}
  admitCall(sender: string): MeshCallVerdict {
    return sender === 'hub' && this.certified.has('hub')
      ? { verdict: 'allow' }
      : {
          verdict: 'deny',
          errorType: MESH_NODE_UNAUTHENTICATED_TYPE,
          message: 'not the certified hub',
        }
  }
  admitEvent(sender: string): MeshCallVerdict {
    return this.admitCall(sender)
  }
}

async function build(certifiedNodes: readonly string[]) {
  seq += 1
  const ns = `rollout2-${seq}`
  const certified = new Set<string>(certifiedNodes)
  const registered: Array<{ nodeId: string; hash: unknown }> = []
  const gate = new MeshIdentityGate({ ownNodeId: 'hub', isVerifiedPeer: (id) => certified.has(id) })
  const hub = new ServiceBroker({
    nodeID: 'hub',
    namespace: ns,
    transporter: 'Fake',
    logger: false,
    middlewares: [createMeshAccessMiddleware({ ownNodeId: 'hub', gate })],
  })
  hub.createService(
    createHubService({
      getAddonConfig: () => ({}),
      getSettings: () => ({}),
      getRecentEvents: () => [],
      onLog: () => {},
      meshIdentity: gate,
      onRegisterNode: (params) =>
        registered.push({ nodeId: params.nodeId, hash: Reflect.get(params, 'clusterSecretHash') }),
    }),
  )
  const agent = new ServiceBroker({
    nodeID: AGENT,
    namespace: ns,
    transporter: 'Fake',
    logger: false,
    middlewares: [
      createMeshAccessMiddleware({ ownNodeId: AGENT, gate: new Step1AgentInbound(certified) }),
    ],
  })
  agent.createService({
    name: '$agent',
    actions: { applyServerUpdate: () => ({ accepted: true }) },
  })
  brokers.push(hub, agent)
  await hub.start()
  await agent.start()
  await agent.waitForServices(['$hub'])
  await hub.waitForServices(['$agent'])
  return { hub, agent, registered }
}

async function typeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (err) {
    return meshErrorType(err) ?? (err instanceof Error ? err.message : 'error')
  }
}

describe('D857 removal release - the step-2 hub against a step-1 agent', () => {
  it('the join the agent asks for is not an action any more, so it goes on without it', async () => {
    const { agent } = await build([AGENT, 'hub'])
    for (const action of ['$hub.joinChallenge', '$hub.authenticateNode']) {
      const type = await typeOf(agent.call(action, {}, { nodeID: 'hub' }))
      expect(['SERVICE_NOT_FOUND', 'SERVICE_NOT_AVAILABLE'], action).toContain(type)
    }
  }, 30_000)

  it.each([
    ['with a secret (sends the legacy hash)', LEGACY_HASH],
    ['with no secret', undefined],
  ])(
    'a step-1 agent %s registers, and the hub update call reaches it',
    async (_label, hash) => {
      const { hub, agent, registered } = await build([AGENT, 'hub'])
      await expect(
        agent.call(
          '$hub.registerNode',
          { nodeId: AGENT, addons: [], ...(hash === undefined ? {} : { clusterSecretHash: hash }) },
          { nodeID: 'hub' },
        ),
      ).resolves.toEqual({ ok: true })
      // The hash is neither checked nor kept: the manifest is applied and the secret is nobody's.
      expect(registered.map((r) => r.nodeId)).toEqual([AGENT])
      await expect(hub.call('$agent.applyServerUpdate', {}, { nodeID: AGENT })).resolves.toEqual({
        accepted: true,
      })
    },
    30_000,
  )

  it('an agent with no certificate is refused whatever it sends - the legacy hash admits nothing', async () => {
    const { agent, registered } = await build(['hub'])
    expect(
      await typeOf(
        agent.call(
          '$hub.registerNode',
          { nodeId: AGENT, addons: [], clusterSecretHash: LEGACY_HASH },
          { nodeID: 'hub' },
        ),
      ),
    ).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
    expect(registered).toEqual([])
  }, 30_000)
})

/**
 * No code path accepts the old cluster-secret join (D857, step 2): the hub offers no
 * `joinChallenge` / `joinAuthenticate` action, a registration is admitted by the sender's
 * certificate alone (a `clusterSecretHash` or a join proof in the payload buys nothing),
 * and a sender without a verified certificate is refused on every call and event.
 */
import { Errors } from 'moleculer'
import { describe, expect, it } from 'vitest'
import { createHubService } from '../../moleculer/hub-service.js'
import {
  MESH_NODE_UNAUTHENTICATED_TYPE,
  MeshIdentityGate,
  meshErrorType,
} from '../../moleculer/mesh-identity.js'

const NODE = 'agent-1'

function gate(verified: ReadonlySet<string>): MeshIdentityGate {
  return new MeshIdentityGate({ ownNodeId: 'hub', isVerifiedPeer: (id) => verified.has(id) })
}

function registerHandler(g: MeshIdentityGate): (ctx: unknown) => unknown {
  const service = createHubService({
    getAddonConfig: () => ({}),
    getSettings: () => ({}),
    getRecentEvents: () => [],
    onLog: () => {},
    meshIdentity: g,
  })
  const action = service.actions?.['registerNode']
  if (typeof action !== 'object') throw new Error('no registerNode')
  const handler = action.handler
  if (typeof handler !== 'function') throw new Error('no handler')
  return (ctx) => Reflect.apply(handler, {}, [ctx])
}

describe('the hub has no secret join', () => {
  it('exposes no join action', () => {
    const service = createHubService({
      getAddonConfig: () => ({}),
      getSettings: () => ({}),
      getRecentEvents: () => [],
      onLog: () => {},
    })
    const actions = Object.keys(service.actions ?? {})
    expect(actions.filter((a) => /join|secret|challenge|authenticate/i.test(a))).toEqual([])
  })

  it('refuses a registration without a certificate even when it carries a secret hash or a join proof', () => {
    const register = registerHandler(gate(new Set()))
    const ctx = {
      nodeID: NODE,
      params: {
        nodeId: NODE,
        addons: [],
        clusterSecretHash: 'a'.repeat(64),
        joinProof: 'b'.repeat(64),
      },
    }
    let thrown: unknown = null
    try {
      register(ctx)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(Errors.MoleculerClientError)
    expect(meshErrorType(thrown)).toBe(MESH_NODE_UNAUTHENTICATED_TYPE)
  })

  it('admits the same registration by certificate alone, and only for the sender itself', () => {
    const g = gate(new Set([NODE]))
    expect(() => g.admitRegistration(NODE, NODE)).not.toThrow()
    expect(() => g.admitRegistration(NODE, 'another')).toThrow(Errors.MoleculerClientError)
  })

  it('denies every call and event of a sender with no verified certificate', () => {
    const g = gate(new Set())
    for (const action of ['$hub.registerNode', '$hub.joinChallenge', '$hub.joinAuthenticate']) {
      expect(g.admitCall(NODE, action).verdict, action).toBe('deny')
    }
    expect(g.admitEvent(NODE, 'camstack.evt.log').verdict).toBe('deny')
  })
})

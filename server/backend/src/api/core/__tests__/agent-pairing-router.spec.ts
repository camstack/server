/**
 * The admin pairing API (D857): discovery listing, adding by address, the pairing itself,
 * and unpairing in both directions of cause (the agent is told first; an unreachable one
 * is still revoked).
 *
 * The agent is the real `AgentPairing` behind an in-memory transport; the CA, the
 * certificate registry and the CRL are the real ones.
 */
import type { SettingsStoreClient } from '@camstack/types'
import {
  AgentPairing,
  DEFAULT_HUB_TLS_TCP_PORT,
  type AgentPairingTransport,
  type LocalPairingSecret,
  generateMeshCa,
  MeshCertificateRegistry,
  MeshCrl,
  PairingHttpError,
  type PairingResult,
} from '@camstack/system'
import type { MdnsAgent } from '@camstack/develop/hub-discovery'
import { describe, expect, it } from 'vitest'
import type { NodeCertificatesClient } from '../../../core/agent/node-certificates-client.js'
import type { AuthenticatedAgent, TrpcContext } from '../../trpc/trpc.context.js'
import { createAgentPairingRouter, resolveAgentHubAddresses } from '../agent-pairing.router.js'

const admin: AuthenticatedAgent = {
  id: 'u-admin',
  username: 'admin',
  isAdmin: true,
  permissions: { isAdmin: true, allowedProviders: '*', allowedDevices: {} },
  isApiKey: false,
  interactive: true,
  userDelegated: true,
  scopes: ['*'],
}

function memoryStore(): SettingsStoreClient {
  const rows = new Map<string, Map<string, { id: string; data: Record<string, unknown> }>>()
  const coll = (n: string) => {
    let c = rows.get(n)
    if (c === undefined) {
      c = new Map()
      rows.set(n, c)
    }
    return c
  }
  const store = {
    insert: {
      mutate: async (a: {
        collection: string
        record: { id: string; data: Record<string, unknown> }
      }) => {
        coll(a.collection).set(a.record.id, a.record)
      },
    },
    update: {
      mutate: async (a: { collection: string; id: string; data: Record<string, unknown> }) => {
        coll(a.collection).set(a.id, { id: a.id, data: a.data })
      },
    },
    delete: {
      mutate: async (a: { collection: string; key: string }) =>
        void coll(a.collection).delete(a.key),
    },
    query: {
      query: async (a: { collection: string }) => [...coll(a.collection).values()],
    },
  }
  return store as unknown as SettingsStoreClient
}

function unwrap<T extends object>(result: PairingResult<T>): T {
  if (!result.ok) throw new PairingHttpError(result.status, result.error, result.message)
  return result
}

async function setup(options: { agentReachableForUnpair?: boolean } = {}) {
  const ca = await generateMeshCa()
  const registry = new MeshCertificateRegistry(memoryStore())
  const crl = new MeshCrl()
  const installed: string[] = []
  const events: string[] = []
  const local = new Map<string, LocalPairingSecret>()
  const agent = new AgentPairing({
    nodeId: 'agent-a',
    version: '1.0.0',
    isPaired: () => installed.length > 0,
    install: async (p) => {
      installed.push(p.meshTls.certPem)
    },
    onLocalSecret: (secret) => local.set(secret.pairingId, secret),
    onLocalSecretCleared: (id) => local.delete(id),
  })
  /** What the agent's operator reads at the machine and types into the agent's page. */
  const operator = {
    code: (): string => [...local.values()][0]?.code ?? '',
    confirm: (code: string): void => {
      unwrap(agent.confirm({ code }, { local: true }))
    },
  }
  const transport: AgentPairingTransport = {
    hello: async () => agent.hello(),
    offer: async (_e, body) => unwrap(await agent.offer(body)).answer,
    reveal: async (_e, body) => {
      unwrap(agent.reveal(body))
    },
    poll: async (_e, pairingId) => unwrap(agent.poll({ pairingId })).poll,
    complete: async (_e, body) => {
      unwrap(await agent.complete(body))
    },
    reject: async (_e, pairingId) => {
      agent.cancel({ pairingId })
    },
  }
  const found: MdnsAgent[] = [
    {
      nodeId: 'agent-a',
      host: '192.168.10.128',
      port: 4444,
      version: '1.0.0',
      state: 'unpaired',
      fingerprint: null,
    },
  ]
  const client: NodeCertificatesClient = {
    getCertificates: async () => {
      throw new Error('not used')
    },
    prepareMeshRenewal: async () => {
      throw new Error('not used')
    },
    installMeshLeaf: async () => {
      throw new Error('not used')
    },
    confirmMeshLeaf: async () => {
      throw new Error('not used')
    },
    rollbackMeshLeaf: async () => {
      throw new Error('not used')
    },
    prepareHttpsCertificate: async () => {
      throw new Error('not used')
    },
    installHttpsCertificate: async () => {
      throw new Error('not used')
    },
    forgetHub: async () => {
      events.push(`forgetHub (revoked so far: ${crl.list().length})`)
      if (options.agentReachableForUnpair === false) throw new Error('timeout')
      return { ok: true as const }
    },
  }
  const router = createAgentPairingRouter({
    registry: null,
    nodeClient: (id) => (id === 'agent-a' ? client : null),
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    transport,
    meshCa: () => ca,
    meshRegistry: () => registry,
    crl: () => crl,
    peers: {
      peerLeaf: () => undefined,
      dropPeer: () => {
        events.push('dropPeer')
        return 1
      },
    },
    isNodeConnected: () => false,
    hubAddresses: async () => ({
      hubUrl: 'https://hub.example.test:4443',
      hubMeshAddress: 'hub.example.test:6443',
    }),
    browse: async () => found,
  })
  const ctx: TrpcContext = { user: admin }
  return {
    caller: router.createCaller(ctx),
    agent,
    operator,
    registry,
    crl,
    installed,
    events,
    ca,
  }
}

describe('agentPairing router', () => {
  it('lists agents found on the LAN and the addresses typed so far', async () => {
    const { caller } = await setup()
    const listed = await caller.listDiscoveredAgents()
    expect(listed.agents).toEqual([
      expect.objectContaining({
        nodeId: 'agent-a',
        host: '192.168.10.128',
        state: 'unpaired',
        source: 'mdns',
        connected: false,
        pairing: null,
      }),
    ])

    const typed = await caller.addAgentByAddress({ host: '192.168.10.77' })
    expect(typed).toMatchObject({
      nodeId: 'agent-a',
      state: 'unpaired',
      source: 'address',
    })
    const again = await caller.listDiscoveredAgents()
    expect(again.agents.map((a) => `${a.host}:${a.port}`).toSorted()).toEqual([
      '192.168.10.128:4444',
      '192.168.10.77:4444',
    ])
  })

  it('pairs an agent: begin, both operators type the other screen, a certificate is recorded', async () => {
    const { caller, operator, registry, installed } = await setup()
    const started = await caller.beginPairing({
      host: '192.168.10.128',
      port: 4444,
    })
    expect(started.state).toBe('awaiting-confirmation')
    expect(started.code).toMatch(/^\d{6}$/)
    // The agent shows its own code only after its operator confirmed locally (D857).
    expect(operator.code()).toBe('')

    // The pairing now shows under the agent that is being paired.
    const during = await caller.listDiscoveredAgents()
    expect(during.agents[0]?.pairing?.pairingId).toBe(started.pairingId)

    // Typing the hub's own code is the shortcut that defeats the check - and still has to match.
    await expect(
      caller.confirmPairing({ pairingId: started.pairingId, code: '12345x' }),
    ).rejects.toThrow(/not the code/)

    operator.confirm(started.code)
    const done = await caller.confirmPairing({
      pairingId: started.pairingId,
      code: operator.code(),
    })
    expect(done.state).toBe('paired')
    expect(installed).toHaveLength(1)
    expect(registry.list('agent-a')).toHaveLength(1)
    expect(registry.list('agent-a')[0]?.issuedVia).toBe('pairing')
  })

  it('rejecting cancels the agent as well', async () => {
    const { caller, agent } = await setup()
    const started = await caller.beginPairing({
      host: '192.168.10.128',
      port: 4444,
    })
    const rejected = await caller.rejectPairing({
      pairingId: started.pairingId,
    })
    expect(rejected.state).toBe('rejected')
    expect(agent.state()).toBe('unpaired')
  })

  it('unpairing tells the agent FIRST, then revokes every certificate and drops the connection', async () => {
    const { caller, operator, registry, crl, events } = await setup()
    const started = await caller.beginPairing({
      host: '192.168.10.128',
      port: 4444,
    })
    operator.confirm(started.code)
    await caller.confirmPairing({
      pairingId: started.pairingId,
      code: operator.code(),
    })
    expect(registry.list('agent-a')[0]?.revokedAt).toBeNull()

    const result = await caller.unpairAgent({ nodeId: 'agent-a' })
    expect(result.agentNotified).toBe(true)
    expect(result.revokedSerials).toHaveLength(1)
    // The agent was told while nothing was revoked yet; the connection dropped after.
    expect(events).toEqual(['forgetHub (revoked so far: 0)', 'dropPeer'])
    expect(crl.list()).toHaveLength(1)
    expect(registry.list('agent-a')[0]?.revokedAt).not.toBeNull()
  })

  it('an agent that cannot be reached is still revoked, and the answer says it must be unpaired by hand', async () => {
    const { caller, operator, crl } = await setup({
      agentReachableForUnpair: false,
    })
    const started = await caller.beginPairing({
      host: '192.168.10.128',
      port: 4444,
    })
    operator.confirm(started.code)
    await caller.confirmPairing({
      pairingId: started.pairingId,
      code: operator.code(),
    })

    const result = await caller.unpairAgent({ nodeId: 'agent-a' })
    expect(result.agentNotified).toBe(false)
    expect(result.next).toMatch(/own page/)
    expect(crl.list()).toHaveLength(1)
  })

  it('refuses to unpair the hub', async () => {
    const { caller } = await setup()
    await expect(caller.unpairAgent({ nodeId: 'hub' })).rejects.toThrow(/not an agent/)
  })
})

describe('the address an agent is offered', () => {
  const roles = (internal: string | null, publicEndpoint: string | null) => ({
    roles: { internal: { resolved: internal }, publicEndpoint: { resolved: publicEndpoint } },
  })

  it('is the INTERNAL role, never the public endpoint an agent on the LAN need not reach', () => {
    const offered = resolveAgentHubAddresses(
      roles('https://192.168.1.9:4443', 'https://camstack.example.test'),
    )
    expect(offered.hubUrl).toBe('https://192.168.1.9:4443')
    expect(offered.hubMeshAddress).toBe(`192.168.1.9:${DEFAULT_HUB_TLS_TCP_PORT}`)
  })

  it('refuses when the hub has no internal address yet', () => {
    expect(() => resolveAgentHubAddresses(roles(null, 'https://camstack.example.test'))).toThrow(
      /no LAN address/,
    )
  })
})

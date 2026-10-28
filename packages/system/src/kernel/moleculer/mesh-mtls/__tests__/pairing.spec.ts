/**
 * Agent pairing (D857): hub-initiated, six digits confirmed on BOTH sides, a one-time PIN shown only on
 * the agent's own machine, a certificate from the mesh CA only afterwards.
 *
 * The hub and the agent are the real classes, joined by an in-memory transport (the HTTP routes are
 * covered separately). A man in the middle is a transport wrapper that swaps in its own CA and key.
 * `local` stands for the agent's console / 0600 file / local window: the only place a PIN and the
 * agent's code appear.
 */
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AgentPairing,
  type AgentPairingDeps,
  type InstalledPairing,
  type LocalPairingSecret,
  type PairingResult,
} from '../pairing/agent-pairing.js'
import {
  HubPairing,
  PairingHttpError,
  type AgentEndpoint,
  type AgentPairingTransport,
  type HubPairingDeps,
} from '../pairing/hub-pairing.js'
import {
  computePairingCommitment,
  computePairingSas,
  leafFingerprintCompact,
  PAIRING_MAX_CODE_ATTEMPTS,
  PAIRING_MAX_SESSIONS,
  PAIRING_OFFER_USE,
  PAIRING_PROOF_USE,
  PAIRING_PROTOCOL,
  PAIRING_TTL_MS,
  signPairingOffer,
  signPairingProof,
  verifyPairingProof,
  type PairingProofClaims,
} from '../pairing/pairing-protocol.js'
import {
  caFingerprintCompact,
  generateMeshCa,
  issueMeshLeafFromCsr,
  type MeshCaSigner,
} from '../mesh-ca.js'

const ENDPOINT: AgentEndpoint = { host: '192.0.2.10', port: 4444 }
const NODE_ID = 'agent-a'
const REMOTE = { local: false } as const
const LOCAL = { local: true } as const

function unwrap<T extends object>(result: PairingResult<T>): T {
  if (!result.ok) throw new PairingHttpError(result.status, result.error, result.message)
  return result
}

/** The rig's fake clock, so signed offers carry the time the agent will judge them by. */
let offerClock: { now: number } | null = null

/** A hub's offer for `agentNodeId`, signed with `ca`'s key (a stranger holding only the cert cannot). */
function signedOffer(
  ca: MeshCaSigner,
  fields: {
    readonly agentNodeId?: string
    readonly hubNodeId?: string
    readonly commitment: string
    readonly hubUrl: string
    readonly hubMeshAddress: string
    readonly iat?: number
  },
) {
  const hubNodeId = fields.hubNodeId ?? 'hub'
  return {
    protocol: PAIRING_PROTOCOL,
    hubNodeId,
    hubCaCertPem: ca.certPem,
    commitment: fields.commitment,
    hubUrl: fields.hubUrl,
    hubMeshAddress: fields.hubMeshAddress,
    signature: signPairingOffer(ca.keyPem, {
      use: PAIRING_OFFER_USE,
      agentNodeId: fields.agentNodeId ?? NODE_ID,
      hubNodeId,
      caFingerprint: caFingerprintCompact(ca.certPem),
      commitment: fields.commitment,
      hubUrl: fields.hubUrl,
      hubMeshAddress: fields.hubMeshAddress,
      iat: fields.iat ?? offerClock?.now ?? Date.now(),
    }),
  }
}

/** The agent's HTTP surface, called in-process. */
function directTransport(agent: AgentPairing): AgentPairingTransport {
  return {
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
      // The hub withdrawing its own pairing goes by the pairing id.
      agent.cancel({ pairingId })
    },
  }
}

interface Rig {
  readonly ca: MeshCaSigner
  readonly hub: HubPairing
  readonly agent: AgentPairing
  readonly installed: InstalledPairing[]
  readonly recorded: string[]
  readonly revocations: Array<{ reason: string; keep: string | undefined }>
  readonly leafRevocations: string[]
  readonly resetCodes: string[]
  readonly clock: { now: number }
  readonly connected: Set<string>
  readonly known: string[]
  /** What the agent's own machine was told, by pairing id. */
  readonly local: Map<string, LocalPairingSecret>
  readonly logs: string[]
}

interface RigOptions {
  readonly transport?: (agent: AgentPairing) => AgentPairingTransport
  readonly agentPaired?: () => boolean
  readonly agentNodeId?: string
  readonly ca?: MeshCaSigner
  readonly clock?: { now: number }
  readonly leafPresented?: () => boolean
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const ca = options.ca ?? (await generateMeshCa())
  const clock = options.clock ?? { now: Date.now() }
  offerClock = clock
  const installed: InstalledPairing[] = []
  const recorded: string[] = []
  const revocations: Rig['revocations'] = []
  const leafRevocations: string[] = []
  const resetCodes: string[] = []
  const connected = new Set<string>()
  const known: string[] = []
  const local = new Map<string, LocalPairingSecret>()
  const logs: string[] = []
  const agentDeps: AgentPairingDeps = {
    nodeId: options.agentNodeId ?? NODE_ID,
    version: '1.0.0',
    isPaired: options.agentPaired ?? (() => installed.length > 0),
    install: async (pairing) => {
      installed.push(pairing)
    },
    now: () => clock.now,
    log: (m) => logs.push(m),
    onLocalSecret: (s) => local.set(s.pairingId, s),
    onLocalSecretCleared: (id) => local.delete(id),
    onResetCode: (code) => resetCodes.push(code),
  }
  const agent = new AgentPairing(agentDeps)
  const hubDeps: HubPairingDeps = {
    transport: (options.transport ?? directTransport)(agent),
    ca: () => ca,
    hubNodeId: 'hub',
    hubUrl: async () => 'https://hub.example.test:4443',
    hubMeshAddress: async () => 'hub.example.test:6443',
    isNodeConnected: (nodeId) => connected.has(nodeId),
    knownNodeIds: () => known,
    recordIssued: async (nodeId) => {
      recorded.push(nodeId)
    },
    revokeNode: async (_nodeId, reason, keep) => {
      revocations.push({ reason, keep })
    },
    isLeafPresented: () => options.leafPresented?.() === true,
    revokeLeaf: async (_nodeId, _certPem, reason) => {
      leafRevocations.push(reason)
    },
    now: () => clock.now,
  }
  return {
    ca,
    hub: new HubPairing(hubDeps),
    agent,
    installed,
    recorded,
    revocations,
    leafRevocations,
    resetCodes,
    clock,
    connected,
    known,
    local,
    logs,
  }
}

/** The one pending pairing's local secret (its console line). */
function theLocal(r: Rig, pairingId?: string): LocalPairingSecret {
  if (pairingId !== undefined) {
    const one = r.local.get(pairingId)
    if (one === undefined) throw new Error('no local secret for that pairing')
    return one
  }
  const [only] = [...r.local.values()]
  if (only === undefined || r.local.size !== 1)
    throw new Error(`expected one local secret, got ${r.local.size}`)
  return only
}

/** The hub operator reads the agent's console, the agent operator reads the hub's page. */
async function bothOperatorsConfirm(r: Rig, pairingId: string, order: 'hub-first' | 'agent-first') {
  const hubView = r.hub.get(pairingId)
  const local = r.local.get(pairingId)
  if (hubView === undefined || local === undefined) {
    throw new Error('pairing not ready')
  }
  let agentCode: string | undefined
  const confirmAgent = () => {
    agentCode = unwrap(r.agent.confirm({ pin: local.pin, code: hubView.code }, REMOTE)).code
  }
  if (order === 'agent-first') confirmAgent()
  await r.hub.confirm(pairingId, agentCode ?? hubView.code)
  if (order === 'hub-first') confirmAgent()
  return r.hub.advance(pairingId)
}

describe('the code binds everything a man in the middle would have to change', () => {
  it('moves with the CA, the agent key, the hub nonce and the agent nonce - and with nothing else', async () => {
    const caA = await generateMeshCa()
    const caB = await generateMeshCa()
    const base = {
      caCertPem: caA.certPem,
      agentPublicKeySpki: 'a2V5LWE=',
      hubNonce: 'hub-nonce',
      agentNonce: 'agent-nonce',
    }
    const code = computePairingSas(base)
    expect(code).toMatch(/^\d{6}$/)
    expect(computePairingSas({ ...base })).toBe(code)
    expect(computePairingSas({ ...base, caCertPem: caB.certPem })).not.toBe(code)
    expect(computePairingSas({ ...base, agentPublicKeySpki: 'a2V5LWI=' })).not.toBe(code)
    expect(computePairingSas({ ...base, hubNonce: 'other-hub-nonce' })).not.toBe(code)
    expect(computePairingSas({ ...base, agentNonce: 'other-agent-nonce' })).not.toBe(code)
  })
})

describe('pairing - the happy path', () => {
  it('both sides compute the same six digits, and a certificate is installed after both confirmed', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    expect(started.code).toMatch(/^\d{6}$/)
    expect(theLocal(r).code).toBeNull()
    expect(r.agent.state()).toBe('pending')

    const done = await bothOperatorsConfirm(r, started.pairingId, 'hub-first')
    expect(done.state).toBe('paired')
    expect(r.installed).toHaveLength(1)
    const [installed] = r.installed
    if (installed === undefined) throw new Error('nothing installed')
    const leaf = new X509Certificate(installed.meshTls.certPem)
    expect(leaf.subject).toContain(`CN=${NODE_ID}`)
    expect(leaf.verify(new X509Certificate(r.ca.certPem).publicKey)).toBe(true)
    expect(leaf.checkPrivateKey(createPrivateKey(installed.meshTls.keyPem))).toBe(true)
    expect(installed.meshTls.caCertPem).toBe(r.ca.certPem)
    expect(installed.hubAddress).toBe('hub.example.test')
    expect(r.recorded).toEqual([NODE_ID])
    expect(r.local.size).toBe(0)
  })

  it('works in either order of the two confirmations', async () => {
    for (const order of ['hub-first', 'agent-first'] as const) {
      const r = await rig()
      const started = await r.hub.begin(ENDPOINT)
      const done = await bothOperatorsConfirm(r, started.pairingId, order)
      expect(done.state, order).toBe('paired')
      expect(r.installed, order).toHaveLength(1)
    }
  })

  it('does not complete on the hub alone: the agent has not confirmed', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    const view = await r.hub.confirm(started.pairingId, started.code)
    expect(view.hubConfirmed).toBe(true)
    expect(view.agentConfirmed).toBe(false)
    expect(view.state).toBe('awaiting-confirmation')
    expect(r.installed).toEqual([])
  })

  it('revokes the OLDER leaves of the node id only after the new pairing completed, never before (L11)', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    // Pairing begun, both confirmed on the hub side only: nothing revoked yet.
    await r.hub.confirm(started.pairingId, started.code)
    expect(r.revocations).toEqual([])
    unwrap(r.agent.confirm({ pin: theLocal(r).pin, code: started.code }, REMOTE))
    await r.hub.advance(started.pairingId)
    const [installed] = r.installed
    expect(r.revocations).toEqual([
      { reason: 'superseded by pairing', keep: installed?.meshTls.certPem },
    ])
  })
})

describe('the agent confirms only for someone at its own machine (C1)', () => {
  it('the network sees who asks and until when - never a code, a pairing id or a PIN', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    const exposed = JSON.stringify(r.agent.publicView())
    const local = theLocal(r)
    for (const secret of [local.pin, started.pairingId, started.code]) {
      expect(exposed).not.toContain(secret)
    }
    expect(r.agent.publicView().pending).toHaveLength(1)
    expect(r.agent.publicView().pending[0]?.hub.caFingerprint).toBe(
      caFingerprintCompact(r.ca.certPem),
    )
    // The local view carries them.
    expect(r.agent.localView().pending[0]).toMatchObject({ pin: local.pin })
  })

  it("the agent's own code stays hidden until its operator confirmed, then loopback shows it and the confirm answers with it", async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    const local = theLocal(r)
    // The console/file announcement at reveal carries the PIN and no code.
    expect(local.code).toBeNull()
    expect(r.agent.localView().pending[0]?.code).toBeNull()
    const confirmed = r.agent.confirm({ code: started.code }, LOCAL)
    // After the local confirmation the console is told the agent's own code.
    expect(theLocal(r).code).toBe(started.code)
    expect(confirmed).toMatchObject({ ok: true, code: started.code })
    expect(r.agent.localView().pending[0]?.code).toBe(started.code)
  })

  it('the network view never carries the code, even after the local confirmation; the PIN-authenticated confirm does', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    const local = theLocal(r)
    const confirmed = r.agent.confirm({ code: started.code, pin: local.pin }, REMOTE)
    expect(confirmed).toMatchObject({ ok: true, code: started.code })
    expect(JSON.stringify(r.agent.publicView())).not.toContain(started.code)
  })

  it('a remote confirm without the PIN is refused, with a wrong PIN is refused, with the PIN works', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    const local = theLocal(r)
    expect(r.agent.confirm({ code: started.code }, REMOTE)).toMatchObject({
      ok: false,
      status: 401,
      error: 'pin-required',
    })
    expect(r.agent.confirm({ code: started.code, pin: '00000000' }, REMOTE)).toMatchObject({
      ok: false,
      error: 'pin-required',
    })
    expect(r.agent.localView().pending[0]?.localConfirmed).toBe(false)
    expect(r.agent.confirm({ code: started.code, pin: local.pin }, REMOTE).ok).toBe(true)
    expect(r.agent.localView().pending[0]?.localConfirmed).toBe(true)
  })

  it('a rogue hub that knows the pairing id and the hub-side code still cannot confirm for the operator', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    // What a LAN attacker can learn from the network: hello, public status, the offer answer it made itself.
    const result = r.agent.confirm({ pairingId: started.pairingId, code: started.code }, REMOTE)
    expect(result).toMatchObject({ ok: false, error: 'pin-required' })
    expect(r.agent.reject({ pairingId: started.pairingId }, REMOTE)).toMatchObject({
      ok: false,
      error: 'pin-required',
    })
    expect(r.agent.state()).toBe('pending')
  })

  it('genuine loopback confirms without a PIN when there is one pairing; with several it must name one', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    expect(r.agent.confirm({ code: started.code }, LOCAL).ok).toBe(true)

    const two = await rig()
    const caB = await generateMeshCa()
    await two.hub.begin(ENDPOINT)
    const other = new HubPairing({
      transport: directTransport(two.agent),
      ca: () => caB,
      hubNodeId: 'hub',
      hubUrl: async () => 'https://other.example.test:4443',
      hubMeshAddress: async () => 'other.example.test:6443',
      isNodeConnected: () => false,
      recordIssued: async () => undefined,
      revokeNode: async () => undefined,
    })
    await other.begin(ENDPOINT)
    expect(two.agent.state()).toBe('pending')
    expect(two.agent.confirm({ code: '000000' }, LOCAL)).toMatchObject({
      ok: false,
      error: 'ambiguous',
    })
  })

  it('wrong PINs lock confirming for a while, whoever holds the right one', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    for (let i = 0; i < 5; i++) r.agent.confirm({ code: started.code, pin: '11111111' }, REMOTE)
    expect(r.agent.confirm({ code: started.code, pin: theLocal(r).pin }, REMOTE)).toMatchObject({
      ok: false,
      error: 'pin-locked',
    })
    r.clock.now += 2 * 60_000 + 1
    expect(r.agent.confirm({ code: started.code, pin: theLocal(r).pin }, REMOTE).ok).toBe(true)
  })
})

describe('the agent installs nothing without its own operator', () => {
  it('refuses a perfectly valid completion until the local operator confirmed (local confirmation is the gate)', async () => {
    let captured: Parameters<AgentPairingTransport['complete']>[1] | null = null
    const spy = await rig({
      transport: (agent) => ({
        ...directTransport(agent),
        // The hub is allowed to complete only when it believes the agent confirmed; force the call.
        poll: async (_e, pairingId) => ({
          ...unwrap(agent.poll({ pairingId })).poll,
          localConfirmed: true,
        }),
        complete: async (e, body) => {
          captured = body
          await directTransport(agent).complete(e, body)
        },
      }),
    })
    const started = await spy.hub.begin(ENDPOINT)
    // The hub is lied to (or races): it sends the completion with no local confirmation.
    await spy.hub.confirm(started.pairingId, started.code)
    expect(captured).not.toBeNull()
    expect(spy.installed).toEqual([])
    expect(spy.agent.state()).toBe('pending')
    // The same completion is accepted once the local operator confirmed.
    unwrap(spy.agent.confirm({ pin: theLocal(spy).pin, code: started.code }, REMOTE))
    if (captured === null) throw new Error('no completion captured')
    unwrap(await spy.agent.complete(captured))
    expect(spy.installed).toHaveLength(1)
  })
})

describe('pairing - a man in the middle shows a different code', () => {
  /** Swaps the hub's CA for the attacker's, and the agent's key for the attacker's. */
  async function mitm(attackerCa: MeshCaSigner) {
    const { createMeshCsrPem, generateMeshKeyPair } = await import('../mesh-ca.js')
    const attackerKeys = await generateMeshKeyPair()
    const attackerCsr = await createMeshCsrPem(attackerKeys, NODE_ID)
    const attackerHubNonce = 'aa'.repeat(32)
    let toAgentPairingId = ''
    const seen: { csrPem: string; agentNonce: string } = { csrPem: '', agentNonce: '' }
    const transport = (agent: AgentPairing): AgentPairingTransport => ({
      ...directTransport(agent),
      offer: async (_e, body) => {
        const answer = unwrap(
          await agent.offer(
            signedOffer(attackerCa, {
              commitment: computePairingCommitment(attackerCa.certPem, attackerHubNonce),
              hubUrl: body.hubUrl,
              hubMeshAddress: body.hubMeshAddress,
            }),
          ),
        ).answer
        toAgentPairingId = answer.pairingId
        seen.csrPem = answer.csrPem
        seen.agentNonce = answer.agentNonce
        // To the hub: the attacker's key, the agent's pairing id and nonce.
        return { ...answer, csrPem: attackerCsr }
      },
      reveal: async () => {
        unwrap(agent.reveal({ pairingId: toAgentPairingId, hubNonce: attackerHubNonce }))
      },
    })
    return { transport, seen, attackerHubNonce }
  }

  it('the codes differ, so neither operator can confirm the other side', async () => {
    const attackerCa = await generateMeshCa()
    const m = await mitm(attackerCa)
    const base = await rig({ transport: m.transport })
    const started = await base.hub.begin(ENDPOINT)
    expect(started.code).toMatch(/^\d{6}$/)
    // The agent's own code is not announced before its operator confirmed: nothing to copy.
    expect(theLocal(base).code).toBeNull()

    // The agent's operator types the hub's code: the agent computed another one and refuses, so it
    // never reveals its code; the hub refuses a code that is not the one it computed.
    const notTheHubs = started.code === '000000' ? '111111' : '000000'
    await expect(base.hub.confirm(started.pairingId, notTheHubs)).rejects.toThrow(/not the code/)
    const wrong = base.agent.confirm({ pin: theLocal(base).pin, code: started.code }, REMOTE)
    expect(wrong.ok).toBe(false)
    expect(base.agent.localView().pending[0]?.localConfirmed).toBe(false)
  })

  it('the attacker cannot complete the pairing on the agent without a local confirmation', async () => {
    const attackerCa = await generateMeshCa()
    const m = await mitm(attackerCa)
    const base = await rig({ transport: m.transport })
    await base.hub.begin(ENDPOINT)
    const pairingId = theLocal(base).pairingId
    // The attacker has seen everything the agent answered, so it can build a COMPLETE and CONSISTENT
    // completion. Nothing but the agent's own operator stands between this and an install.
    const attackerLeaf = await issueMeshLeafFromCsr(attackerCa, m.seen.csrPem, {
      expectedNodeId: NODE_ID,
    })
    const proof = signPairingProof(attackerCa.keyPem, {
      v: PAIRING_PROTOCOL,
      use: PAIRING_PROOF_USE,
      pairingId,
      nodeId: NODE_ID,
      hubNonce: m.attackerHubNonce,
      agentNonce: m.seen.agentNonce,
      leafFingerprint: leafFingerprintCompact(attackerLeaf.certPem),
      caFingerprint: caFingerprintCompact(attackerCa.certPem),
      hubMeshAddress: 'hub.example.test:6443',
      hubUrl: 'https://hub.example.test:4443',
      iat: base.clock.now,
      exp: base.clock.now + 60_000,
    })
    const refused = await base.agent.complete({
      pairingId,
      leafPem: attackerLeaf.certPem,
      caCertPem: attackerCa.certPem,
      proof,
    })
    expect(refused).toMatchObject({ ok: false, error: 'awaiting-local-confirmation' })
    expect(base.installed).toEqual([])
    expect(base.agent.state()).toBe('pending')
  })
})

describe('pairing - the proof is bound to this pairing', () => {
  async function confirmedPair() {
    let body: Parameters<AgentPairingTransport['complete']>[1] | null = null
    const captured = await rig({
      transport: (agent) => ({
        ...directTransport(agent),
        complete: async (_e, b) => {
          body = b
        },
      }),
    })
    const started = await captured.hub.begin(ENDPOINT)
    await bothOperatorsConfirm(captured, started.pairingId, 'hub-first')
    if (body === null) throw new Error('no completion captured')
    return { captured, body: body as Parameters<AgentPairingTransport['complete']>[1] }
  }

  it('accepts the genuine completion, refuses a tampered proof, a swapped leaf and a foreign CA', async () => {
    const { captured, body } = await confirmedPair()
    const other = await generateMeshCa()
    const { issueMeshLeafForNode } = await import('../mesh-ca.js')
    const foreignLeaf = await issueMeshLeafForNode(other, NODE_ID)
    const tamperedProof = `${body.proof.slice(0, -4)}AAAA`
    expect((await captured.agent.complete({ ...body, proof: tamperedProof })).ok).toBe(false)
    expect((await captured.agent.complete({ ...body, leafPem: foreignLeaf.certPem })).ok).toBe(
      false,
    )
    expect((await captured.agent.complete({ ...body, caCertPem: other.certPem })).ok).toBe(false)
    expect(captured.installed).toEqual([])
  })

  it('refuses a proof with a lifetime past the maximum, or issued in the future (L12)', async () => {
    for (const mutate of [
      (c: PairingProofClaims): PairingProofClaims => ({ ...c, exp: c.iat + 6 * 60_000 }),
      (c: PairingProofClaims): PairingProofClaims => ({
        ...c,
        iat: c.iat + 10 * 60_000,
        exp: c.iat + 11 * 60_000,
      }),
    ]) {
      const { captured, body } = await confirmedPair()
      const claims = verifyPairingProof(captured.ca.certPem, body.proof)
      if (claims === null) throw new Error('the genuine proof does not verify')
      // Signed by the REAL hub CA: only the lifetime differs, and that alone is refused.
      const reSigned = signPairingProof(captured.ca.keyPem, mutate(claims))
      expect(await captured.agent.complete({ ...body, proof: reSigned })).toMatchObject({
        ok: false,
        error: 'bad-proof',
      })
      expect(captured.installed).toEqual([])
    }
  })
})

describe('pairing - one hub at a time per CA, expiry, wrong codes', () => {
  it('a paired agent refuses every offer, and the hub refuses an agent that says it is paired', async () => {
    const paired = await rig({ agentPaired: () => true })
    const offered = await paired.agent.offer({
      protocol: PAIRING_PROTOCOL,
      hubNodeId: 'hub',
      hubCaCertPem: paired.ca.certPem,
      commitment: 'a'.repeat(64),
      hubUrl: 'https://hub.example.test',
      hubMeshAddress: 'hub.example.test:6443',
    })
    expect(offered).toMatchObject({ ok: false, status: 409, error: 'already-paired' })
    await expect(paired.hub.begin(ENDPOINT)).rejects.toThrow(/already paired/)
  })

  it('refuses a node id that is already connected to the hub', async () => {
    const r = await rig()
    r.connected.add(NODE_ID)
    await expect(r.hub.begin(ENDPOINT)).rejects.toThrow(/already connected/)
  })

  it('expiry cancels both sides and nothing can be completed afterwards', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    r.clock.now += PAIRING_TTL_MS + 1
    expect(r.agent.state()).toBe('unpaired')
    const view = await r.hub.advance(started.pairingId)
    expect(view.state).toBe('expired')
    const late = await r.agent.complete({ pairingId: started.pairingId })
    expect(late).toMatchObject({ ok: false, error: 'no-pairing' })
  })

  it('a rejection by the agent operator is noticed by the hub; one on the hub cancels the agent', async () => {
    const a = await rig()
    const s1 = await a.hub.begin(ENDPOINT)
    a.agent.reject({ pin: theLocal(a).pin }, REMOTE)
    expect((await a.hub.advance(s1.pairingId)).state).toBe('failed')

    const b = await rig()
    const s2 = await b.hub.begin(ENDPOINT)
    await b.hub.reject(s2.pairingId)
    expect(b.agent.state()).toBe('unpaired')
  })

  it('three wrong codes cancel the pairing on the side that was typed into', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    const wrong = started.code === '000000' ? '111111' : '000000'
    for (let i = 1; i < PAIRING_MAX_CODE_ATTEMPTS; i++) {
      await expect(r.hub.confirm(started.pairingId, wrong)).rejects.toThrow()
      expect(r.hub.get(started.pairingId)?.state).toBe('awaiting-confirmation')
    }
    await expect(r.hub.confirm(started.pairingId, wrong)).rejects.toThrow(/cancelled/)
    expect(r.hub.get(started.pairingId)?.state).toBe('rejected')
    expect(r.agent.state()).toBe('unpaired')
  })

  it('a revealed nonce that does not match the commitment ends the pairing', async () => {
    const r = await rig()
    const answer = unwrap(
      await r.agent.offer(
        signedOffer(r.ca, {
          commitment: computePairingCommitment(r.ca.certPem, 'real-nonce'),
          hubUrl: 'https://hub.example.test:4443',
          hubMeshAddress: 'hub.example.test:6443',
        }),
      ),
    ).answer
    const refused = r.agent.reveal({ pairingId: answer.pairingId, hubNonce: 'another-nonce' })
    expect(refused).toMatchObject({ ok: false, error: 'commitment-mismatch' })
    expect(r.agent.state()).toBe('unpaired')
  })
})

describe('offer squatting and grinding (H2, M4)', () => {
  function offerFrom(ca: MeshCaSigner, label: string) {
    return signedOffer(ca, {
      commitment: computePairingCommitment(ca.certPem, label),
      hubUrl: `https://${label}.example.test:4443`,
      hubMeshAddress: `${label}.example.test:6443`,
    })
  }

  it('holds up to four pending pairings; a fifth signed offer evicts the oldest one the hub never touched', async () => {
    const r = await rig()
    const cas = await Promise.all(
      Array.from({ length: PAIRING_MAX_SESSIONS + 1 }, () => generateMeshCa()),
    )
    const ids: string[] = []
    for (const [i, ca] of cas.slice(0, PAIRING_MAX_SESSIONS).entries()) {
      ids.push(unwrap(await r.agent.offer(offerFrom(ca, `hub${i}`))).answer.pairingId)
      r.clock.now += 1
    }
    const fifth = cas[PAIRING_MAX_SESSIONS]
    if (fifth === undefined) throw new Error('missing CA')
    // The first hub is alive (it polled); the second is the oldest that never was.
    r.agent.poll({ pairingId: ids[0] })
    expect((await r.agent.offer(offerFrom(fifth, 'hub-x'))).ok).toBe(true)
    expect(r.agent.publicView().pending).toHaveLength(PAIRING_MAX_SESSIONS)
    expect(unwrap(r.agent.poll({ pairingId: ids[1] })).poll.state).toBe('idle')
    expect(unwrap(r.agent.poll({ pairingId: ids[0] })).poll.state).toBe('pending')
  })

  it('when every pending hub is alive a newcomer is refused, and the reset code clears the board (N1)', async () => {
    const r = await rig()
    for (let i = 0; i < PAIRING_MAX_SESSIONS; i++) {
      const id = unwrap(await r.agent.offer(offerFrom(await generateMeshCa(), `live${i}`))).answer
        .pairingId
      r.agent.poll({ pairingId: id })
    }
    expect(await r.agent.offer(offerFrom(await generateMeshCa(), 'late'))).toMatchObject({
      ok: false,
      error: 'too-many-pending',
    })
    expect(r.agent.reset({ code: '00000000' }, { local: false, source: '10.0.0.9' })).toMatchObject(
      {
        ok: false,
        error: 'reset-code-required',
      },
    )
    const code = r.resetCodes[0] ?? ''
    expect(code).toMatch(/^\d{8}$/)
    expect(r.agent.reset({ code }, { local: false, source: '10.0.0.9' }).ok).toBe(true)
    expect(r.agent.publicView().pending).toEqual([])
    expect((await r.agent.offer(offerFrom(await generateMeshCa(), 'after'))).ok).toBe(true)
    // The code is renewed on use: the old one is worth nothing.
    expect(r.resetCodes).toHaveLength(2)
    expect(r.agent.reset({ code }, { local: false, source: '10.0.0.9' }).ok).toBe(false)
  })

  it('the reset clears the lockout of an offer budget spent by throwaway CAs, and loopback needs no code', async () => {
    const r = await rig()
    for (let i = 0; i < 3; i++) {
      const offered = unwrap(await r.agent.offer(offerFrom(await generateMeshCa(), `t${i}`)))
      r.agent.reject({ pin: r.local.get(offered.answer.pairingId)?.pin }, { local: false })
    }
    expect(await r.agent.offer(offerFrom(await generateMeshCa(), 'real'))).toMatchObject({
      error: 'offer-budget',
    })
    expect(r.agent.localView().lockedOut).toBe(true)
    expect(r.agent.reset({}, LOCAL).ok).toBe(true)
    expect(r.agent.localView().lockedOut).toBe(false)
    expect((await r.agent.offer(offerFrom(await generateMeshCa(), 'real2'))).ok).toBe(true)
  })

  it('the local view reports no lockout on a fresh agent', async () => {
    const r = await rig()
    expect(r.agent.localView().lockedOut).toBe(false)
  })

  it('a hub offering again replaces its own pending pairing, and that counts as abandoned', async () => {
    const r = await rig()
    const ca = await generateMeshCa()
    for (const label of ['one', 'two', 'three']) {
      expect((await r.agent.offer(offerFrom(ca, label))).ok).toBe(true)
      expect(r.agent.publicView().pending).toHaveLength(1)
    }
    // Each replacement was an abandonment by the same CA: the next re-offer waits.
    expect(await r.agent.offer(offerFrom(ca, 'four'))).toMatchObject({
      ok: false,
      error: 'offer-backoff',
    })
  })

  it('a hub CA minted in the DST fall-back hour is still refused when its UTC notBefore is too far ahead', async () => {
    // 01:30Z is 02:30 in Europe/Rome, the hour that occurs twice when CEST falls back to CET.
    const r = await rig({ clock: { now: Date.parse('2026-10-25T01:30:00.000Z') } })
    const slightlyAhead = await generateMeshCa(new Date(r.clock.now + 5 * 60_000 + 30_000))
    expect((await r.agent.offer(offerFrom(slightlyAhead, 'skew-dst-ok'))).ok).toBe(true)
    const farAhead = await generateMeshCa(new Date(r.clock.now + 10 * 60_000))
    expect(await r.agent.offer(offerFrom(farAhead, 'skew-dst-bad'))).toMatchObject({
      ok: false,
      error: 'bad-ca',
    })
  })

  it('an agent whose clock runs a little behind still accepts a freshly minted hub CA, but not one from the far future', async () => {
    const r = await rig()
    // The CA is backdated by 5 min, so its notBefore lands 30 s ahead of the agent clock.
    const slightlyAhead = await generateMeshCa(new Date(r.clock.now + 5 * 60_000 + 30_000))
    expect((await r.agent.offer(offerFrom(slightlyAhead, 'skew-ok'))).ok).toBe(true)
    const farAhead = await generateMeshCa(new Date(r.clock.now + 10 * 60_000))
    expect(await r.agent.offer(offerFrom(farAhead, 'skew-bad'))).toMatchObject({
      ok: false,
      error: 'bad-ca',
    })
  })

  it('the grinding loop (offer, reveal, read the code, abort, again) gets at most three codes in ten minutes', async () => {
    const r = await rig()
    let codesSeen = 0
    for (let i = 0; i < 10; i++) {
      const ca = await generateMeshCa() // a fresh CA each time: the per-CA backoff cannot help here
      const nonce = `grind${i}`
      const offered = await r.agent.offer(offerFrom(ca, nonce))
      if (!offered.ok) {
        expect(offered).toMatchObject({ error: 'offer-budget' })
        expect(offered.retryAfterMs).toBeGreaterThan(0)
        continue
      }
      // The attacker commits correctly, reveals, reveals ...
      expect(r.agent.reveal({ pairingId: offered.answer.pairingId, hubNonce: nonce }).ok).toBe(true)
      codesSeen += 1
      // ... but the agent announces no code of its own before a local confirmation.
      expect(r.local.get(offered.answer.pairingId)?.code).toBeNull()
      // ... and aborts before anyone at the agent confirmed anything.
      const pin = r.local.get(offered.answer.pairingId)?.pin
      r.agent.reject({ pin }, REMOTE)
    }
    expect(codesSeen).toBe(3)
    expect(r.logs.some((l) => l.includes('locked'))).toBe(true)
    // Ten minutes on, the budget is back - and nothing else was.
    r.clock.now += 65 * 60_000
    expect((await r.agent.offer(offerFrom(await generateMeshCa(), 'later'))).ok).toBe(true)
  })

  it('the lockout grows, and lifts once it has passed', async () => {
    const r = await rig()
    for (let i = 0; i < 3; i++) {
      const offered = unwrap(await r.agent.offer(offerFrom(await generateMeshCa(), `a${i}`)))
      r.agent.reject(
        {
          pin: r.agent.localView().pending.find((p) => p.pairingId === offered.answer.pairingId)
            ?.pin,
        },
        REMOTE,
      )
    }
    const refused = await r.agent.offer(offerFrom(await generateMeshCa(), 'b'))
    expect(refused).toMatchObject({ ok: false, error: 'offer-budget' })
    r.clock.now += 5 * 60_000 + 1
    expect((await r.agent.offer(offerFrom(await generateMeshCa(), 'c'))).ok).toBe(true)
  })

  it('the same hub CA waits out its own backoff after a second abandonment, and is allowed again after', async () => {
    const r = await rig()
    const ca = await generateMeshCa()
    for (let i = 0; i < 2; i++) {
      const offered = unwrap(await r.agent.offer(offerFrom(ca, `same${i}`)))
      r.agent.reject(
        {
          pin: r.agent.localView().pending.find((p) => p.pairingId === offered.answer.pairingId)
            ?.pin,
        },
        REMOTE,
      )
    }
    expect(await r.agent.offer(offerFrom(ca, 'same-again'))).toMatchObject({
      ok: false,
      error: 'offer-backoff',
    })
    r.clock.now += 31_000
    expect((await r.agent.offer(offerFrom(ca, 'same-later'))).ok).toBe(true)
  })

  it('a pairing the local operator confirmed is not an abandonment', async () => {
    const r = await rig()
    for (let i = 0; i < 5; i++) {
      const started = await r.hub.begin(ENDPOINT)
      unwrap(r.agent.confirm({ pin: theLocal(r).pin, code: started.code }, REMOTE))
      await r.hub.reject(started.pairingId)
      r.clock.now += 1
    }
    expect(r.agent.state()).toBe('unpaired')
  })
})

describe('node ids (M5)', () => {
  it('the agent refuses to be paired under an id it may not carry', async () => {
    for (const nodeId of ['hub', 'HUB', 'a b', '-x', 'x'.repeat(64), 'a/b']) {
      const r = await rig({ agentNodeId: nodeId })
      const offered = await r.agent.offer({
        protocol: PAIRING_PROTOCOL,
        hubNodeId: 'hub',
        hubCaCertPem: r.ca.certPem,
        commitment: 'a'.repeat(64),
        hubUrl: 'https://hub.example.test',
        hubMeshAddress: 'hub.example.test:6443',
      })
      expect(offered, nodeId).toMatchObject({ ok: false, error: 'invalid-node-id' })
    }
  })

  it('the hub refuses an invalid id, and one that differs only in case from a node it knows', async () => {
    const r = await rig({ agentNodeId: 'Agent-A' })
    r.known.push('agent-a')
    await expect(r.hub.begin(ENDPOINT)).rejects.toThrow(/differs only in case/)
    const ok = await rig()
    ok.known.push(NODE_ID)
    expect((await ok.hub.begin(ENDPOINT)).state).toBe('awaiting-confirmation')
  })
})

describe('a public CA certificate is not enough to offer as the hub (N1)', () => {
  it("an offer that is not signed by the CA key never touches the real hub's pending pairing", async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    const forged = signedOffer(await generateMeshCa(), {
      commitment: 'b'.repeat(64),
      hubUrl: 'https://evil.example.test:4443',
      hubMeshAddress: 'evil.example.test:6443',
    })
    // The attacker presents the REAL hub's public certificate with a signature of its own key.
    const attack = { ...forged, hubCaCertPem: r.ca.certPem }
    expect(await r.agent.offer(attack)).toMatchObject({ ok: false, error: 'bad-offer-signature' })
    expect(await r.agent.offer({ ...attack, signature: 'x.y.z' })).toMatchObject({ ok: false })
    expect(r.agent.publicView().pending).toHaveLength(1)
    expect(r.agent.poll({ pairingId: started.pairingId }).ok).toBe(true)
    // And no abandonment was counted against the real hub.
    const done = await bothOperatorsConfirm(r, started.pairingId, 'hub-first')
    expect(done.state).toBe('paired')
  })

  it('a captured genuine offer cannot be replayed, used for another agent, or used when stale', async () => {
    const r = await rig()
    const ca = await generateMeshCa()
    const fields = {
      commitment: computePairingCommitment(ca.certPem, 'n'),
      hubUrl: 'https://hub.example.test:4443',
      hubMeshAddress: 'hub.example.test:6443',
    }
    expect((await r.agent.offer(signedOffer(ca, fields))).ok).toBe(true)
    expect(await r.agent.offer(signedOffer(ca, fields))).toMatchObject({ error: 'offer-replayed' })
    const other = await rig()
    expect(
      await other.agent.offer(signedOffer(ca, { ...fields, agentNodeId: 'someone-else' })),
    ).toMatchObject({ error: 'bad-offer-signature' })
    const stale = signedOffer(ca, {
      ...fields,
      commitment: computePairingCommitment(ca.certPem, 'm'),
      iat: other.clock.now - 10 * 60_000,
    })
    expect(await other.agent.offer(stale)).toMatchObject({ error: 'bad-offer-signature' })
  })
})

describe('wrong PINs are counted per source (N2)', () => {
  function offerFrom(ca: MeshCaSigner, label: string) {
    return signedOffer(ca, {
      commitment: computePairingCommitment(ca.certPem, label),
      hubUrl: `https://${label}.example.test:4443`,
      hubMeshAddress: `${label}.example.test:6443`,
    })
  }

  it('five wrong PINs lock THAT source only; loopback is never locked', async () => {
    const r = await rig()
    const started = await r.hub.begin(ENDPOINT)
    const pin = theLocal(r).pin
    const from = (source: string) => ({ local: false, source })
    for (let i = 0; i < 5; i++)
      r.agent.confirm({ code: started.code, pin: '11111111' }, from('10.0.0.1'))
    expect(r.agent.confirm({ code: started.code, pin }, from('10.0.0.1'))).toMatchObject({
      error: 'pin-locked',
    })
    // A different source is not locked by the first one's failures.
    expect(r.agent.confirm({ code: started.code, pin }, from('10.0.0.2')).ok).toBe(true)
    // The lock doubles on the next round.
    r.clock.now += 2 * 60_000 + 1
    for (let i = 0; i < 5; i++)
      r.agent.confirm({ code: started.code, pin: '11111111' }, from('10.0.0.1'))
    r.clock.now += 2 * 60_000 + 1
    expect(r.agent.confirm({ code: started.code, pin }, from('10.0.0.1'))).toMatchObject({
      error: 'pin-locked',
    })
    for (let i = 0; i < 20; i++)
      expect(r.agent.confirm({ code: started.code }, LOCAL).ok).toBe(true)
  })

  it('a flood of wrong PINs from many sources cancels the pending pairings (global ceiling)', async () => {
    const r = await rig()
    await r.hub.begin(ENDPOINT)
    for (let i = 0; i < 200; i++) {
      r.agent.confirm({ code: '000000', pin: '11111111' }, { local: false, source: `10.1.${i}.1` })
    }
    expect(r.agent.publicView().pending).toEqual([])
    expect(r.logs.some((l) => l.includes('every pending pairing is cancelled'))).toBe(true)
  })

  it('a PIN flood cancelling the board does not spend the abandon budget', async () => {
    const r = await rig()
    for (let i = 0; i < PAIRING_MAX_SESSIONS; i++) {
      unwrap(await r.agent.offer(offerFrom(await generateMeshCa(), `flood${i}`)))
    }
    for (let i = 0; i < 200; i++) {
      r.agent.confirm({ code: '000000', pin: '11111111' }, { local: false, source: `10.2.${i}.1` })
    }
    expect(r.agent.publicView().pending).toEqual([])
    expect((await r.agent.offer(offerFrom(await generateMeshCa(), 'real'))).ok).toBe(true)
  })
})

describe('a failed completion never revokes a leaf the agent may have installed (N9)', () => {
  async function failingComplete(options: { installFirst: boolean; pollThrows?: boolean }) {
    let broken = false
    const r = await rig({
      transport: (agent) => {
        const base = directTransport(agent)
        return {
          ...base,
          complete: async (e, body) => {
            if (options.installFirst) await base.complete(e, body)
            broken = true
            throw new PairingHttpError(502, 'bad-gateway', 'the reply got lost')
          },
          poll: async (e, id) => {
            if (broken && options.pollThrows === true) throw new Error('unreachable')
            return base.poll(e, id)
          },
        }
      },
    })
    const started = await r.hub.begin(ENDPOINT)
    unwrap(r.agent.confirm({ pin: theLocal(r).pin, code: started.code }, REMOTE))
    await r.hub.confirm(started.pairingId, started.code)
    return { r, view: await r.hub.advance(started.pairingId) }
  }

  it('the agent did install it: the pairing converges to paired and the leaf stays', async () => {
    const { r, view } = await failingComplete({ installFirst: true })
    expect(view.state).toBe('paired')
    expect(r.leafRevocations).toEqual([])
    expect(r.installed).toHaveLength(1)
  })

  it('the agent provably did not: only that leaf is revoked', async () => {
    const { r, view } = await failingComplete({ installFirst: false })
    expect(view.state).toBe('failed')
    expect(r.leafRevocations).toEqual(['pairing did not complete'])
    expect(r.revocations).toEqual([])
  })

  it('the agent cannot be reached: nothing is revoked and the failure says so', async () => {
    const { r, view } = await failingComplete({ installFirst: true, pollThrows: true })
    expect(view.state).toBe('failed')
    expect(r.leafRevocations).toEqual([])
    expect(r.revocations).toEqual([])
    expect(view.failure).toMatch(/could not be reached/)
  })
})

describe('the outcome of a pairing survives the end of the others (NEW-1)', () => {
  function otherOffer(ca: MeshCaSigner) {
    return signedOffer(ca, {
      commitment: computePairingCommitment(ca.certPem, 'other'),
      hubUrl: 'https://other.example.test:4443',
      hubMeshAddress: 'other.example.test:6443',
    })
  }

  it('the agent answers a poll by pairing id after completing, even though it ended other sessions', async () => {
    const r = await rig()
    unwrap(await r.agent.offer(otherOffer(await generateMeshCa())))
    const started = await r.hub.begin(ENDPOINT)
    const done = await bothOperatorsConfirm(r, started.pairingId, 'hub-first')
    expect(done.state).toBe('paired')
    expect(r.agent.publicView().pending).toEqual([])
    expect(unwrap(r.agent.poll({ pairingId: started.pairingId })).poll.last?.outcome).toBe(
      'completed',
    )
  })

  it('a lost reply with another hub pending still converges to paired and keeps the leaf', async () => {
    const r = await rig({
      transport: (agent) => {
        const base = directTransport(agent)
        return {
          ...base,
          complete: async (e, body) => {
            await base.complete(e, body)
            throw new PairingHttpError(502, 'bad-gateway', 'the reply got lost')
          },
        }
      },
    })
    unwrap(await r.agent.offer(otherOffer(await generateMeshCa())))
    const started = await r.hub.begin(ENDPOINT)
    unwrap(r.agent.confirm({ pin: theLocal(r, started.pairingId).pin, code: started.code }, REMOTE))
    await r.hub.confirm(started.pairingId, started.code)
    const view = await r.hub.advance(started.pairingId)
    expect(view.state).toBe('paired')
    expect(r.leafRevocations).toEqual([])
  })

  it('an agent that no longer knows the pairing proves nothing: nothing is revoked, "unconfirmed"', async () => {
    let broken = false
    const r = await rig({
      transport: (agent) => {
        const base = directTransport(agent)
        return {
          ...base,
          complete: async () => {
            broken = true
            throw new PairingHttpError(502, 'bad-gateway', 'lost')
          },
          poll: async (e, id) => {
            if (broken) throw new PairingHttpError(404, 'no-pairing', 'gone')
            return base.poll(e, id)
          },
        }
      },
    })
    const started = await r.hub.begin(ENDPOINT)
    unwrap(r.agent.confirm({ pin: theLocal(r).pin, code: started.code }, REMOTE))
    await r.hub.confirm(started.pairingId, started.code)
    const view = await r.hub.advance(started.pairingId)
    expect(view.failure).toMatch(/^unconfirmed/)
    expect(r.leafRevocations).toEqual([])
  })

  it('a leaf that shows up on the mesh is never revoked, whatever the poll said', async () => {
    let broken = false
    const r = await rig({
      leafPresented: () => true,
      transport: (agent) => {
        const base = directTransport(agent)
        return {
          ...base,
          complete: async () => {
            broken = true
            throw new PairingHttpError(502, 'bad-gateway', 'lost')
          },
          poll: async (e, id) => {
            if (broken) return { state: 'idle', localConfirmed: false, last: null }
            return base.poll(e, id)
          },
        }
      },
    })
    const started = await r.hub.begin(ENDPOINT)
    unwrap(r.agent.confirm({ pin: theLocal(r).pin, code: started.code }, REMOTE))
    await r.hub.confirm(started.pairingId, started.code)
    const view = await r.hub.advance(started.pairingId)
    expect(view.state).toBe('paired')
    expect(r.leafRevocations).toEqual([])
  })
})

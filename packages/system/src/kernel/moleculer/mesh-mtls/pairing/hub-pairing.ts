/**
 * The hub's side of pairing (D857): starts a pairing with an agent it found
 * (mDNS) or was given an address for, computes the same six digits the agent
 * shows, and signs the agent's certificate ONLY after the operator confirmed
 * them on the hub AND the agent's own operator confirmed them there.
 *
 * Either confirmation may come first. The hub learns the agent's by polling the
 * agent's pairing status (`advance`), never by being told: nothing the agent
 * says is trusted beyond "my operator confirmed", and even that only matters
 * together with the hub's own confirmation.
 *
 * Transport-agnostic: `AgentPairingTransport` is the HTTP client in production
 * and an in-memory shim (or a man in the middle) in specs.
 */
import { caFingerprintCompact, issueMeshLeafFromCsr, type MeshCaSigner } from '../mesh-ca.js'
import type { AgentHello, AgentPairingPoll, OfferAnswer, OfferRequest } from './agent-pairing.js'
import {
  computePairingCommitment,
  computePairingSas,
  constantTimeEqual,
  describeCsr,
  isValidAgentNodeId,
  leafFingerprintCompact,
  PAIRING_PROOF_MAX_LIFETIME_MS,
  PAIRING_MAX_CODE_ATTEMPTS,
  PAIRING_OFFER_USE,
  PAIRING_PROTOCOL,
  PAIRING_PROOF_USE,
  PAIRING_TTL_MS,
  randomHex,
  signPairingOffer,
  signPairingProof,
} from './pairing-protocol.js'

/** Where an agent's API is. */
export interface AgentEndpoint {
  readonly host: string
  readonly port: number
}

/** A refusal the agent sent, kept with its machine-readable code. */
export class PairingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PairingHttpError'
  }
}

/** The agent's pairing HTTP surface, as the hub calls it. Throws {@link PairingHttpError}. */
export interface AgentPairingTransport {
  hello(endpoint: AgentEndpoint): Promise<AgentHello>
  offer(endpoint: AgentEndpoint, body: OfferRequest): Promise<OfferAnswer>
  reveal(endpoint: AgentEndpoint, body: { pairingId: string; hubNonce: string }): Promise<void>
  /** Did the agent's operator confirm? Authorized by the pairing id. */
  poll(endpoint: AgentEndpoint, pairingId: string): Promise<AgentPairingPoll>
  complete(
    endpoint: AgentEndpoint,
    body: { pairingId: string; leafPem: string; caCertPem: string; proof: string },
  ): Promise<void>
  reject(endpoint: AgentEndpoint, pairingId: string): Promise<void>
}

export type HubPairingState =
  | 'awaiting-confirmation'
  | 'completing'
  | 'paired'
  | 'rejected'
  | 'expired'
  | 'failed'

export interface HubPairingView {
  readonly pairingId: string
  readonly nodeId: string
  readonly endpoint: AgentEndpoint
  /** The six digits the agent's page shows. The operator types them on the hub to confirm. */
  readonly code: string
  readonly state: HubPairingState
  readonly hubConfirmed: boolean
  readonly agentConfirmed: boolean
  readonly expiresAt: number
  readonly failure: string | null
}

export interface HubPairingDeps {
  readonly transport: AgentPairingTransport
  /** The mesh CA, `null` while it is not ready. */
  readonly ca: () => MeshCaSigner | null
  readonly hubNodeId: string
  readonly hubUrl: () => Promise<string>
  readonly hubMeshAddress: () => Promise<string>
  /** True when `nodeId` is connected to the mesh with a verified certificate. */
  readonly isNodeConnected: (nodeId: string) => boolean
  /** Node ids the hub already knows (certificates issued, nodes seen), for the case-insensitive collision check. */
  readonly knownNodeIds?: () => readonly string[]
  /** Record a leaf this hub just issued (the certificate registry). */
  readonly recordIssued: (nodeId: string, certPem: string) => Promise<void>
  /**
   * Put the leaves of `nodeId` on the CRL: a node id is held by one device. With `keepCertPem`, every
   * leaf EXCEPT that one - the previous leaves go only after the new pairing completed.
   */
  readonly revokeNode: (nodeId: string, reason: string, keepCertPem?: string) => Promise<void>
  /** Revoke ONE leaf (it was never presented): used when the agent provably did not install it. */
  /** True when the node's live mesh connection presents exactly this leaf (registry convergence). */
  readonly isLeafPresented?: (nodeId: string, certPem: string) => boolean
  readonly revokeLeaf?: (nodeId: string, certPem: string, reason: string) => Promise<void>
  readonly now?: () => number
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
}

interface Session {
  readonly pairingId: string
  readonly nodeId: string
  readonly endpoint: AgentEndpoint
  readonly code: string
  readonly csrPem: string
  readonly hubNonce: string
  readonly agentNonce: string
  readonly caCertPem: string
  readonly hubUrl: string
  readonly hubMeshAddress: string
  readonly expiresAt: number
  state: HubPairingState
  hubConfirmed: boolean
  agentConfirmed: boolean
  attempts: number
  failure: string | null
  issued: boolean
}

/** Pairings kept (active and just ended) so the page can show how one ended. */
const MAX_SESSIONS = 16
const PROOF_TTL_MS = Math.min(2 * 60_000, PAIRING_PROOF_MAX_LIFETIME_MS)
const TERMINAL: ReadonlySet<HubPairingState> = new Set(['paired', 'rejected', 'expired', 'failed'])

export class HubPairing {
  private readonly sessions = new Map<string, Session>()
  private readonly now: () => number

  constructor(private readonly deps: HubPairingDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Offer the hub's CA to the agent at `endpoint` and derive the code. Throws an `Error` with the reason. */
  async begin(endpoint: AgentEndpoint): Promise<HubPairingView> {
    const ca = this.deps.ca()
    if (ca === null) throw new Error('the mesh CA is not ready — try again in a moment')
    const hello = await this.deps.transport.hello(endpoint)
    if (hello.protocol !== PAIRING_PROTOCOL) {
      throw new Error(
        `the agent speaks pairing protocol ${String(hello.protocol)}, not ${PAIRING_PROTOCOL}`,
      )
    }
    if (hello.state === 'paired') {
      throw new Error(`"${hello.nodeId}" is already paired — unpair it first`)
    }
    // A pending agent may hold several hubs' offers (one per CA): the agent decides.
    this.assertNodeIdUsable(hello.nodeId)
    for (const s of this.sessions.values()) {
      if (s.nodeId === hello.nodeId && !TERMINAL.has(s.state)) {
        throw new Error(`a pairing with "${hello.nodeId}" is already in progress`)
      }
    }

    const hubNonce = randomHex(32)
    const hubUrl = await this.deps.hubUrl()
    const hubMeshAddress = await this.deps.hubMeshAddress()
    const commitment = computePairingCommitment(ca.certPem, hubNonce)
    const answer = await this.deps.transport.offer(endpoint, {
      protocol: PAIRING_PROTOCOL,
      hubNodeId: this.deps.hubNodeId,
      hubCaCertPem: ca.certPem,
      commitment,
      hubUrl,
      hubMeshAddress,
      // Signed with the CA KEY: the certificate alone is public, so only this hub can offer as itself.
      signature: signPairingOffer(ca.keyPem, {
        use: PAIRING_OFFER_USE,
        agentNodeId: hello.nodeId,
        hubNodeId: this.deps.hubNodeId,
        caFingerprint: caFingerprintCompact(ca.certPem),
        commitment,
        hubUrl,
        hubMeshAddress,
        iat: this.now(),
      }),
    })
    try {
      const csr = await describeCsr(answer.csrPem)
      if (csr.commonName !== hello.nodeId) {
        throw new Error(`the agent's CSR is for "${csr.commonName}", not "${hello.nodeId}"`)
      }
      await this.deps.transport.reveal(endpoint, { pairingId: answer.pairingId, hubNonce })
      const code = computePairingSas({
        caCertPem: ca.certPem,
        agentPublicKeySpki: csr.publicKeySpki,
        hubNonce,
        agentNonce: answer.agentNonce,
      })
      const session: Session = {
        pairingId: answer.pairingId,
        nodeId: hello.nodeId,
        endpoint,
        code,
        csrPem: answer.csrPem,
        hubNonce,
        agentNonce: answer.agentNonce,
        caCertPem: ca.certPem,
        hubUrl,
        hubMeshAddress,
        expiresAt: Math.min(answer.expiresAt, this.now() + PAIRING_TTL_MS),
        state: 'awaiting-confirmation',
        hubConfirmed: false,
        agentConfirmed: false,
        attempts: 0,
        failure: null,
        issued: false,
      }
      this.remember(session)
      this.deps.log?.('pairing started', { nodeId: session.nodeId, pairingId: session.pairingId })
      return this.view(session)
    } catch (err) {
      await this.deps.transport.reject(endpoint, answer.pairingId).catch(() => undefined)
      throw err
    }
  }

  /** The operator typed the code the AGENT shows. A wrong one counts; the third cancels the pairing. */
  async confirm(pairingId: string, code: string): Promise<HubPairingView> {
    const session = this.require(pairingId)
    this.expireIfDue(session)
    if (TERMINAL.has(session.state)) return this.view(session)
    if (!constantTimeEqual(session.code, typeof code === 'string' ? code.trim() : code)) {
      session.attempts += 1
      if (session.attempts >= PAIRING_MAX_CODE_ATTEMPTS) {
        await this.cancel(session, 'rejected', 'wrong code three times')
      }
      throw new Error(
        session.attempts >= PAIRING_MAX_CODE_ATTEMPTS
          ? 'wrong code three times — the pairing was cancelled'
          : 'that is not the code the hub computed — if the agent shows a different one, someone is between them; cancel it',
      )
    }
    session.hubConfirmed = true
    return this.advance(pairingId)
  }

  async reject(pairingId: string): Promise<HubPairingView> {
    const session = this.require(pairingId)
    if (!TERMINAL.has(session.state)) await this.cancel(session, 'rejected', 'rejected on the hub')
    return this.view(session)
  }

  get(pairingId: string): HubPairingView | undefined {
    const session = this.sessions.get(pairingId)
    return session === undefined ? undefined : this.view(session)
  }

  list(): readonly HubPairingView[] {
    return [...this.sessions.values()].map((s) => this.view(s))
  }

  /** Active pairings, for the poller. */
  activeIds(): readonly string[] {
    return [...this.sessions.values()].filter((s) => !TERMINAL.has(s.state)).map((s) => s.pairingId)
  }

  /**
   * Move a pairing on: notice an expiry, a cancellation or the agent's
   * confirmation, and complete when both sides confirmed. Never throws.
   */
  async advance(pairingId: string): Promise<HubPairingView> {
    const session = this.require(pairingId)
    if (TERMINAL.has(session.state) || session.state === 'completing') return this.view(session)
    if (this.expireIfDue(session)) {
      await this.deps.transport.reject(session.endpoint, session.pairingId).catch(() => undefined)
      return this.view(session)
    }
    try {
      const poll = await this.deps.transport.poll(session.endpoint, session.pairingId)
      if (poll.state === 'pending') {
        session.agentConfirmed = poll.localConfirmed
      } else if (poll.last?.pairingId === session.pairingId && poll.last.outcome === 'completed') {
        this.finish(session, 'paired', null)
        return this.view(session)
      } else {
        const why = poll.last?.pairingId === session.pairingId ? poll.last.outcome : 'gone'
        this.finish(session, 'failed', `the agent ended the pairing (${why})`)
        return this.view(session)
      }
    } catch (err) {
      if (err instanceof PairingHttpError && err.code === 'no-pairing') {
        this.finish(session, 'failed', 'the agent no longer has this pairing')
        return this.view(session)
      }
      // Unreachable for now: unknown is not cancelled. The expiry bounds the wait.
      this.deps.log?.('pairing status poll failed', {
        nodeId: session.nodeId,
        error: err instanceof Error ? err.message : String(err),
      })
      return this.view(session)
    }
    if (session.hubConfirmed && session.agentConfirmed) await this.complete(session)
    return this.view(session)
  }

  // ── internals ────────────────────────────────────────────────────────

  private async complete(session: Session): Promise<void> {
    const ca = this.deps.ca()
    if (
      ca === null ||
      caFingerprintCompact(ca.certPem) !== caFingerprintCompact(session.caCertPem)
    ) {
      await this.cancel(session, 'failed', 'the mesh CA changed during the pairing')
      return
    }
    session.state = 'completing'
    let issuedPem: string | null = null
    try {
      const leaf = await issueMeshLeafFromCsr(ca, session.csrPem, {
        expectedNodeId: session.nodeId,
      })
      issuedPem = leaf.certPem
      await this.deps.recordIssued(session.nodeId, leaf.certPem)
      session.issued = true
      const proof = signPairingProof(ca.keyPem, {
        v: PAIRING_PROTOCOL,
        use: PAIRING_PROOF_USE,
        pairingId: session.pairingId,
        nodeId: session.nodeId,
        hubNonce: session.hubNonce,
        agentNonce: session.agentNonce,
        leafFingerprint: leafFingerprintCompact(leaf.certPem),
        caFingerprint: caFingerprintCompact(ca.certPem),
        hubMeshAddress: session.hubMeshAddress,
        hubUrl: session.hubUrl,
        iat: this.now(),
        exp: this.now() + PROOF_TTL_MS,
      })
      await this.deps.transport.complete(session.endpoint, {
        pairingId: session.pairingId,
        leafPem: leaf.certPem,
        caCertPem: ca.certPem,
        proof,
      })
      await this.installed(session, leaf.certPem)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      if (err instanceof PairingHttpError && err.code === 'awaiting-local-confirmation') {
        // The agent's operator withdrew nothing; the agent just has not confirmed yet.
        session.state = 'awaiting-confirmation'
        session.agentConfirmed = false
        return
      }
      // The agent may have installed the certificate even though the call failed. Only a leaf
      // that provably was NOT installed is revoked; an unknown outcome leaves it valid.
      let outcome = issuedPem === null ? 'absent' : await this.installOutcome(session)
      if (
        outcome !== 'installed' &&
        issuedPem !== null &&
        this.deps.isLeafPresented?.(session.nodeId, issuedPem) === true
      ) {
        outcome = 'installed'
      }
      if (outcome === 'installed' && issuedPem !== null) {
        await this.installed(session, issuedPem)
        return
      }
      if (outcome === 'absent' && issuedPem !== null) {
        await this.deps
          .revokeLeaf?.(session.nodeId, issuedPem, 'pairing did not complete')
          .catch(() => undefined)
      }
      const note =
        outcome === 'unknown'
          ? `unconfirmed: ${reason} - the agent could not be reached to learn whether it installed the certificate; unpair it if it shows as paired`
          : reason
      await this.cancel(session, 'failed', note)
    }
  }

  /** The new leaf is installed: older leaves of the node go, the new one stays. */
  private async installed(session: Session, leafPem: string): Promise<void> {
    await this.deps
      .revokeNode(session.nodeId, 'superseded by pairing', leafPem)
      .catch((err: unknown) =>
        this.deps.log?.('older leaves of the node could not be revoked', {
          nodeId: session.nodeId,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    this.finish(session, 'paired', null)
    this.deps.log?.('agent paired', { nodeId: session.nodeId, pairingId: session.pairingId })
  }

  /** After a failed completion call: did the agent install the certificate after all? */
  private async installOutcome(session: Session): Promise<'installed' | 'absent' | 'unknown'> {
    try {
      const poll = await this.deps.transport.poll(session.endpoint, session.pairingId)
      if (poll.last?.pairingId === session.pairingId && poll.last.outcome === 'completed') {
        return 'installed'
      }
      return 'absent'
    } catch (err) {
      // The agent no longer knows the pairing: that proves nothing about the leaf.
      return 'unknown'
    }
  }

  private assertNodeIdUsable(nodeId: string): void {
    if (!isValidAgentNodeId(nodeId)) {
      throw new Error(
        `"${nodeId}" cannot be an agent node id (letters, digits, . _ - ; not "hub"; at most 63 characters)`,
      )
    }
    if (this.deps.isNodeConnected(nodeId)) {
      throw new Error(
        `a node called "${nodeId}" is already connected to this hub — unpair it first`,
      )
    }
    const lower = nodeId.toLowerCase()
    const clash = (this.deps.knownNodeIds?.() ?? []).find(
      (known) => known !== nodeId && known.toLowerCase() === lower,
    )
    if (clash !== undefined) {
      throw new Error(`"${nodeId}" differs only in case from the existing node "${clash}"`)
    }
  }

  private expireIfDue(session: Session): boolean {
    if (TERMINAL.has(session.state) || session.expiresAt > this.now()) return false
    this.finish(session, 'expired', 'the pairing was not confirmed on both sides in time')
    return true
  }

  private finish(session: Session, state: HubPairingState, failure: string | null): void {
    session.state = state
    session.failure = failure
  }

  private async cancel(session: Session, state: HubPairingState, reason: string): Promise<void> {
    this.finish(session, state, reason)
    await this.deps.transport.reject(session.endpoint, session.pairingId).catch(() => undefined)
    this.deps.log?.('pairing cancelled', { nodeId: session.nodeId, state, reason })
  }

  private require(pairingId: string): Session {
    const session = this.sessions.get(pairingId)
    if (session === undefined) throw new Error('no such pairing')
    return session
  }

  private remember(session: Session): void {
    this.sessions.set(session.pairingId, session)
    if (this.sessions.size <= MAX_SESSIONS) return
    for (const [id, s] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS) break
      if (TERMINAL.has(s.state)) this.sessions.delete(id)
    }
  }

  private view(s: Session): HubPairingView {
    return {
      pairingId: s.pairingId,
      nodeId: s.nodeId,
      endpoint: s.endpoint,
      code: s.code,
      state: s.state,
      hubConfirmed: s.hubConfirmed,
      agentConfirmed: s.agentConfirmed,
      expiresAt: s.expiresAt,
      failure: s.failure,
    }
  }
}

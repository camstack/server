/**
 * The agent's side of pairing (D857): up to four pending pairings (one per hub CA), their keys
 * in memory only, installed ONLY after the agent's own operator confirmed the same six digits
 * the hub shows AND proved presence at this agent with a one-time local PIN, and the hub's
 * transcript proof verified under the CA the agent was offered.
 *
 * Why a PIN: the agent's page is opened from another PC and its API is reachable by the whole
 * LAN. Anything the network can read, the network can use to "confirm" - so the code, the pairing
 * id and the PIN are shown ONLY on the agent's own machine (its console, a 0600 file, the local
 * window). A request that is not genuinely local must present the PIN of the pairing it confirms.
 *
 *   unpaired ──offer──▶ pending ──reveal──▶ (code known) ──confirm(code + PIN) + complete──▶ paired
 *                          │                                       │
 *                          └── reject / expiry / 3 wrong codes / 3 wrong PINs ──▶ unpaired
 *
 * Offers are rationed: pairings that ended without the local operator confirming them count
 * against a budget (3 per 10 minutes, then exponential lockout) and against the hub CA that made
 * them (so a loop of "offer, read the code, abort" cannot grind the six digits). A paired agent
 * refuses every offer.
 */
import { createPrivateKey, webcrypto, X509Certificate } from 'node:crypto'
import {
  caFingerprintCompact,
  createMeshCsrPem,
  exportMeshPrivateKeyPem,
  generateMeshKeyPair,
  subjectCn,
} from '../mesh-ca.js'
import {
  commitmentsEqual,
  computePairingCommitment,
  computePairingSas,
  constantTimeEqual,
  isValidAgentNodeId,
  leafFingerprintCompact,
  newPairingId,
  PAIRING_MAX_CODE_ATTEMPTS,
  PAIRING_MAX_SESSIONS,
  PAIRING_OFFER_MAX_AGE_MS,
  PAIRING_OFFER_USE,
  PAIRING_PROOF_MAX_LIFETIME_MS,
  PAIRING_PROTOCOL,
  PAIRING_TTL_MS,
  randomHex,
  randomPin,
  verifyPairingOffer,
  verifyPairingProof,
  type AgentPairingState,
} from './pairing-protocol.js'

/** What the agent persists when a pairing completes. */
export interface InstalledPairing {
  readonly meshTls: {
    readonly certPem: string
    readonly keyPem: string
    readonly caCertPem: string
  }
  /** Host the broker dials (no port: the TLS port is the cluster default). */
  readonly hubAddress: string
  readonly hubUrl: string
}

/** What the agent's own machine is told, and nobody else (console, 0600 file, local window). */
export interface LocalPairingSecret {
  readonly pairingId: string
  readonly pin: string
  /** The agent's own six digits, only once its operator confirmed locally; `null` before that. */
  readonly code: string | null
  readonly hub: { readonly nodeId: string; readonly url: string; readonly caFingerprint: string }
  readonly expiresAt: number
}

export interface AgentPairingDeps {
  readonly nodeId: string
  readonly version: string | null
  /** True when `agent.json` already holds mesh material. */
  readonly isPaired: () => boolean
  /** Persist the material and reconnect. A throw cancels the pairing. */
  readonly install: (pairing: InstalledPairing) => Promise<void>
  readonly now?: () => number
  readonly log?: (message: string, meta?: Record<string, unknown>) => void
  /** The pairing state may have changed (pending <-> unpaired): re-announce it. */
  readonly onStateChange?: () => void
  /**
   * A pairing needs the operator's eyes on THIS machine: print the PIN to the console, write it to
   * a 0600 file, show it in the local window. Called at the offer (code `null`) and again after the
   * local confirmation, which adds the agent's own code.
   */
  readonly onLocalSecret?: (secret: LocalPairingSecret) => void
  /** The pairing ended: remove what `onLocalSecret` wrote. */
  readonly onLocalSecretCleared?: (pairingId: string) => void
  /**
   * The LOCAL RESET CODE: print it to the console and a 0600 file. It clears the offer lockouts and
   * the pending offers (a stranger who filled the slots with throwaway CAs would otherwise block
   * pairing). Called at construction and again each time it is used.
   */
  readonly onResetCode?: (code: string) => void
}

export type PairingFailure = {
  readonly ok: false
  readonly status: number
  readonly error: string
  readonly message: string
  /** Set on a rationed offer: how long until it may be tried again. */
  readonly retryAfterMs?: number
}

export type PairingResult<T> = ({ readonly ok: true } & T) | PairingFailure

/** What an unauthenticated `hello` says. */
export interface AgentHello {
  /** The pairing protocol version the agent speaks; the hub compares it. */
  readonly protocol: number
  readonly nodeId: string
  readonly version: string | null
  readonly state: AgentPairingState
  readonly pendingExpiresAt: number | null
}

export interface OfferRequest {
  readonly protocol: number
  readonly hubNodeId: string
  readonly hubCaCertPem: string
  readonly commitment: string
  readonly hubUrl: string
  readonly hubMeshAddress: string
  /** The offer, signed with the hub CA's KEY: a public CA certificate alone cannot make one. */
  readonly signature: string
}

export interface OfferAnswer {
  readonly pairingId: string
  readonly csrPem: string
  readonly agentNonce: string
  readonly expiresAt: number
}

export type PairingOutcome = 'completed' | 'rejected' | 'expired' | 'code-mismatch' | 'failed'

/** Who is asking, as the HTTP layer decided it (genuine loopback, no forwarding header). */
export interface PairingRequestContext {
  readonly local: boolean
  /** The caller's address, for per-source throttling of wrong PINs / reset codes. */
  readonly source?: string
}

/** One pending pairing as the NETWORK may see it: who asks, never a secret. */
export interface PendingPairingPublic {
  readonly hub: { readonly nodeId: string; readonly url: string; readonly caFingerprint: string }
  readonly expiresAt: number
}

/** What anyone on the network may read from `status`. */
export interface AgentPairingPublicView {
  readonly state: AgentPairingState
  readonly pending: readonly PendingPairingPublic[]
}

/** The local view: the same, plus what only the agent's own machine may see. */
export interface AgentPairingLocalView extends AgentPairingPublicView {
  /** Some pairing lockout is in force (offer budget, per-hub backoff, wrong-PIN lock): the reset would change something. */
  readonly lockedOut: boolean
  readonly pending: readonly (PendingPairingPublic & {
    readonly pairingId: string
    readonly pin: string
    readonly code: string | null
    readonly localConfirmed: boolean
  })[]
}

/** What the hub learns by polling with the pairing id it was given. */
export interface AgentPairingPoll {
  /** `pending` while the pairing lives, `idle` once it ended. */
  readonly state: 'pending' | 'idle'
  readonly localConfirmed: boolean
  readonly last: { readonly pairingId: string; readonly outcome: PairingOutcome } | null
}

interface Session {
  readonly pairingId: string
  readonly hub: {
    readonly nodeId: string
    readonly caCertPem: string
    readonly caFingerprint: string
    readonly commitment: string
    readonly url: string
    readonly meshAddress: string
  }
  readonly keyPem: string
  readonly csrPem: string
  /** SPKI DER of the agent's mesh public key, base64 — what the code binds. */
  readonly publicKeySpki: string
  readonly agentNonce: string
  readonly pin: string
  readonly expiresAt: number
  hubNonce: string | null
  code: string | null
  localConfirmed: boolean
  attempts: number
  /** The hub revealed or polled: it is alive, so it is not the first to make room. */
  touched: boolean
  readonly createdAt: number
}

/** Abandoned offers allowed in {@link BUDGET_WINDOW_MS} before the lockout starts. */
const BUDGET_OFFERS = 3
const BUDGET_WINDOW_MS = 10 * 60_000
const LOCKOUT_BASE_MS = 5 * 60_000
const LOCKOUT_MAX_MS = 60 * 60_000
/** Per hub CA: nothing for the first abandonment, then this x 2^(n-2), capped. */
const CA_BACKOFF_BASE_MS = 30_000
const CA_BACKOFF_MAX_MS = 10 * 60_000
/** Wrong PINs (any session) before confirming is locked for a while. */
const PIN_FAILURE_LIMIT = 5
const PIN_LOCK_MS = 2 * 60_000
const PIN_LOCK_MAX_MS = 60 * 60_000
/** Wrong PINs across ALL sources within one pairing lifetime before every pending pairing is cancelled. */
const PIN_GLOBAL_CEILING = 200
const MAX_TRACKED_SOURCES = 256
/** Outcomes kept by pairing id so the hub can learn how its pairing ended. */
const OUTCOME_LIMIT = 16
const OUTCOME_TTL_MS = 15 * 60_000
const MAX_FIELD = 2048

function fail(
  status: number,
  error: string,
  message: string,
  retryAfterMs?: number,
): PairingFailure {
  return {
    ok: false,
    status,
    error,
    message,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  }
}

function isText(value: unknown, max = MAX_FIELD): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Clock skew tolerated between the hub that minted a CA and this agent. X.509 dates have
 * one-second resolution and a fresh CA's notBefore is the hub's "now", so an agent whose clock
 * is even a moment behind would otherwise refuse a brand-new CA. Same bound as the offer `iat`.
 */
const CA_CLOCK_SKEW_MS = 60_000

/** The hub CA must be a self-signed CA certificate, valid now (give or take the skew). */
function readCaCertificate(pem: string, nowMs: number): X509Certificate | null {
  try {
    const cert = new X509Certificate(pem)
    if (!cert.ca || !cert.verify(cert.publicKey)) return null
    if (Date.parse(cert.validTo) <= nowMs || Date.parse(cert.validFrom) > nowMs + CA_CLOCK_SKEW_MS)
      return null
    return cert
  } catch {
    return null
  }
}

/** `host:6443` / `[::1]:6443` / `host` → the host, port dropped. */
export function hubHostFromMeshAddress(address: string): string {
  const trimmed = address.trim()
  const bracketed = /^(\[[^\]]+\])(?::\d+)?$/.exec(trimmed)
  if (bracketed?.[1] !== undefined) return bracketed[1]
  const hostPort = /^([^:]+):\d+$/.exec(trimmed)
  return hostPort?.[1] ?? trimmed
}

export class AgentPairing {
  private readonly sessions = new Map<string, Session>()
  /** Outcome of each recent pairing BY id (bounded): ending others never overwrites an answer. */
  private readonly outcomes = new Map<string, { outcome: PairingOutcome; at: number }>()
  /** When pairings that never reached local confirmation ended. */
  private abandoned: number[] = []
  private lockedUntil = 0
  private readonly perCa = new Map<string, { count: number; until: number }>()
  private readonly pinBySource = new Map<
    string,
    { failures: number[]; strikes: number; lockedUntil: number }
  >()
  private globalPinFailures: number[] = []
  private resetCode: string
  /** Commitments already offered (signed offers are single use) until their signature is stale. */
  private readonly seenCommitments = new Map<string, number>()
  private readonly now: () => number

  constructor(private readonly deps: AgentPairingDeps) {
    this.now = deps.now ?? Date.now
    this.resetCode = randomPin()
    deps.onResetCode?.(this.resetCode)
  }

  // ── What anyone on the network may ask ───────────────────────────────

  hello(): AgentHello {
    this.expireIfDue()
    const expiries = [...this.sessions.values()].map((s) => s.expiresAt)
    return {
      protocol: PAIRING_PROTOCOL,
      nodeId: this.deps.nodeId,
      version: this.deps.version,
      state: this.state(),
      pendingExpiresAt: expiries.length === 0 ? null : Math.min(...expiries),
    }
  }

  state(): AgentPairingState {
    this.expireIfDue()
    if (this.deps.isPaired()) return 'paired'
    return this.sessions.size > 0 ? 'pending' : 'unpaired'
  }

  /** Who is asking to pair, and until when. No code, no pairing id, no PIN. */
  publicView(): AgentPairingPublicView {
    this.expireIfDue()
    return {
      state: this.state(),
      pending: [...this.sessions.values()].map((s) => ({
        hub: {
          nodeId: s.hub.nodeId,
          url: s.hub.url,
          caFingerprint: s.hub.caFingerprint,
        },
        expiresAt: s.expiresAt,
      })),
    }
  }

  /** The view for the agent's own machine: also the pairing ids, the codes and the PINs. */
  localView(): AgentPairingLocalView {
    this.expireIfDue()
    return {
      state: this.state(),
      lockedOut: this.isLockedOut(),
      pending: [...this.sessions.values()].map((s) => ({
        pairingId: s.pairingId,
        hub: {
          nodeId: s.hub.nodeId,
          url: s.hub.url,
          caFingerprint: s.hub.caFingerprint,
        },
        expiresAt: s.expiresAt,
        pin: s.pin,
        // The agent's own code is shown only AFTER its operator confirmed here (D857): before that
        // it could be copied into this agent's own field, and the hub-side check would be degenerate.
        code: s.localConfirmed ? s.code : null,
        localConfirmed: s.localConfirmed,
      })),
    }
  }

  // ── The hub's calls (authorized by the pairing id the agent made up) ──

  async offer(body: unknown): Promise<PairingResult<{ answer: OfferAnswer }>> {
    this.expireIfDue()
    if (this.deps.isPaired()) {
      return fail(
        409,
        'already-paired',
        'this agent is paired — unpair it first (from the hub or here)',
      )
    }
    if (!isValidAgentNodeId(this.deps.nodeId)) {
      return fail(
        409,
        'invalid-node-id',
        `this agent's node id "${this.deps.nodeId}" cannot be paired - rename the agent`,
      )
    }
    const request = parseOffer(body)
    if (request === null) return fail(400, 'bad-offer', 'the offer is malformed')
    if (request.protocol !== PAIRING_PROTOCOL) {
      return fail(
        400,
        'unsupported-protocol',
        `pairing protocol ${String(request.protocol)} is not supported`,
      )
    }
    const ca = readCaCertificate(request.hubCaCertPem, this.now())
    if (ca === null)
      return fail(400, 'bad-ca', 'the offered CA is not a valid self-signed CA certificate')
    if (!/^[0-9a-f]{64}$/.test(request.commitment)) {
      return fail(400, 'bad-offer', 'the commitment is malformed')
    }
    if (!isHttpUrl(request.hubUrl)) return fail(400, 'bad-offer', 'hubUrl is not an http(s) URL')

    const caFingerprint = caFingerprintCompact(request.hubCaCertPem)
    // An offer must be SIGNED by the CA key: the CA certificate is public, so without this anyone
    // could replace the real hub's pending pairing. An unsigned or invalid offer touches nothing.
    const refused = this.checkOfferSignature(request, caFingerprint)
    if (refused !== null) return refused
    const rationed = this.rationOffer(caFingerprint)
    if (rationed !== null) return rationed
    // The same hub offering again replaces its own pending pairing (an abandonment, counted).
    for (const existing of [...this.sessions.values()]) {
      if (existing.hub.caFingerprint === caFingerprint) this.end(existing, 'failed')
    }
    if (this.sessions.size >= PAIRING_MAX_SESSIONS && !this.makeRoom()) {
      return fail(409, 'too-many-pending', 'too many pairings are pending on this agent')
    }

    const keys = await generateMeshKeyPair()
    const csrPem = await createMeshCsrPem(keys, this.deps.nodeId)
    const keyPem = await exportMeshPrivateKeyPem(keys.privateKey)
    const publicKeySpki = Buffer.from(
      await webcrypto.subtle.exportKey('spki', keys.publicKey),
    ).toString('base64')
    // Re-check after the awaits: another offer may have raced this one.
    if (this.sessions.size >= PAIRING_MAX_SESSIONS && !this.makeRoom()) {
      return fail(409, 'too-many-pending', 'too many pairings are pending on this agent')
    }
    const session: Session = {
      pairingId: newPairingId(),
      hub: {
        nodeId: request.hubNodeId,
        caCertPem: request.hubCaCertPem,
        caFingerprint,
        commitment: request.commitment,
        url: request.hubUrl,
        meshAddress: request.hubMeshAddress,
      },
      keyPem,
      csrPem,
      publicKeySpki,
      agentNonce: randomHex(32),
      pin: randomPin(),
      expiresAt: this.now() + PAIRING_TTL_MS,
      hubNonce: null,
      code: null,
      localConfirmed: false,
      attempts: 0,
      touched: false,
      createdAt: this.now(),
    }
    this.sessions.set(session.pairingId, session)
    this.deps.onStateChange?.()
    this.announceLocally(session)
    this.deps.log?.('pairing requested by a hub', {
      hubUrl: session.hub.url,
      caFingerprint: session.hub.caFingerprint,
    })
    return {
      ok: true,
      answer: {
        pairingId: session.pairingId,
        csrPem,
        agentNonce: session.agentNonce,
        expiresAt: session.expiresAt,
      },
    }
  }

  /** The hub reveals its nonce; the agent checks it against the commitment and derives the code. */
  reveal(body: unknown): PairingResult<object> {
    const session = this.pending(body)
    if ('ok' in session) return session
    const hubNonce = field(body, 'hubNonce')
    if (!isText(hubNonce, 256)) return fail(400, 'bad-reveal', 'hubNonce is missing')
    if (session.hubNonce !== null)
      return fail(409, 'already-revealed', 'the nonce was already revealed')
    const expected = computePairingCommitment(session.hub.caCertPem, hubNonce)
    if (!commitmentsEqual(expected, session.hub.commitment)) {
      this.end(session, 'failed')
      return fail(
        400,
        'commitment-mismatch',
        'the revealed nonce does not match the hub commitment',
      )
    }
    session.touched = true
    session.hubNonce = hubNonce
    session.code = computePairingSas({
      caCertPem: session.hub.caCertPem,
      agentPublicKeySpki: session.publicKeySpki,
      hubNonce,
      agentNonce: session.agentNonce,
    })
    this.announceLocally(session)
    return { ok: true }
  }

  /** The hub polls with the pairing id: did the agent's operator confirm, did it end? */
  poll(body: unknown): PairingResult<{ poll: AgentPairingPoll }> {
    this.expireIfDue()
    const pairingId = field(body, 'pairingId')
    const session = typeof pairingId === 'string' ? this.sessions.get(pairingId) : undefined
    if (session !== undefined) {
      session.touched = true
      return {
        ok: true,
        poll: { state: 'pending', localConfirmed: session.localConfirmed, last: null },
      }
    }
    const known = typeof pairingId === 'string' ? this.outcomeOf(pairingId) : null
    if (typeof pairingId === 'string' && known !== null) {
      return {
        ok: true,
        poll: {
          state: 'idle',
          localConfirmed: false,
          last: { pairingId, outcome: known },
        },
      }
    }
    return fail(404, 'no-pairing', 'no such pairing is pending')
  }

  // ── The local operator ───────────────────────────────────────────────

  /**
   * The operator typed the code the HUB shows. From the agent's own machine that is enough; from
   * anywhere else the one-time PIN of THIS pairing (read on the agent's console) must come with
   * it. A wrong code counts against the pairing (the third cancels it); a wrong PIN counts against
   * the agent (five lock confirming for five minutes).
   */
  confirm(body: unknown, ctx: PairingRequestContext): PairingResult<{ readonly code: string }> {
    const found = this.localTarget(body, ctx)
    if ('ok' in found) return found
    const session = found
    if (session.code === null) {
      return fail(409, 'not-ready', 'the hub has not revealed its nonce yet')
    }
    const code = field(body, 'code')
    if (!constantTimeEqual(session.code, typeof code === 'string' ? code.trim() : code)) {
      session.attempts += 1
      if (session.attempts >= PAIRING_MAX_CODE_ATTEMPTS) {
        this.end(session, 'code-mismatch')
        return fail(403, 'code-mismatch', 'wrong code three times — the pairing was cancelled')
      }
      return fail(403, 'code-mismatch', 'that is not the code this agent computed')
    }
    session.localConfirmed = true
    this.announceLocally(session)
    // The answer to a confirm that proved the operator is here (hub code + PIN unless loopback):
    // the code to type ON THE HUB. Status from the network never carries it.
    return { ok: true, code: session.code }
  }

  reject(body: unknown, ctx: PairingRequestContext): PairingResult<object> {
    const found = this.localTarget(body, ctx)
    if ('ok' in found) return found
    this.end(found, 'rejected')
    return { ok: true }
  }

  /** The hub withdraws its own pairing (authorized by the pairing id it was given). */
  cancel(body: unknown): PairingResult<object> {
    const session = this.pending(body)
    if ('ok' in session) return session
    this.end(session, 'rejected')
    return { ok: true }
  }

  // ── The hub completes ────────────────────────────────────────────────

  async complete(body: unknown): Promise<PairingResult<object>> {
    const session = this.pending(body)
    if ('ok' in session) return session
    if (session.hubNonce === null || session.code === null) {
      return fail(409, 'not-ready', 'the hub has not revealed its nonce yet')
    }
    // The gate that keeps a man in the middle out: nothing is installed until THIS agent's
    // operator confirmed the code the real hub shows.
    if (!session.localConfirmed) {
      return fail(
        409,
        'awaiting-local-confirmation',
        'the operator has not confirmed on this agent',
      )
    }
    const leafPem = field(body, 'leafPem')
    const caCertPem = field(body, 'caCertPem')
    const proof = field(body, 'proof')
    if (!isText(leafPem, 16_384) || !isText(caCertPem, 16_384) || !isText(proof, 16_384)) {
      return fail(400, 'bad-complete', 'the completion is malformed')
    }
    const refusal = this.checkCompletion(session, leafPem, caCertPem, proof)
    if (refusal !== null) {
      this.end(session, 'failed')
      return refusal
    }
    try {
      await this.deps.install({
        meshTls: { certPem: leafPem, keyPem: session.keyPem, caCertPem: session.hub.caCertPem },
        hubAddress: hubHostFromMeshAddress(session.hub.meshAddress),
        hubUrl: session.hub.url,
      })
    } catch (err) {
      this.end(session, 'failed')
      return fail(500, 'install-failed', err instanceof Error ? err.message : String(err))
    }
    this.end(session, 'completed')
    // The other pairings were offered to an agent that is now paired: they die with it.
    for (const other of [...this.sessions.values()]) this.end(other, 'failed', false)
    this.deps.log?.('paired with the hub', { hubUrl: session.hub.url })
    return { ok: true }
  }

  /** The agent forgot its hub (local action): the pairing slate is clean. */
  noteUnpaired(): void {
    for (const s of [...this.sessions.values()]) this.end(s, 'failed', false)
    this.deps.onStateChange?.()
  }

  // ── internals ────────────────────────────────────────────────────────

  /** Any lockout `reset` would lift: the offer budget, a hub CA's backoff, or a source locked for wrong secrets. */
  private isLockedOut(): boolean {
    const at = this.now()
    if (at < this.lockedUntil) return true
    for (const ca of this.perCa.values()) if (at < ca.until) return true
    for (const entry of this.pinBySource.values()) if (at < entry.lockedUntil) return true
    return false
  }

  /** Remaining lock for a source, or `null`. Loopback never calls this. */
  private sourceLock(source: string, at: number): number | null {
    const entry = this.pinBySource.get(source)
    return entry !== undefined && at < entry.lockedUntil ? entry.lockedUntil - at : null
  }

  /** A wrong PIN or reset code from `source`: five in five minutes lock THAT source, doubling. */
  private noteWrongSecret(source: string, at: number): void {
    if (this.pinBySource.size >= MAX_TRACKED_SOURCES && !this.pinBySource.has(source)) {
      this.pinBySource.clear()
    }
    const prev = this.pinBySource.get(source) ?? { failures: [], strikes: 0, lockedUntil: 0 }
    const failures = [...prev.failures.filter((t) => at - t < 5 * 60_000), at]
    if (failures.length >= PIN_FAILURE_LIMIT) {
      const lockedUntil = at + Math.min(PIN_LOCK_MAX_MS, PIN_LOCK_MS * 2 ** prev.strikes)
      this.deps.log?.('confirming is locked for a source: too many wrong PINs', { source })
      this.pinBySource.set(source, { failures: [], strikes: prev.strikes + 1, lockedUntil })
    } else {
      this.pinBySource.set(source, { ...prev, failures })
    }
    // A flood from many sources: cancel what is pending rather than let it be ground away.
    this.globalPinFailures = [...this.globalPinFailures.filter((t) => at - t < PAIRING_TTL_MS), at]
    if (this.globalPinFailures.length >= PIN_GLOBAL_CEILING) {
      this.globalPinFailures = []
      this.deps.log?.('too many wrong PINs overall: every pending pairing is cancelled', {})
      // A flood is not the hubs' abandonment: it must not spend the offer budget.
      for (const session of [...this.sessions.values()]) this.end(session, 'failed', false)
    }
  }

  /**
   * The operator clears the lockouts, the budget and every pending offer. From this machine
   * (genuine loopback) or with the LOCAL RESET CODE printed at boot; the code is renewed on use.
   */
  reset(body: unknown, ctx: PairingRequestContext): PairingResult<object> {
    const at = this.now()
    if (!ctx.local) {
      const key = `reset:${ctx.source ?? 'unknown'}`
      const locked = this.sourceLock(key, at)
      if (locked !== null) return fail(429, 'reset-locked', 'too many wrong codes', locked)
      const code = field(body, 'code')
      if (typeof code !== 'string' || !constantTimeEqual(this.resetCode, code.trim())) {
        this.noteWrongSecret(key, at)
        return fail(401, 'reset-code-required', 'the reset code printed on the agent is required')
      }
    }
    for (const session of [...this.sessions.values()]) this.end(session, 'failed', false)
    this.abandoned = []
    this.lockedUntil = 0
    this.perCa.clear()
    this.pinBySource.clear()
    this.globalPinFailures = []
    this.resetCode = randomPin()
    this.deps.onResetCode?.(this.resetCode)
    this.deps.log?.('pairing was reset by the local operator', {})
    return { ok: true }
  }

  /** Verify the CA-key signature of an offer and spend its commitment. */
  private checkOfferSignature(request: OfferRequest, caFingerprint: string): PairingFailure | null {
    const claims = verifyPairingOffer(request.hubCaCertPem, request.signature)
    const at = this.now()
    if (
      claims === null ||
      claims.use !== PAIRING_OFFER_USE ||
      claims.agentNodeId !== this.deps.nodeId ||
      claims.hubNodeId !== request.hubNodeId ||
      claims.caFingerprint !== caFingerprint ||
      claims.commitment !== request.commitment ||
      claims.hubUrl !== request.hubUrl ||
      claims.hubMeshAddress !== request.hubMeshAddress ||
      claims.iat > at + 60_000 ||
      at - claims.iat > PAIRING_OFFER_MAX_AGE_MS
    ) {
      this.deps.log?.('an offer without a valid CA signature was refused', {})
      return fail(403, 'bad-offer-signature', 'the offer is not signed by the CA it presents')
    }
    for (const [commitment, until] of this.seenCommitments) {
      if (until <= at) this.seenCommitments.delete(commitment)
    }
    if (this.seenCommitments.has(request.commitment)) {
      return fail(409, 'offer-replayed', 'this offer was already used')
    }
    this.seenCommitments.set(request.commitment, at + PAIRING_OFFER_MAX_AGE_MS + 60_000)
    return null
  }

  /**
   * All slots taken: a signed offer makes room by dropping the oldest pairing whose hub never showed
   * activity (no reveal, no poll) and that no operator confirmed. `false` when there is none.
   */
  private makeRoom(): boolean {
    const candidates = [...this.sessions.values()]
      .filter((s) => !s.touched && !s.localConfirmed)
      .toSorted((a, b) => a.createdAt - b.createdAt)
    const oldest = candidates[0]
    if (oldest === undefined) return false
    this.deps.log?.('a pending pairing made room for a newer signed offer', {
      caFingerprint: oldest.hub.caFingerprint,
    })
    this.end(oldest, 'failed', false)
    return true
  }

  /** Offers that never reached local confirmation are rationed - globally and per hub CA. */
  private rationOffer(caFingerprint: string): PairingFailure | null {
    const at = this.now()
    if (at < this.lockedUntil) {
      this.deps.log?.('offer refused: the budget of abandoned pairings is spent', {
        retryAfterMs: this.lockedUntil - at,
      })
      return fail(
        429,
        'offer-budget',
        'too many pairings were abandoned recently - try again later',
        this.lockedUntil - at,
      )
    }
    const ca = this.perCa.get(caFingerprint)
    if (ca !== undefined && at < ca.until) {
      this.deps.log?.('offer refused: this hub abandoned a pairing a moment ago', {
        caFingerprint,
        retryAfterMs: ca.until - at,
      })
      return fail(
        429,
        'offer-backoff',
        'this hub abandoned a pairing a moment ago - wait before offering again',
        ca.until - at,
      )
    }
    return null
  }

  /** A pairing ended without the local operator confirming it: it counts against the budget. */
  private noteAbandoned(session: Session): void {
    const at = this.now()
    this.abandoned = [...this.abandoned.filter((t) => at - t < BUDGET_WINDOW_MS), at]
    if (this.abandoned.length >= BUDGET_OFFERS) {
      const over = this.abandoned.length - BUDGET_OFFERS
      const lock = Math.min(LOCKOUT_MAX_MS, LOCKOUT_BASE_MS * 2 ** over)
      this.lockedUntil = at + lock
      this.deps.log?.('pairing offers are locked: too many were abandoned', {
        abandoned: this.abandoned.length,
        lockMs: lock,
      })
    }
    const prev = this.perCa.get(session.hub.caFingerprint)
    const count = (prev?.count ?? 0) + 1
    const backoff =
      count < 2 ? 0 : Math.min(CA_BACKOFF_MAX_MS, CA_BACKOFF_BASE_MS * 2 ** (count - 2))
    this.perCa.set(session.hub.caFingerprint, { count, until: at + backoff })
  }

  /** The pairing this local request means, else the refusal. */
  private localTarget(body: unknown, ctx: PairingRequestContext): Session | PairingFailure {
    this.expireIfDue()
    if (this.sessions.size === 0) return fail(404, 'no-pairing', 'no pairing is pending')
    const pin = field(body, 'pin')
    if (!ctx.local) {
      const at = this.now()
      const source = ctx.source ?? 'unknown'
      const locked = this.sourceLock(source, at)
      if (locked !== null) {
        return fail(429, 'pin-locked', 'too many wrong PINs - try again later', locked)
      }
      const match =
        typeof pin === 'string'
          ? [...this.sessions.values()].find((s) => constantTimeEqual(s.pin, pin.trim()))
          : undefined
      if (match === undefined) {
        this.noteWrongSecret(source, at)
        return fail(
          401,
          'pin-required',
          "the PIN shown on this agent's own machine (console, file or local window) is required",
        )
      }
      return match
    }
    // Genuine loopback: the PIN may be given to pick one of several; alone, there must be one.
    if (typeof pin === 'string' && pin.trim().length > 0) {
      const match = [...this.sessions.values()].find((s) => constantTimeEqual(s.pin, pin.trim()))
      if (match !== undefined) return match
    }
    const only = [...this.sessions.values()]
    if (only.length === 1 && only[0] !== undefined) return only[0]
    return fail(409, 'ambiguous', 'several pairings are pending - give the PIN of the one you mean')
  }

  private announceLocally(session: Session): void {
    this.deps.onLocalSecret?.({
      pairingId: session.pairingId,
      pin: session.pin,
      // Printed only after the local confirmation, like the loopback status (D857).
      code: session.localConfirmed ? session.code : null,
      hub: {
        nodeId: session.hub.nodeId,
        url: session.hub.url,
        caFingerprint: session.hub.caFingerprint,
      },
      expiresAt: session.expiresAt,
    })
  }

  private checkCompletion(
    session: Session,
    leafPem: string,
    caCertPem: string,
    proof: string,
  ): PairingFailure | null {
    if (caFingerprintOf(caCertPem) !== session.hub.caFingerprint) {
      return fail(400, 'ca-mismatch', 'the completion carries a CA other than the one offered')
    }
    // The proof is checked against the CA that was OFFERED and confirmed, never the one in the body.
    const claims = verifyPairingProof(session.hub.caCertPem, proof)
    if (claims === null) return fail(400, 'bad-proof', 'the pairing proof does not verify')
    if (
      claims.pairingId !== session.pairingId ||
      claims.nodeId !== this.deps.nodeId ||
      claims.hubNonce !== session.hubNonce ||
      claims.agentNonce !== session.agentNonce ||
      claims.caFingerprint !== session.hub.caFingerprint ||
      claims.hubMeshAddress !== session.hub.meshAddress ||
      claims.hubUrl !== session.hub.url
    ) {
      return fail(400, 'bad-proof', 'the pairing proof is for another pairing')
    }
    const at = this.now()
    if (
      claims.exp <= at ||
      claims.iat > at + 60_000 ||
      claims.exp - claims.iat > PAIRING_PROOF_MAX_LIFETIME_MS
    ) {
      return fail(400, 'bad-proof', 'the pairing proof is expired or has an impossible lifetime')
    }
    try {
      if (claims.leafFingerprint !== leafFingerprintCompact(leafPem)) {
        return fail(400, 'bad-leaf', 'the certificate is not the one the proof names')
      }
      const leaf = new X509Certificate(leafPem)
      const ca = new X509Certificate(session.hub.caCertPem)
      if (!leaf.verify(ca.publicKey)) {
        return fail(400, 'bad-leaf', 'the certificate is not signed by the offered CA')
      }
      if (subjectCn(leaf.subject.replaceAll('\n', ',')) !== this.deps.nodeId) {
        return fail(400, 'bad-leaf', `the certificate is not issued for "${this.deps.nodeId}"`)
      }
      if (!leaf.checkPrivateKey(createPrivateKey(session.keyPem))) {
        return fail(400, 'bad-leaf', "the certificate does not match this agent's private key")
      }
      if (Date.parse(leaf.validTo) <= this.now()) {
        return fail(400, 'bad-leaf', 'the certificate is already expired')
      }
    } catch {
      return fail(400, 'bad-leaf', 'the certificate could not be read')
    }
    return null
  }

  /** The live session `body.pairingId` names, else the refusal. */
  private pending(body: unknown): Session | PairingFailure {
    this.expireIfDue()
    const pairingId = field(body, 'pairingId')
    if (this.sessions.size === 0) return fail(404, 'no-pairing', 'no pairing is pending')
    const session = typeof pairingId === 'string' ? this.sessions.get(pairingId) : undefined
    if (session === undefined) return fail(403, 'wrong-pairing', 'that is not a pending pairing')
    return session
  }

  private expireIfDue(): void {
    for (const s of [...this.sessions.values()]) {
      if (s.expiresAt <= this.now()) this.end(s, 'expired')
    }
  }

  private outcomeOf(pairingId: string): PairingOutcome | null {
    const entry = this.outcomes.get(pairingId)
    if (entry === undefined) return null
    if (this.now() - entry.at > OUTCOME_TTL_MS) {
      this.outcomes.delete(pairingId)
      return null
    }
    return entry.outcome
  }

  private rememberOutcome(pairingId: string, outcome: PairingOutcome): void {
    this.outcomes.set(pairingId, { outcome, at: this.now() })
    while (this.outcomes.size > OUTCOME_LIMIT) {
      const oldest = this.outcomes.keys().next().value
      if (oldest === undefined) break
      this.outcomes.delete(oldest)
    }
  }

  private end(session: Session, outcome: PairingOutcome, count = true): void {
    if (!this.sessions.delete(session.pairingId)) return
    this.rememberOutcome(session.pairingId, outcome)
    if (outcome === 'completed') this.perCa.delete(session.hub.caFingerprint)
    else if (count && !session.localConfirmed) this.noteAbandoned(session)
    this.deps.onLocalSecretCleared?.(session.pairingId)
    this.deps.onStateChange?.()
    if (outcome !== 'completed') {
      this.deps.log?.('pairing cancelled', { outcome, hubUrl: session.hub.url })
    }
  }
}

function field(body: unknown, key: string): unknown {
  return body !== null && typeof body === 'object' ? Reflect.get(body, key) : undefined
}

function caFingerprintOf(pem: string): string | null {
  try {
    return caFingerprintCompact(pem)
  } catch {
    return null
  }
}

function parseOffer(body: unknown): OfferRequest | null {
  if (body === null || typeof body !== 'object') return null
  const protocol: unknown = Reflect.get(body, 'protocol')
  const hubNodeId: unknown = Reflect.get(body, 'hubNodeId')
  const hubCaCertPem: unknown = Reflect.get(body, 'hubCaCertPem')
  const commitment: unknown = Reflect.get(body, 'commitment')
  const hubUrl: unknown = Reflect.get(body, 'hubUrl')
  const hubMeshAddress: unknown = Reflect.get(body, 'hubMeshAddress')
  const signature: unknown = Reflect.get(body, 'signature')
  if (typeof protocol !== 'number') return null
  if (!isText(hubNodeId, 128) || !isText(hubCaCertPem, 16_384) || !isText(commitment, 128)) {
    return null
  }
  if (!isText(hubUrl) || !isText(hubMeshAddress, 255) || !isText(signature, 4096)) return null
  return { protocol, hubNodeId, hubCaCertPem, commitment, hubUrl, hubMeshAddress, signature }
}

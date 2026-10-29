/**
 * "Am I still a member?" - the question a refused agent asks its hub (D857).
 *
 * A node the operator forgot or unpaired keeps its leaf and retries forever: the mesh refuses it, and
 * the refusal says nothing it can act on. This is the one answer the hub gives such a node, over the
 * hub's HTTPS API (the mesh port is shut to it):
 *
 *   1. `POST /api/mesh/membership/challenge`  -> `{ nonce }` (single use, 60 s, anyone may ask)
 *   2. `POST /api/mesh/membership`            -> `{ nodeId, certPem, nonce, signature }`
 *        the agent signs `proofInput(nodeId, nonce)` with its LEAF's private key, so only the holder
 *        of a key the hub's CA certified for `nodeId` is answered; anything else is `401` and learns
 *        nothing (not even whether the node id exists).
 *   3. The answer is a JWS signed by the MESH CA key (`typ: camstack-mesh-membership+jwt`), bound to
 *      the nonce and the leaf fingerprint, so a man in the middle cannot forge "revoked" - the agent
 *      verifies it with the CA it pinned at pairing. The hub's HTTPS certificate is not trusted for it.
 *
 * `member | revoked (+ reason) | unknown`: `unknown` is a leaf the registry never issued (a reinstalled
 * hub, a different CA) - the agent changes nothing on it, like on every other doubt (D49).
 *
 * No shared secret, and nothing on argv or in the environment.
 */
import {
  createPrivateKey,
  randomBytes,
  sign,
  verify,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import type { MeshCertificateRegistry } from './mesh-certificate-registry.js'
import type { MeshCrl } from './mesh-crl.js'

export const MEMBERSHIP_PATHS = {
  challenge: '/api/mesh/membership/challenge',
  query: '/api/mesh/membership',
} as const

export const MEMBERSHIP_TYP = 'camstack-mesh-membership+jwt'
export const MEMBERSHIP_USE = 'mesh-membership'
const MEMBERSHIP_VERSION = 1 as const
/** A challenge nonce, and an answer, are good for this long. */
export const MEMBERSHIP_TTL_MS = 60_000
/** Challenges held at once; the oldest is dropped past this (an unauthenticated route stays bounded). */
const MAX_PENDING_CHALLENGES = 1024
const PROOF_CONTEXT = 'camstack-mesh-membership-v1'

export type MembershipStatus = 'member' | 'revoked' | 'unknown'

export interface MembershipAnswer {
  readonly status: MembershipStatus
  /** Why the leaf was revoked (`forgotten`, `superseded by pairing`, ...), only when `revoked`. */
  readonly reason?: string
}

/** What the agent signs with its leaf key: bound to this node and this nonce only. */
export function membershipProofInput(nodeId: string, nonce: string): Buffer {
  return Buffer.from(`${PROOF_CONTEXT}\n${nodeId}\n${nonce}`, 'utf8')
}

/** Agent side: the proof of possession of the leaf's private key. */
export function signMembershipProof(leafKeyPem: string, nodeId: string, nonce: string): string {
  return sign('sha256', membershipProofInput(nodeId, nonce), {
    key: createPrivateKey(leafKeyPem),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
}

function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replaceAll(':', '').toLowerCase()
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** Hub side: the answer, signed by the mesh CA key. */
function mintAnswer(
  caKeyPem: string,
  claims: {
    readonly nodeId: string
    readonly leafFingerprint: string
    readonly nonce: string
    readonly answer: MembershipAnswer
    readonly nowMs: number
  },
): string {
  const payload = {
    v: MEMBERSHIP_VERSION,
    use: MEMBERSHIP_USE,
    nodeId: claims.nodeId,
    fp: normalizeFingerprint(claims.leafFingerprint),
    nonce: claims.nonce,
    status: claims.answer.status,
    ...(claims.answer.reason !== undefined ? { reason: claims.answer.reason } : {}),
    iat: claims.nowMs,
    exp: claims.nowMs + MEMBERSHIP_TTL_MS,
  }
  const signingInput = `${b64urlJson({ alg: 'ES256', typ: MEMBERSHIP_TYP })}.${b64urlJson(payload)}`
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: createPrivateKey(caKeyPem),
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${signature.toString('base64url')}`
}

export interface VerifyMembershipAnswerOptions {
  readonly nodeId: string
  /** The nonce this agent was challenged with. */
  readonly nonce: string
  /** Fingerprint (sha256, any case / colons) of the leaf this agent presented. */
  readonly leafFingerprint: string
  readonly nowMs?: number
}

function isStatus(value: unknown): value is MembershipStatus {
  return value === 'member' || value === 'revoked' || value === 'unknown'
}

/**
 * Agent side: verify a hub's answer against the CA certificate pinned at pairing. `null` when the
 * signature, header, binding (node, nonce, leaf) or freshness fails - a forged or replayed answer is
 * "no answer", never "revoked".
 */
export function verifyMembershipAnswer(
  caCertPem: string,
  token: string,
  options: VerifyMembershipAnswerOptions,
): MembershipAnswer | null {
  const nowMs = options.nowMs ?? Date.now()
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts
  if (headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) return null
  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof header !== 'object' || header === null) return null
  if (Reflect.get(header, 'alg') !== 'ES256' || Reflect.get(header, 'typ') !== MEMBERSHIP_TYP) {
    return null
  }
  let valid = false
  try {
    valid = verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
      {
        key: new X509Certificate(caCertPem).publicKey,
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(signatureB64, 'base64url'),
    )
  } catch {
    return null
  }
  if (!valid) return null
  if (typeof payload !== 'object' || payload === null) return null
  const status: unknown = Reflect.get(payload, 'status')
  const reason: unknown = Reflect.get(payload, 'reason')
  const iat: unknown = Reflect.get(payload, 'iat')
  const exp: unknown = Reflect.get(payload, 'exp')
  if (
    Reflect.get(payload, 'v') !== MEMBERSHIP_VERSION ||
    Reflect.get(payload, 'use') !== MEMBERSHIP_USE ||
    Reflect.get(payload, 'nodeId') !== options.nodeId ||
    Reflect.get(payload, 'nonce') !== options.nonce ||
    Reflect.get(payload, 'fp') !== normalizeFingerprint(options.leafFingerprint) ||
    !isStatus(status) ||
    typeof iat !== 'number' ||
    typeof exp !== 'number'
  ) {
    return null
  }
  if (exp <= nowMs || iat > nowMs + MEMBERSHIP_TTL_MS || exp - iat > MEMBERSHIP_TTL_MS) return null
  return typeof reason === 'string' && status === 'revoked' ? { status, reason } : { status }
}

export interface MembershipResponderDeps {
  readonly registry: () => MeshCertificateRegistry | null
  readonly crl: () => MeshCrl
  /** The mesh CA's private key (PKCS#8 PEM), `null` while the CA is not ready. */
  readonly caKeyPem: () => string | null
  readonly now?: () => number
  readonly log?: (message: string, meta: { readonly nodeId: string }) => void
}

/** A refusal: `401` = no proof of possession (learns nothing), `400` = malformed, `503` = not ready. */
export type MembershipRefusal = {
  readonly ok: false
  readonly status: 400 | 401 | 503
}
export type MembershipOutcome = { readonly ok: true; readonly token: string } | MembershipRefusal

/** The hub's side: hands out nonces and answers a node that proves it holds a leaf the hub issued. */
export class MembershipResponder {
  private readonly pending = new Map<string, number>()

  constructor(private readonly deps: MembershipResponderDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  issueChallenge(): string {
    const at = this.now()
    for (const [nonce, expiresAt] of this.pending) {
      if (expiresAt <= at) this.pending.delete(nonce)
    }
    while (this.pending.size >= MAX_PENDING_CHALLENGES) {
      const oldest = this.pending.keys().next().value
      if (oldest === undefined) break
      this.pending.delete(oldest)
    }
    const nonce = randomBytes(24).toString('base64url')
    this.pending.set(nonce, at + MEMBERSHIP_TTL_MS)
    return nonce
  }

  /** A nonce is good once: spent whether the proof then holds or not. */
  private consume(nonce: string): boolean {
    const expiresAt = this.pending.get(nonce)
    this.pending.delete(nonce)
    return expiresAt !== undefined && expiresAt > this.now()
  }

  answer(body: unknown): MembershipOutcome {
    if (typeof body !== 'object' || body === null) return { ok: false, status: 400 }
    const nodeId: unknown = Reflect.get(body, 'nodeId')
    const certPem: unknown = Reflect.get(body, 'certPem')
    const nonce: unknown = Reflect.get(body, 'nonce')
    const signature: unknown = Reflect.get(body, 'signature')
    if (
      typeof nodeId !== 'string' ||
      typeof certPem !== 'string' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string' ||
      nodeId.length === 0 ||
      certPem.length > 8192 ||
      signature.length > 512
    ) {
      return { ok: false, status: 400 }
    }
    if (!this.consume(nonce)) return { ok: false, status: 401 }

    let cert: X509Certificate
    let publicKey: KeyObject
    try {
      cert = new X509Certificate(certPem)
      publicKey = cert.publicKey
    } catch {
      return { ok: false, status: 401 }
    }
    let proven = false
    try {
      proven = verify(
        'sha256',
        membershipProofInput(nodeId, nonce),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      )
    } catch {
      return { ok: false, status: 401 }
    }
    if (!proven) return { ok: false, status: 401 }

    const registry = this.deps.registry()
    const caKeyPem = this.deps.caKeyPem()
    if (registry === null || caKeyPem === null) return { ok: false, status: 503 }

    const fingerprint = normalizeFingerprint(cert.fingerprint256)
    const record = registry
      .list(nodeId)
      .find((r) => normalizeFingerprint(r.fingerprint) === fingerprint)
    let answer: MembershipAnswer
    if (record === undefined) {
      answer = { status: 'unknown' }
    } else if (this.deps.crl().isRevoked(record.serial)) {
      answer = { status: 'revoked', reason: record.revokedReason ?? 'revoked' }
      this.deps.log?.('a revoked node asked whether it is still a member - told it is not', {
        nodeId,
      })
    } else {
      answer = { status: 'member' }
    }
    return {
      ok: true,
      token: mintAnswer(caKeyPem, {
        nodeId,
        leafFingerprint: cert.fingerprint256,
        nonce,
        answer,
        nowMs: this.now(),
      }),
    }
  }
}

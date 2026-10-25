/**
 * Agent pairing — the cryptographic core (D857).
 *
 * Pairing makes an agent hold a certificate from the hub's mesh CA, with no
 * shared secret anywhere. The hub starts it (LAN discovery or a typed
 * address); the operator confirms the SAME six digits on the hub and in the
 * agent's own page. Everything the human compares is derived here.
 *
 *   hub → agent   offer    { hub CA cert, commit = H(caFp ‖ hubNonce), hubUrl, hubMeshAddress }
 *   agent → hub   answer   { pairingId, CSR (mesh key made on the agent), agentNonce }
 *   hub → agent   reveal   { hubNonce }            (agent checks it against the commit)
 *   both          SAS      = 6 digits of H(caFp ‖ agentPublicKey ‖ hubNonce ‖ agentNonce)
 *   operator      reads the code on one screen and types it on the other, on both sides
 *   hub → agent   complete { leaf, proof }         (only after both confirmations)
 *
 * Why a commitment: a six-digit code is 20 bits. An attacker between the two
 * who could still choose a value AFTER seeing the others could grind a CA key
 * whose code equals the real one in a million tries. The hub therefore commits
 * to its nonce before it sees the agent's answer and reveals it only after,
 * so nothing the attacker controls is chosen after everything the code is
 * derived from is fixed. A substituted CA changes the code with probability
 * 999 999 / 1 000 000 per attempt, and a wrong code ends the pairing after
 * three tries.
 *
 * `proof` is an ES256 JWS by the mesh CA key over the transcript (pairing id,
 * node id, both nonces, the leaf fingerprint, the CA fingerprint). The agent
 * verifies it with the CA certificate it was OFFERED and the operator
 * confirmed — never with one that arrives in the same message.
 */
import {
  createHash,
  createPrivateKey,
  randomBytes,
  randomInt,
  sign,
  timingSafeEqual,
  verify,
  webcrypto,
  X509Certificate,
} from 'node:crypto'
import { Pkcs10CertificateRequest } from '@peculiar/x509'
import { caFingerprintCompact, isValidAgentNodeId, subjectCn } from '../mesh-ca.js'

export { isValidAgentNodeId }

export const PAIRING_PROTOCOL = 1 as const
export const PAIRING_DOMAIN = 'camstack-pairing/v1'
export const PAIRING_PROOF_TYP = 'camstack-pairing-complete+jwt'
export const PAIRING_PROOF_USE = 'pairing-complete'
export const PAIRING_OFFER_TYP = 'camstack-pairing-offer+jwt'
export const PAIRING_OFFER_USE = 'pairing-offer'
/** An offer signature older than this (or from further ahead than 60 s) is refused. */
export const PAIRING_OFFER_MAX_AGE_MS: number = 2 * 60_000
/** A pairing that is not confirmed on both sides within this window is cancelled on both. */
export const PAIRING_TTL_MS: number = 5 * 60_000
/** Wrong codes typed before the pairing is cancelled. */
export const PAIRING_MAX_CODE_ATTEMPTS = 3
export const PAIRING_CODE_DIGITS = 6
/** Pending pairings an agent holds at once, one per hub CA (offer squatting, D857). */
export const PAIRING_MAX_SESSIONS = 4
/** The local PIN: single use, shown only on the agent's own machine. */
export const PAIRING_PIN_DIGITS = 8
/** A pairing proof is valid this long from `iat`, never longer. */
export const PAIRING_PROOF_MAX_LIFETIME_MS: number = 5 * 60_000

/** Agent endpoints, all under the agent API (`:4444`). */
export const PAIRING_PATHS = {
  hello: '/api/agent/pairing/hello',
  offer: '/api/agent/pairing/offer',
  reveal: '/api/agent/pairing/reveal',
  /** Public: who asks to pair - never a code, a pairing id or a PIN. */
  status: '/api/agent/pairing/status',
  /** The hub's poll, authorized by the pairing id: did the agent's operator confirm? */
  poll: '/api/agent/pairing/poll',
  complete: '/api/agent/pairing/complete',
  /** The agent's operator: the hub's code + the local PIN (or genuine loopback). */
  confirm: '/api/agent/pairing/confirm',
  reject: '/api/agent/pairing/reject',
  /** The hub withdraws its pairing, authorized by the pairing id. */
  cancel: '/api/agent/pairing/cancel',
  /** The agent's operator clears lockouts and pending offers (loopback, or the local reset code). */
  reset: '/api/agent/pairing/reset',
  forget: '/api/agent/pairing/forget',
} as const

export type AgentPairingState = 'unpaired' | 'pending' | 'paired'

/** A fresh single-use local PIN: digits only, uniformly random. */
export function randomPin(): string {
  return String(randomInt(0, 10 ** PAIRING_PIN_DIGITS)).padStart(PAIRING_PIN_DIGITS, '0')
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex')
}

export function newPairingId(): string {
  return randomBytes(16).toString('base64url')
}

/** The hub's commitment to its nonce, bound to the CA certificate it offers. */
export function computePairingCommitment(caCertPem: string, hubNonce: string): string {
  return createHash('sha256')
    .update(`${PAIRING_DOMAIN}|commit|${caFingerprintCompact(caCertPem)}|${hubNonce}`, 'utf8')
    .digest('hex')
}

export function commitmentsEqual(expected: string, presented: unknown): boolean {
  return constantTimeEqual(expected, presented)
}

export interface PairingSasInput {
  readonly caCertPem: string
  /** SPKI DER of the agent's mesh public key, base64. */
  readonly agentPublicKeySpki: string
  readonly hubNonce: string
  readonly agentNonce: string
}

/** The six digits both screens show. */
export function computePairingSas(input: PairingSasInput): string {
  const digest = createHash('sha256')
    .update(
      [
        PAIRING_DOMAIN,
        'sas',
        caFingerprintCompact(input.caCertPem),
        input.agentPublicKeySpki,
        input.hubNonce,
        input.agentNonce,
      ].join('|'),
      'utf8',
    )
    .digest()
  const value = digest.readUInt32BE(0) % 10 ** PAIRING_CODE_DIGITS
  return String(value).padStart(PAIRING_CODE_DIGITS, '0')
}

export function constantTimeEqual(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** What the hub learns from an agent's CSR, after checking the CSR's own signature. */
export interface DescribedCsr {
  readonly commonName: string
  /** SPKI DER, base64 — what the SAS binds. */
  readonly publicKeySpki: string
}

export async function describeCsr(csrPem: string): Promise<DescribedCsr> {
  const csr = new Pkcs10CertificateRequest(csrPem)
  if (!(await csr.verify(webcrypto))) throw new Error('the agent CSR signature is invalid')
  const cn = subjectCn(csr.subject)
  if (cn === null || cn.length === 0) throw new Error('the agent CSR has no CN')
  return {
    commonName: cn,
    publicKeySpki: Buffer.from(csr.publicKey.rawData).toString('base64'),
  }
}

/** The transcript the CA signs when the hub completes a pairing. */
export interface PairingProofClaims {
  readonly v: typeof PAIRING_PROTOCOL
  readonly use: typeof PAIRING_PROOF_USE
  readonly pairingId: string
  readonly nodeId: string
  readonly hubNonce: string
  readonly agentNonce: string
  /** SHA-256 hex of the leaf DER. */
  readonly leafFingerprint: string
  readonly caFingerprint: string
  readonly hubMeshAddress: string
  readonly hubUrl: string
  /** Epoch ms. */
  readonly iat: number
  /** Epoch ms; at most {@link PAIRING_PROOF_MAX_LIFETIME_MS} after `iat`. */
  readonly exp: number
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function leafFingerprintCompact(certPem: string): string {
  return createHash('sha256').update(new X509Certificate(certPem).raw).digest('hex')
}

export function signPairingProof(caKeyPem: string, claims: PairingProofClaims): string {
  const signingInput = `${b64urlJson({ alg: 'ES256', typ: PAIRING_PROOF_TYP })}.${b64urlJson(claims)}`
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: createPrivateKey(caKeyPem),
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${signature.toString('base64url')}`
}

/**
 * The claims of `proof` when it was signed by `caCertPem`'s key, else `null`.
 * Shape, expiry and the binding to a session are the caller's to check.
 */
export function verifyPairingProof(caCertPem: string, proof: string): PairingProofClaims | null {
  const parts = proof.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts
  if (headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) {
    return null
  }
  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (header === null || typeof header !== 'object') return null
  if (Reflect.get(header, 'alg') !== 'ES256' || Reflect.get(header, 'typ') !== PAIRING_PROOF_TYP) {
    return null
  }
  let valid = false
  try {
    valid = verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
      { key: new X509Certificate(caCertPem).publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url'),
    )
  } catch {
    return null
  }
  return valid ? parseClaims(payload) : null
}

function parseClaims(value: unknown): PairingProofClaims | null {
  if (value === null || typeof value !== 'object') return null
  const str = (key: string): string | null => {
    const v: unknown = Reflect.get(value, key)
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const pairingId = str('pairingId')
  const nodeId = str('nodeId')
  const hubNonce = str('hubNonce')
  const agentNonce = str('agentNonce')
  const leafFingerprint = str('leafFingerprint')
  const caFingerprint = str('caFingerprint')
  const hubMeshAddress = str('hubMeshAddress')
  const hubUrl = str('hubUrl')
  const exp: unknown = Reflect.get(value, 'exp')
  const iat: unknown = Reflect.get(value, 'iat')
  if (Reflect.get(value, 'v') !== PAIRING_PROTOCOL) return null
  if (Reflect.get(value, 'use') !== PAIRING_PROOF_USE) return null
  if (
    pairingId === null ||
    nodeId === null ||
    hubNonce === null ||
    agentNonce === null ||
    leafFingerprint === null ||
    caFingerprint === null ||
    hubMeshAddress === null ||
    hubUrl === null ||
    typeof exp !== 'number' ||
    !Number.isFinite(exp) ||
    typeof iat !== 'number' ||
    !Number.isFinite(iat)
  ) {
    return null
  }
  return {
    v: PAIRING_PROTOCOL,
    use: PAIRING_PROOF_USE,
    pairingId,
    nodeId,
    hubNonce,
    agentNonce,
    leafFingerprint,
    caFingerprint,
    hubMeshAddress,
    hubUrl,
    iat,
    exp,
  }
}

/** A short public fingerprint of a public key, for the mDNS TXT record. */
export function keyFingerprintShort(publicKeySpkiB64: string): string {
  return createHash('sha256')
    .update(Buffer.from(publicKeySpkiB64, 'base64'))
    .digest('hex')
    .slice(0, 16)
}

/** What a hub signs with its CA key to make an offer: nobody holding only the public CA can. */
export interface PairingOfferClaims {
  readonly use: typeof PAIRING_OFFER_USE
  /** The agent the offer is for - an offer cannot be replayed to another agent. */
  readonly agentNodeId: string
  readonly hubNodeId: string
  readonly caFingerprint: string
  readonly commitment: string
  readonly hubUrl: string
  readonly hubMeshAddress: string
  readonly iat: number
}

export function signPairingOffer(caKeyPem: string, claims: PairingOfferClaims): string {
  const signingInput = `${b64urlJson({ alg: 'ES256', typ: PAIRING_OFFER_TYP })}.${b64urlJson(claims)}`
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key: createPrivateKey(caKeyPem),
    dsaEncoding: 'ieee-p1363',
  })
  return `${signingInput}.${signature.toString('base64url')}`
}

/** The claims of `token` when `caCertPem`'s key signed it as a pairing offer, else `null`. */
export function verifyPairingOffer(caCertPem: string, token: string): PairingOfferClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, signatureB64] = parts
  if (headerB64 === undefined || payloadB64 === undefined || signatureB64 === undefined) {
    return null
  }
  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'))
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (header === null || typeof header !== 'object') return null
  if (Reflect.get(header, 'alg') !== 'ES256' || Reflect.get(header, 'typ') !== PAIRING_OFFER_TYP) {
    return null
  }
  let valid = false
  try {
    valid = verify(
      'sha256',
      Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
      { key: new X509Certificate(caCertPem).publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signatureB64, 'base64url'),
    )
  } catch {
    return null
  }
  if (!valid || payload === null || typeof payload !== 'object') return null
  const str = (key: string): string | null => {
    const v: unknown = Reflect.get(payload, key)
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const iat: unknown = Reflect.get(payload, 'iat')
  const agentNodeId = str('agentNodeId')
  const hubNodeId = str('hubNodeId')
  const caFingerprint = str('caFingerprint')
  const commitment = str('commitment')
  const hubUrl = str('hubUrl')
  const hubMeshAddress = str('hubMeshAddress')
  if (Reflect.get(payload, 'use') !== PAIRING_OFFER_USE) return null
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null
  if (
    agentNodeId === null ||
    hubNodeId === null ||
    caFingerprint === null ||
    commitment === null ||
    hubUrl === null ||
    hubMeshAddress === null
  ) {
    return null
  }
  return {
    use: PAIRING_OFFER_USE,
    agentNodeId,
    hubNodeId,
    caFingerprint,
    commitment,
    hubUrl,
    hubMeshAddress,
    iat,
  }
}

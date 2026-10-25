/**
 * HMAC-based auth tokens for FrameServer subscriptions.
 *
 * Flow:
 *   1. Server issues `createAuthToken(sessionId, expiryMs)` and returns the
 *      token to the consumer via tRPC.
 *   2. Consumer sends the token in the first handshake message after
 *      connecting the transport.
 *   3. Server validates via `verifyAuthToken(token, expectedSessionId)`
 *      before accepting frame broadcasts.
 *
 * Tokens are self-contained: `${sessionId}.${expiryEpochMs}.${signature}`.
 * The signature is HMAC-SHA256 of the payload using the server's secret.
 * Base64url encoding — URL-safe, no padding.
 *
 * The secret is per-FrameServer instance and is generated at construction
 * time via `crypto.randomBytes(32)`. It never leaves the server process.
 * Rotating the secret invalidates all existing tokens.
 */
import * as crypto from 'node:crypto'

/** Issue a signed token for a single subscription. */
export interface AuthSigner {
  sign(sessionId: string, expiryEpochMs: number): string
}

/** Verify a token against expected sessionId and current wall-clock. */
export interface AuthVerifier {
  verify(token: string, expectedSessionId: string): AuthVerifyResult
}

export type AuthVerifyResult =
  | { readonly ok: true; readonly sessionId: string; readonly expiresAt: number }
  | {
      readonly ok: false
      readonly reason: 'malformed' | 'bad-signature' | 'expired' | 'wrong-session'
    }

/** Create a matched signer + verifier pair sharing the same secret. */
export function createAuthPair(): { signer: AuthSigner; verifier: AuthVerifier } {
  const secret = crypto.randomBytes(32)
  return {
    signer: {
      sign: (sessionId, expiryEpochMs) => signToken(secret, sessionId, expiryEpochMs),
    },
    verifier: {
      verify: (token, expectedSessionId) => verifyToken(secret, token, expectedSessionId),
    },
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

const SEPARATOR = '.'

function signToken(secret: Buffer, sessionId: string, expiryEpochMs: number): string {
  if (sessionId.includes(SEPARATOR)) {
    throw new Error(`sessionId must not contain "${SEPARATOR}"`)
  }
  const payload = `${sessionId}${SEPARATOR}${expiryEpochMs}`
  const sig = crypto.createHmac('sha256', secret).update(payload).digest()
  return `${payload}${SEPARATOR}${toBase64Url(sig)}`
}

function verifyToken(secret: Buffer, token: string, expectedSessionId: string): AuthVerifyResult {
  const parts = token.split(SEPARATOR)
  if (parts.length !== 3) {
    return { ok: false, reason: 'malformed' }
  }
  const [sessionId, expiryStr, signatureB64] = parts as [string, string, string]

  const expiryEpochMs = Number(expiryStr)
  if (!Number.isFinite(expiryEpochMs) || expiryEpochMs <= 0) {
    return { ok: false, reason: 'malformed' }
  }

  if (sessionId !== expectedSessionId) {
    return { ok: false, reason: 'wrong-session' }
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${sessionId}${SEPARATOR}${expiryStr}`)
    .digest()
  const providedSig = fromBase64Url(signatureB64)

  if (providedSig === null || providedSig.length !== expectedSig.length) {
    return { ok: false, reason: 'bad-signature' }
  }
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, reason: 'bad-signature' }
  }

  if (Date.now() > expiryEpochMs) {
    return { ok: false, reason: 'expired' }
  }

  return { ok: true, sessionId, expiresAt: expiryEpochMs }
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(s: string): Buffer | null {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  try {
    return Buffer.from(padded, 'base64')
  } catch {
    return null
  }
}

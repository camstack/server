import { userError } from '@camstack/types'
/**
 * HandoffCodeService — one-time login handoff codes for the native-app
 * auth handoff (viewer "Sign in with CamStack").
 *
 * Flow: an AUTHENTICATED browser session (the admin-ui login page, after
 * any successful login leg) mints a short-lived single-use code bound to
 * its user, then bounces to the app's custom-scheme callback
 * (`camstack://auth-callback?code=…`). The app redeems the code over the
 * PUBLIC `auth.redeemHandoffCode` procedure and receives a real session
 * JWT minted through the same `mintSessionForUserId` tail every login
 * leg uses.
 *
 * Design mirrors the pending-challenge / share-token patterns:
 *   • the raw code is returned exactly once; only its SHA-256 hash is
 *     kept server-side, so a memory dump never exposes redeemable codes;
 *   • TTL 60s — long enough to survive the browser → app bounce, short
 *     enough that a leaked callback URL goes stale before it travels;
 *   • single-use — the entry is consumed on FIRST redeem attempt
 *     (even an expired hit is deleted), so a replayed code is dead;
 *   • in-memory only — codes never need to survive a hub restart
 *     (the browser just re-runs the handoff), and a bounded store +
 *     prune-on-mint keeps the map from growing.
 */
import * as crypto from 'node:crypto'

/** Wire prefix — `chc_` = CamStack Handoff Code (not a credential: it is redeemed once for a session). */
export const HANDOFF_CODE_PREFIX = 'chc_'

export const HANDOFF_CODE_TTL_MS = 60_000

/** Hard bound on concurrently-pending codes (mint is auth-gated, so this
 *  only guards against a runaway authenticated client). */
export const HANDOFF_CODE_MAX_PENDING = 1_000

export interface HandoffCodeMintResult {
  /** The raw single-use code — returned exactly once, never stored. */
  readonly code: string
  /** Epoch ms after which the code stops redeeming. */
  readonly expiresAt: number
}

/**
 * What redeeming the code yields.
 *  - `renew` — continue the session the code was minted from (a legacy viewer
 *    renewing its token through the handoff pair): same session, its expiry
 *    slides. The default, because that is what installed apps call it for.
 *  - `new-session` — open a separate session for the redeemer (the admin-ui
 *    signing the native app in, a browser handoff): logging out one does not
 *    end the other.
 */
export type HandoffPurpose = 'renew' | 'new-session' | 'step-up'

export interface HandoffCodeGrant {
  readonly userId: string
  /** The device credential of the minting session: the child session inherits it (D855). */
  readonly credentialId?: string
  /** PKCE (S256): the app's `base64url(sha256(verifier))`, when it sent one. */
  readonly codeChallenge?: string
  /** The app's anti-CSRF `state`, required again at redeem. */
  readonly state?: string
  /** The login session the code was minted from, when it had one. */
  readonly sessionId?: string
  readonly purpose: HandoffPurpose
  /**
   * How the user authenticated for a code minted by a browser app flow
   * (D858) - `sso` for an IdP login, `passkey` for a hub passkey ceremony.
   * Absent on a code minted from an existing session.
   */
  readonly authMethod?: 'sso' | 'passkey'
}

interface PendingEntry extends HandoffCodeGrant {
  readonly expiresAt: number
}

export type HandoffRefusal = 'unknown-or-used' | 'expired' | 'pkce-mismatch' | 'state-mismatch'

export interface HandoffRedeemProof {
  readonly codeVerifier?: string
  readonly state?: string
}

/** RFC 7636 S256: `base64url(sha256(verifier))`. */
export function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex')
}

export class HandoffCodeService {
  /** Keyed by SHA-256(raw code). */
  private readonly pending = new Map<string, PendingEntry>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = HANDOFF_CODE_TTL_MS,
  ) {}

  /** Mint a single-use code bound to `userId`. Throws when the pending
   *  store is full even after pruning expired entries (fail fast — a
   *  legitimate flow never has anywhere near this many in flight). */
  create(
    userId: string,
    options: {
      readonly sessionId?: string
      readonly purpose?: HandoffPurpose
      readonly codeChallenge?: string
      readonly state?: string
      readonly credentialId?: string
      readonly authMethod?: 'sso' | 'passkey'
    } = {},
  ): HandoffCodeMintResult {
    this.prune()
    if (this.pending.size >= HANDOFF_CODE_MAX_PENDING) {
      throw userError(
        'server.handoff-busy',
        undefined,
        'Too many pending handoff codes — try again shortly',
      )
    }
    const code = `${HANDOFF_CODE_PREFIX}${crypto.randomBytes(32).toString('hex')}`
    const expiresAt = this.now() + this.ttlMs
    this.pending.set(hashCode(code), {
      userId,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
      purpose: options.purpose ?? 'renew',
      ...(options.codeChallenge !== undefined ? { codeChallenge: options.codeChallenge } : {}),
      ...(options.state !== undefined ? { state: options.state } : {}),
      ...(options.credentialId !== undefined ? { credentialId: options.credentialId } : {}),
      ...(options.authMethod !== undefined ? { authMethod: options.authMethod } : {}),
      expiresAt,
    })
    return { code, expiresAt }
  }

  /** Redeem a raw code. Consumes the entry on the FIRST attempt no
   *  matter the outcome (single-use); returns `null` for unknown,
   *  already-used, or expired codes — the router maps that to 401. */
  redeem(code: string, proof: HandoffRedeemProof = {}): HandoffCodeGrant | null {
    return this.redeemWithReason(code, proof).grant
  }

  /** Like {@link redeem}, but says why a code was refused (for the log line). */
  redeemWithReason(
    code: string,
    proof: HandoffRedeemProof = {},
  ): { readonly grant: HandoffCodeGrant | null; readonly reason: HandoffRefusal | null } {
    const entry = this.pending.get(hashCode(code))
    if (!entry) return { grant: null, reason: 'unknown-or-used' }
    this.pending.delete(hashCode(code))
    if (this.now() > entry.expiresAt) return { grant: null, reason: 'expired' }
    // PKCE: a code minted with a challenge redeems only with its verifier.
    // The entry is already burned, so a wrong guess cannot be retried.
    if (entry.codeChallenge !== undefined) {
      if (
        proof.codeVerifier === undefined ||
        pkceChallenge(proof.codeVerifier) !== entry.codeChallenge
      ) {
        return { grant: null, reason: 'pkce-mismatch' }
      }
    }
    if (entry.state !== undefined && proof.state !== entry.state) {
      return { grant: null, reason: 'state-mismatch' }
    }
    const { expiresAt: _expiresAt, ...grant } = entry
    return { grant, reason: null }
  }

  /** Number of not-yet-redeemed (possibly expired) codes. Test/diag aid. */
  get pendingCount(): number {
    return this.pending.size
  }

  private prune(): void {
    const cutoff = this.now()
    for (const [key, entry] of this.pending) {
      if (cutoff > entry.expiresAt) this.pending.delete(key)
    }
  }
}

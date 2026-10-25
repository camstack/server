import { userError } from '@camstack/types'
/**
 * Step-up proofs for `auth.enrollSelf` (D855).
 *
 * A signed-in user may request a device certificate for their own device, but
 * only after signing in AGAIN at that moment — however recent their session
 * is, and however many hours it has been refreshed for. The re-sign-in (a
 * password / passkey re-authentication, or the app login handoff run in
 * `step-up` purpose for any web method) yields ONE proof: purpose
 * `device-enroll`, bound to the user, 5 minutes, single use, kept only as a
 * hash. It replaces no session.
 */
import * as crypto from 'node:crypto'
import type { IScopedLogger } from '@camstack/types'

export const DEVICE_ENROLL_PROOF_TTL_MS = 5 * 60_000
const MAX_PENDING = 1_000

export type DeviceEnrollProofVerdict =
  | 'ok'
  | 'missing'
  | 'unknown-or-used'
  | 'expired'
  | 'other-user'

function hash(proof: string): string {
  return crypto.createHash('sha256').update(proof).digest('hex')
}

/** How long a spent reauth token / claimed session is remembered (past the token's own 5 min). */
const SPENT_MEMORY_MS = 6 * 60_000

export class DeviceEnrollProofs {
  private readonly pending = new Map<string, { userId: string; expiresAt: number }>()
  private readonly spentReauth = new Map<string, number>()
  private readonly claimedSessions = new Map<string, number>()

  /**
   * `claimedSessions` lives in memory, so a restart forgets which sign-ins already started a
   * step-up. To keep "once per sign-in" true across a restart, a session OPENED BEFORE this
   * process started is refused (it simply signs in again): the window is 120 s, so the cost
   * is one re-login right after a hub restart.
   */
  private readonly bootedAt: number

  constructor(
    private readonly now: () => number = Date.now,
    private readonly logger: IScopedLogger | null = null,
  ) {
    this.bootedAt = now()
  }

  mint(userId: string): { readonly proof: string; readonly expiresAt: number } {
    this.prune()
    if (this.pending.size >= MAX_PENDING)
      throw userError('server.step-up-busy', undefined, 'Too many pending step-up proofs')
    const proof = `cdp_${crypto.randomBytes(32).toString('base64url')}`
    const expiresAt = this.now() + DEVICE_ENROLL_PROOF_TTL_MS
    this.pending.set(hash(proof), { userId, expiresAt })
    return { proof, expiresAt }
  }

  /** Consume `proof` for `userId`. Burned on the first attempt whatever the verdict. */
  consume(proof: string | undefined, userId: string): DeviceEnrollProofVerdict {
    if (proof === undefined || proof === '') return this.refuse('missing', userId)
    const key = hash(proof)
    const entry = this.pending.get(key)
    if (entry === undefined) return this.refuse('unknown-or-used', userId)
    this.pending.delete(key)
    if (this.now() > entry.expiresAt) return this.refuse('expired', userId)
    if (entry.userId !== userId) return this.refuse('other-user', userId)
    return 'ok'
  }

  private refuse(verdict: DeviceEnrollProofVerdict, userId: string): DeviceEnrollProofVerdict {
    this.logger?.warn(`Device enrollment step-up proof refused: ${verdict}`, {
      tags: { userId },
      meta: { reason: verdict },
    })
    return verdict
  }

  /**
   * A reauth token feeds ONE step-up (a proof or a step-up handoff code):
   * `true` the first time, `false` for every later presentation.
   */
  consumeReauth(reauthToken: string): boolean {
    this.prune()
    const key = hash(reauthToken)
    if (this.spentReauth.has(key)) {
      this.logger?.warn('Reauth token already used for a step-up', {
        meta: { reason: 'reauth-reused' },
      })
      return false
    }
    this.spentReauth.set(key, this.now() + SPENT_MEMORY_MS)
    return true
  }

  /** A freshly authenticated session may start ONE step-up: `true` the first time. */
  claimFreshSession(sessionId: string, sessionCreatedAt: number): boolean {
    this.prune()
    if (sessionCreatedAt < this.bootedAt) {
      this.logger?.warn(
        'Step-up refused: the sign-in predates this process, so a prior claim cannot be ruled out',
        {
          meta: { reason: 'predates-boot' },
        },
      )
      return false
    }
    if (this.claimedSessions.has(sessionId)) return false
    this.claimedSessions.set(sessionId, this.now() + SPENT_MEMORY_MS)
    return true
  }

  private prune(): void {
    const at = this.now()
    for (const [k, exp] of this.spentReauth) if (at > exp) this.spentReauth.delete(k)
    for (const [k, exp] of this.claimedSessions) if (at > exp) this.claimedSessions.delete(k)
    for (const [k, v] of this.pending) if (at > v.expiresAt) this.pending.delete(k)
  }
}

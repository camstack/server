/**
 * Keeps the process's session signing key in step with the keychain (D797).
 *
 * At start it loads the key (`loadJwtSigningKey`: the stored one, or a new one
 * ONLY when none is stored) into the process slot every `AuthManager` reads.
 * While the keychain cannot answer, sessions stay unavailable — an error is
 * logged and the load is retried — and NO key is invented. A change of the
 * stored key (the operator's import, a keychain reset) reloads it; a reload
 * that cannot read the keychain keeps the key that works.
 */
import {
  getProcessJwtSigningKeyState,
  JWT_SIGNING_KEY_REF,
  type JwtSigningKeyState,
  loadJwtSigningKey,
  setProcessJwtSigningKey,
} from '../../auth/jwt-signing-key.js'
import type { SecretsAccess } from '@camstack/types'

/** How often a locked keychain is asked again. */
export const SIGNING_KEY_RETRY_MS = 30_000

interface KeeperLogger {
  info(message: string, meta?: { meta?: Record<string, unknown> }): void
  error(message: string, meta?: { meta?: Record<string, unknown> }): void
}

export interface JwtSigningKeyKeeperDeps {
  /** A keychain handle for owner `system`; `null` when this process has no keychain door. */
  readonly secrets: SecretsAccess | null
  readonly logger: KeeperLogger
  readonly retryMs?: number
}

export class JwtSigningKeyKeeper {
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribe: (() => void) | null = null
  private stopped = false

  constructor(private readonly deps: JwtSigningKeyKeeperDeps) {}

  async start(): Promise<void> {
    const secrets = this.deps.secrets
    if (secrets === null) {
      this.apply({ state: 'unavailable', reason: 'no keychain door in this process' })
      return
    }
    this.unsubscribe = secrets.onChange((ref) => {
      if (ref === JWT_SIGNING_KEY_REF) void this.load(secrets)
    })
    await this.load(secrets)
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async load(secrets: SecretsAccess): Promise<void> {
    if (this.stopped) return
    const next = await loadJwtSigningKey({ secrets })
    if (this.stopped) return
    this.apply(next)
    if (next.state === 'unavailable' && getProcessJwtSigningKeyState().state !== 'ready') {
      this.scheduleRetry(secrets)
    }
  }

  private apply(next: JwtSigningKeyState): void {
    const previous = getProcessJwtSigningKeyState()
    if (next.state === 'ready') {
      if (previous.state !== 'ready') {
        this.deps.logger.info('Session signing key loaded from the keychain')
      }
      setProcessJwtSigningKey(next)
      return
    }
    // A working key is never replaced by "unavailable".
    if (previous.state === 'ready') return
    setProcessJwtSigningKey(next)
    this.deps.logger.error(
      'Sessions are UNAVAILABLE: the session signing key cannot be read from the keychain. ' +
        'No one can sign in and no session token verifies until the keychain unlocks ' +
        '(System → Secrets; or fix keychain.keyFile in config.yaml and restart). ' +
        'No fallback key is used.',
      { meta: { reason: next.reason, ref: JWT_SIGNING_KEY_REF } },
    )
  }

  private scheduleRetry(secrets: SecretsAccess): void {
    if (this.stopped || this.retryTimer !== null) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.load(secrets)
    }, this.deps.retryMs ?? SIGNING_KEY_RETRY_MS)
    this.retryTimer.unref?.()
  }
}

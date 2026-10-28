/**
 * Bounded re-login policy for a PetKit account.
 *
 * PetKit keeps ONE session per account, so a re-login from here signs out the
 * other holder (the phone app, Home Assistant), and that holder signing back in
 * signs us out again. Re-logging in eagerly turns that into a ping-pong. The
 * gate spaces re-logins with a doubling delay and, after
 * {@link MAX_RELOGINS_IN_WINDOW} of them inside {@link KICK_WINDOW_MS}, refuses
 * until the operator re-saves the account (`reset`).
 */

/** Wait before the second re-login inside a window; doubles per attempt. */
export const RELOGIN_BASE_DELAY_MS = 5 * 60_000
/** The delay never grows past this. */
export const RELOGIN_MAX_DELAY_MS = 60 * 60_000
/** Re-logins older than this no longer count as "repeated kicks". */
export const KICK_WINDOW_MS = 6 * 60 * 60_000
/** Re-logins inside the window after which the gate stops allowing any. */
export const MAX_RELOGINS_IN_WINDOW = 3

/** What the caller may do about a lost session right now. */
export type ReloginDecision =
  | { readonly kind: 'relogin' }
  | { readonly kind: 'wait'; readonly retryAt: number }
  | { readonly kind: 'blocked'; readonly attempts: number }

/** Tunables, overridable in tests. */
export interface ReloginGateOptions {
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly windowMs?: number
  readonly maxInWindow?: number
}

export class ReloginGate {
  readonly #baseDelayMs: number
  readonly #maxDelayMs: number
  readonly #windowMs: number
  readonly #maxInWindow: number
  #attempts: number[] = []
  #blocked = false

  constructor(options: ReloginGateOptions = {}) {
    this.#baseDelayMs = options.baseDelayMs ?? RELOGIN_BASE_DELAY_MS
    this.#maxDelayMs = options.maxDelayMs ?? RELOGIN_MAX_DELAY_MS
    this.#windowMs = options.windowMs ?? KICK_WINDOW_MS
    this.#maxInWindow = options.maxInWindow ?? MAX_RELOGINS_IN_WINDOW
  }

  /** Ask to re-login at `now`. A `relogin` answer is recorded as an attempt. */
  request(now: number): ReloginDecision {
    if (this.#blocked) return { kind: 'blocked', attempts: this.#attempts.length }
    this.#attempts = this.#attempts.filter((at) => now - at < this.#windowMs)
    const count = this.#attempts.length
    if (count >= this.#maxInWindow) {
      this.#blocked = true
      return { kind: 'blocked', attempts: count }
    }
    const last = this.#attempts[count - 1]
    if (last !== undefined) {
      const delay = Math.min(this.#baseDelayMs * 2 ** (count - 1), this.#maxDelayMs)
      if (now - last < delay) return { kind: 'wait', retryAt: last + delay }
    }
    this.#attempts.push(now)
    return { kind: 'relogin' }
  }

  /** The operator re-saved the account: forget history and re-arm. */
  reset(): void {
    this.#attempts = []
    this.#blocked = false
  }
}

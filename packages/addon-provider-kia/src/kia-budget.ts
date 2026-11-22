/**
 * The daily allowance of cloud calls one Kia account may spend. The maker's cloud answers a
 * bounded number of calls a day (about two hundred); past it the whole account is refused,
 * including the half-hourly cached read every other cap depends on. So the allowance is split:
 * the calls that WAKE the car or send a command (the expensive ones, the operator's choice)
 * may use only what the scheduled reads do not need, and the scheduled reads keep a reserve
 * that nothing else can spend.
 *
 * The counter is a pure value over an injected clock, so the refusal is testable. It lives in
 * memory and restarts empty with the process: a hub that restarts often can overspend by the
 * calls it made before each restart, which the reserve is sized to absorb.
 */

/** Calls per UTC day the account is budgeted. */
export const KIA_DAILY_CALL_LIMIT = 200

/**
 * Calls only the scheduled reads (and a login) may spend: 48 half-hourly reads, a handful of
 * logins and a margin for the connection test.
 */
export const KIA_SCHEDULED_RESERVE = 60

/** What one operation is estimated to cost the quota (cloud calls, polls included). */
export const KIA_CALL_COST = { login: 1, read: 1, force: 3, command: 8 } as const
export type KiaCallKind = keyof typeof KIA_CALL_COST

const DAY_MS = 86_400_000

export type KiaBudgetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'budget-exhausted'; readonly retryAt: number }

export interface KiaCallBudgetOptions {
  readonly limit?: number
  readonly reserve?: number
  readonly now?: () => number
}

/** Scheduled operations may spend the reserve; the others may not. */
function isScheduled(kind: KiaCallKind): boolean {
  return kind === 'read' || kind === 'login'
}

export class KiaCallBudget {
  readonly #limit: number
  readonly #reserve: number
  readonly #now: () => number
  #day: number
  #used = 0

  constructor(options: KiaCallBudgetOptions = {}) {
    this.#limit = options.limit ?? KIA_DAILY_CALL_LIMIT
    this.#reserve = options.reserve ?? KIA_SCHEDULED_RESERVE
    this.#now = options.now ?? Date.now
    this.#day = this.#dayOf(this.#now())
  }

  #dayOf(at: number): number {
    return Math.floor(at / DAY_MS)
  }

  #rollOver(): void {
    const today = this.#dayOf(this.#now())
    if (today === this.#day) return
    this.#day = today
    this.#used = 0
  }

  /** Calls spent so far today (UTC). */
  used(): number {
    this.#rollOver()
    return this.#used
  }

  /** May an operation of this kind run now? Does not spend. */
  check(kind: KiaCallKind): KiaBudgetVerdict {
    this.#rollOver()
    const ceiling = isScheduled(kind) ? this.#limit : this.#limit - this.#reserve
    if (this.#used + KIA_CALL_COST[kind] <= ceiling) return { ok: true }
    return { ok: false, reason: 'budget-exhausted', retryAt: (this.#day + 1) * DAY_MS }
  }

  /** The cloud itself said the day is spent: nothing runs until the next UTC day. */
  exhaust(): void {
    this.#rollOver()
    this.#used = this.#limit
  }

  /** Record that an operation of this kind ran (a refused one is never spent). */
  spend(kind: KiaCallKind): void {
    this.#rollOver()
    this.#used += KIA_CALL_COST[kind]
  }
}

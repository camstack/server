/**
 * A boot read the composer must trust before it withdraws anything (D49): the
 * rows it owns (`WithdrawalGate.seed`) and the claims it holds (`ClaimGate.seed`).
 *
 * A read that FAILS answers nothing — not `[]` — and is retried on the next
 * apply, which the supervisor's converge drives (never a timer, D3). An EMPTY
 * answer is the destroying direction: a cold registry and a cold index both
 * answer `[]`, and a seed trusted from it would let the next apply sweep every
 * row or release every claim nobody planned yet. So `[]` is trusted only when
 * the next apply's read agrees, and a failed read in between breaks the
 * agreement. Warned once per run of refused applies, not once per apply.
 */
import type { IScopedLogger } from '@camstack/types'

export interface SeedItems<T> {
  readonly kind: 'items'
  readonly items: readonly T[]
}
export interface SeedUnknown {
  readonly kind: 'unknown'
  readonly error: string
}
export type SeedRead<T> = SeedItems<T> | SeedUnknown

export interface ConfirmedSeedDeps<T> {
  readonly logger: IScopedLogger
  /** What this seed is about, for its log lines: `rows`, `claims`. */
  readonly subject: string
  readonly read: () => Promise<SeedRead<T>>
  readonly onSeeded: (items: readonly T[]) => void
  /** The reason a block waits while the read failed / answered `[]` once. */
  readonly unreadReason: string
  readonly emptyUnconfirmedReason: string
}

export class ConfirmedSeed<T> {
  private seeded = false
  /** The previous read answered `[]`: one more `[]` confirms it (D49). */
  private emptySeen = false
  /** Consecutive applies whose read did not answer: warned once per run. */
  private waitApplies = 0

  constructor(private readonly deps: ConfirmedSeedDeps<T>) {}

  get done(): boolean {
    return this.seeded
  }

  /** Null once seeded, else why this apply must wait. */
  async ensure(): Promise<string | null> {
    if (this.seeded) return null
    const read = await this.deps.read()
    if (read.kind === 'unknown') {
      this.emptySeen = false
      this.waitApplies += 1
      if (this.waitApplies === 1) {
        this.deps.logger.warn(
          `composer: the ${this.deps.subject} could not be read — nothing is declared, withdrawn, claimed or released from them; retried on the next apply`,
          { meta: { subject: this.deps.subject, error: read.error } },
        )
      }
      return this.deps.unreadReason
    }
    if (read.items.length === 0 && !this.emptySeen) {
      this.emptySeen = true
      this.deps.logger.warn(
        `composer: the ${this.deps.subject} read empty — waiting for the next apply's read to agree before trusting it`,
        { meta: { subject: this.deps.subject } },
      )
      return this.deps.emptyUnconfirmedReason
    }
    this.deps.onSeeded(read.items)
    this.seeded = true
    this.deps.logger.info(`composer: seeded from the ${this.deps.subject}`, {
      meta: {
        subject: this.deps.subject,
        items: read.items.length,
        confirmedEmpty: read.items.length === 0,
        appliesRefused: this.waitApplies,
      },
    })
    return null
  }
}

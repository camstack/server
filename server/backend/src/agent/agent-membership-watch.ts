/**
 * A refused agent finds out it was forgotten, and starts over (D857).
 *
 * The mesh refuses a revoked leaf without a word, so an agent whose hub was reset, forgotten or
 * unpaired would retry forever. While this agent is paired but NOT connected to its hub, it asks the
 * hub whether it is still a member (`askHubMembership`), and resets itself to `unpaired` only on a
 * CA-signed `revoked` answer confirmed by a SECOND read some seconds later (D49: a fallible read never
 * destroys). `member`, `unknown`, a network error or an unverifiable answer change nothing and restart
 * the count - a hub that is merely down must never cost an agent its pairing.
 *
 * Pure of timers and I/O: `tick(now)` is driven by the caller (a `setInterval` in `main.ts`).
 */
import type { HubMembershipResult } from './hub-membership-client'

export interface AgentMembershipWatchDeps {
  /** `agent.json` holds mesh material. */
  readonly isPaired: () => boolean
  /** The broker sees the hub as available. */
  readonly isConnected: () => boolean
  readonly ask: () => Promise<HubMembershipResult>
  /** The hub said the leaf is revoked, twice: discard the pairing and become pairable again. */
  readonly onRevoked: (reason: string) => Promise<void>
  readonly log: {
    warn(
      message: string,
      extras?: {
        tags?: Record<string, string>
        meta?: Record<string, unknown>
      },
    ): void
    info(
      message: string,
      extras?: {
        tags?: Record<string, string>
        meta?: Record<string, unknown>
      },
    ): void
  }
  readonly nodeId: string
  /** Not connected for this long before the first question (a restart / a blip is not a refusal). */
  readonly graceMs?: number
  /** Between questions while nothing is revoked. */
  readonly askIntervalMs?: number
  /** Between the first `revoked` answer and the confirming one. */
  readonly confirmDelayMs?: number
}

export const DEFAULT_MEMBERSHIP_GRACE_MS = 90_000
export const DEFAULT_MEMBERSHIP_ASK_INTERVAL_MS = 60_000
export const DEFAULT_MEMBERSHIP_CONFIRM_DELAY_MS = 15_000
/** `revoked` answers in a row that destroy the pairing. */
const REVOKED_READS_REQUIRED = 2

export class AgentMembershipWatch {
  private disconnectedSince: number | null = null
  private lastAskAt: number | null = null
  private revokedReads = 0
  private asking = false

  constructor(private readonly deps: AgentMembershipWatchDeps) {}

  /** One step. Resolves once any question this step asked has been handled. */
  async tick(now: number): Promise<void> {
    if (this.asking) return
    if (!this.deps.isPaired() || this.deps.isConnected()) {
      this.reset()
      return
    }
    this.disconnectedSince ??= now
    if (now - this.disconnectedSince < (this.deps.graceMs ?? DEFAULT_MEMBERSHIP_GRACE_MS)) return
    const interval =
      this.revokedReads > 0
        ? (this.deps.confirmDelayMs ?? DEFAULT_MEMBERSHIP_CONFIRM_DELAY_MS)
        : (this.deps.askIntervalMs ?? DEFAULT_MEMBERSHIP_ASK_INTERVAL_MS)
    if (this.lastAskAt !== null && now - this.lastAskAt < interval) return
    this.lastAskAt = now
    this.asking = true
    try {
      await this.handle(await this.deps.ask())
    } finally {
      this.asking = false
    }
  }

  private reset(): void {
    this.disconnectedSince = null
    this.lastAskAt = null
    this.revokedReads = 0
  }

  private async handle(result: HubMembershipResult): Promise<void> {
    const tags = { nodeId: this.deps.nodeId }
    if (result.kind === 'unreachable') {
      this.revokedReads = 0
      this.deps.log.info(
        'could not ask the hub whether this agent is still a member - keeping the pairing',
        {
          tags,
          meta: { error: result.error },
        },
      )
      return
    }
    const { status, reason } = result.answer
    if (status !== 'revoked') {
      this.revokedReads = 0
      this.deps.log.info(
        `the hub answered "${status}" to the membership question - keeping the pairing`,
        {
          tags,
        },
      )
      return
    }
    this.revokedReads += 1
    const why = reason ?? 'revoked'
    if (this.revokedReads < REVOKED_READS_REQUIRED) {
      this.deps.log.warn(
        `the hub says this agent's certificate is revoked (${why}) - asking once more before resetting`,
        {
          tags,
          meta: { reason: why },
        },
      )
      return
    }
    this.deps.log.warn(
      `the hub confirmed twice that this agent's certificate is revoked (${why}) - discarding the pairing and becoming pairable again`,
      { tags, meta: { reason: why } },
    )
    this.reset()
    await this.deps.onRevoked(why)
  }
}

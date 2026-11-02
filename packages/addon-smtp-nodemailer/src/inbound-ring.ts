import {
  SMTP_INBOUND_RING_MAX_AGE_MS,
  SMTP_INBOUND_RING_MAX_MESSAGES,
  type SmtpInboundMessage,
  type SmtpInboundSince,
} from '@camstack/types'

export type DraftMessage = Omit<SmtpInboundMessage, 'seq'>

interface RingEntry {
  readonly key: string
  readonly message: SmtpInboundMessage
}

export interface RingLimits {
  readonly maxMessages: number
  readonly maxAgeMs: number
}

export const DEFAULT_RING_LIMITS: RingLimits = {
  maxMessages: SMTP_INBOUND_RING_MAX_MESSAGES,
  maxAgeMs: SMTP_INBOUND_RING_MAX_AGE_MS,
}

/**
 * The bounded memory of one mailbox: the last N messages for at most M minutes, each with a seq
 * that only grows. Events are telemetry (D8); a consumer that sees a gap in `seq` replays from here.
 * The seq is not persisted: a restart starts again at 1, and `lastSeq` tells a consumer it went back.
 */
export class MessageRing {
  private entries: RingEntry[] = []
  private seq = 0

  constructor(
    private readonly limits: RingLimits = DEFAULT_RING_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  push(key: string, draft: DraftMessage): SmtpInboundMessage {
    this.seq += 1
    const message: SmtpInboundMessage = { ...draft, seq: this.seq }
    this.entries.push({ key, message })
    this.prune()
    return message
  }

  since(seq: number): SmtpInboundSince {
    this.prune()
    const first = this.entries[0]
    return {
      lastSeq: this.seq,
      oldestSeq: first === undefined ? 0 : first.message.seq,
      messages: this.entries.filter((e) => e.message.seq > seq),
    }
  }

  private prune(): void {
    const floor = this.now() - this.limits.maxAgeMs
    this.entries = this.entries
      .filter((e) => e.message.receivedAt >= floor)
      .slice(-this.limits.maxMessages)
  }
}

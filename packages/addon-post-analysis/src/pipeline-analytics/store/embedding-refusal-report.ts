/**
 * Refused object embeddings, reported as a COUNT per (camera, model, reason).
 *
 * A refusal here is systemic, never per-track: when a runner stamps the wrong
 * model, EVERY vector it sends is refused, at track rate, on every camera. On
 * 2026-09-27 the per-track WARN wrote 178 identical lines in twenty minutes and
 * the one fact that mattered — "no CLIP vector has been stored since 09:38" —
 * was a count nobody could read off them (D658).
 *
 * So: the FIRST refusal of a key logs at once (the operator sees the onset),
 * then at most one line per interval per key, carrying how many were refused
 * since the previous line. A key with refusals still pending is reported by the
 * next {@link EmbeddingRefusalReport.sweep} past its interval — the store sweeps
 * on every write, so a tail is never swallowed while the store is in use — and
 * {@link EmbeddingRefusalReport.flush} reports everything left.
 */
import type { IScopedLogger } from '@camstack/types'

/** Why an object embedding was not written. */
export type EmbeddingRefusalReason =
  /** The vector's length is not the dimension its model's metadata declares. */
  | 'dimension-mismatch'
  /** The model named has no CLIP metadata — there is no index for it. */
  | 'no-clip-metadata'
  /** The result named no model at all — nothing may guess one (D658). */
  | 'no-model-id'

/** One refusal, with what the line needs to be actionable. */
export interface EmbeddingRefusal {
  readonly deviceId: number
  /** `null` only for `no-model-id`. */
  readonly modelId: string | null
  readonly reason: EmbeddingRefusalReason
  readonly trackId: string
  /** The vector's length, when there was one to measure. */
  readonly dim?: number
  /** What the model's metadata declares, for `dimension-mismatch`. */
  readonly expected?: number
}

/** One line per interval per key — five minutes, like the encoder refusals (D649). */
const DEFAULT_EMBEDDING_REFUSAL_REPORT_INTERVAL_MS = 300_000

const MESSAGES: Readonly<Record<EmbeddingRefusalReason, string>> = {
  'dimension-mismatch': "object embeddings refused — their length is not their model's dimension",
  'no-clip-metadata': 'object embeddings refused — the model has no CLIP metadata',
  'no-model-id': 'object embeddings refused — the result names no model',
}

interface PendingKey {
  readonly last: EmbeddingRefusal
  /** Refusals since the previous line for this key. */
  readonly pending: number
  /** When this key last wrote a line. */
  readonly lastLineAtMs: number
}

export interface EmbeddingRefusalReportOptions {
  readonly logger: Pick<IScopedLogger, 'warn'>
  readonly intervalMs?: number
  readonly now?: () => number
}

function keyOf(r: EmbeddingRefusal): string {
  return `${String(r.deviceId)}|${r.modelId ?? ''}|${r.reason}`
}

export class EmbeddingRefusalReport {
  private readonly logger: Pick<IScopedLogger, 'warn'>
  private readonly intervalMs: number
  private readonly now: () => number
  private keys = new Map<string, PendingKey>()

  constructor(options: EmbeddingRefusalReportOptions) {
    this.logger = options.logger
    this.intervalMs = options.intervalMs ?? DEFAULT_EMBEDDING_REFUSAL_REPORT_INTERVAL_MS
    this.now = options.now ?? (() => Date.now())
  }

  /** Count one refusal; write a line if this key is new or its interval passed. */
  note(refusal: EmbeddingRefusal): void {
    const key = keyOf(refusal)
    const at = this.now()
    const held = this.keys.get(key)
    const pending = (held?.pending ?? 0) + 1
    if (held === undefined || at - held.lastLineAtMs >= this.intervalMs) {
      this.write(refusal, pending, held === undefined ? 'first' : 'interval')
      this.keys = new Map(this.keys).set(key, { last: refusal, pending: 0, lastLineAtMs: at })
      return
    }
    this.keys = new Map(this.keys).set(key, { ...held, last: refusal, pending })
  }

  /** Report every key whose interval passed with refusals still pending. */
  sweep(): void {
    const at = this.now()
    for (const [key, held] of this.keys) {
      if (held.pending === 0 || at - held.lastLineAtMs < this.intervalMs) continue
      this.write(held.last, held.pending, 'interval')
      this.keys = new Map(this.keys).set(key, { ...held, pending: 0, lastLineAtMs: at })
    }
  }

  /** Report every pending count now, whatever its interval (shutdown). */
  flush(): void {
    for (const held of this.keys.values()) {
      if (held.pending > 0) this.write(held.last, held.pending, 'flush')
    }
    this.keys = new Map()
  }

  private write(
    r: EmbeddingRefusal,
    refused: number,
    closing: 'first' | 'interval' | 'flush',
  ): void {
    this.logger.warn(MESSAGES[r.reason], {
      tags: { deviceId: r.deviceId },
      meta: {
        reason: r.reason,
        modelId: r.modelId,
        refused,
        windowMs: this.intervalMs,
        closing,
        lastTrackId: r.trackId,
        ...(r.dim !== undefined ? { dim: r.dim } : {}),
        ...(r.expected !== undefined ? { expected: r.expected } : {}),
      },
    })
  }
}

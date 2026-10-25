/**
 * Which CLIP model the encoder serves when a caller does not name one: the
 * CLUSTER ROW (`clusterModel:clip-embedding`), not this addon's own config.
 *
 * ## Why
 *
 * Every writer of the object-embedding index is pinned to the cluster row: the
 * live detail plane, the rebuild (`rebuildObjectEmbeddings`) and the search's
 * same-model gate all resolve `clip-embedding` from it. The text encoder was the
 * one reader that did not — it encoded with `config.modelId`, a free-text field
 * nobody changes — so flipping the cluster to another model would have ranked
 * that model's image vectors with MobileCLIP text queries, with nothing in any
 * log (D649; the spike's blocker 6).
 *
 * ## The read discipline (D49)
 *
 * The row is re-read at most every {@link ENCODER_ROW_TTL_MS}. A read that FAILS
 * changes nothing: the last value that was read stays in force, and only before
 * any read has ever succeeded does the addon config answer. A failed read never
 * swaps the encoder to a guess.
 */
import type { IScopedLogger } from '@camstack/types'

/** How long a cluster-row read is trusted. The operator's flip lands within this. */
export const ENCODER_ROW_TTL_MS = 30_000

export interface ActiveClipModelDeps {
  /** The cluster row's `clip-embedding` model, or `null` when unreadable. */
  readonly readRow: () => Promise<string | null>
  /** The addon config's model — the answer before any read has succeeded. */
  readonly fallbackModelId: () => string
  readonly now: () => number
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  /**
   * Called when a successful read names a DIFFERENT model than the last one —
   * a model change, which clears the towers' `failed` state (D6 budget).
   */
  readonly onChange?: (modelId: string, previous: string) => void
}

export class ActiveClipModel {
  private cached: { readonly modelId: string; readonly at: number } | null = null
  private lastRead: string | null = null

  constructor(private readonly deps: ActiveClipModelDeps) {}

  /**
   * The last row a read RETURNED, without reading — `null` while no read has
   * ever succeeded (the config fallback is a guess, not a known model). The
   * idle sweep exempts this model's text tower (`clip-text-engines.ts`).
   */
  known(): string | null {
    return this.lastRead
  }

  async get(): Promise<string> {
    const now = this.deps.now()
    if (this.cached !== null && now - this.cached.at < ENCODER_ROW_TTL_MS) {
      return this.cached.modelId
    }
    const row = await this.deps.readRow()
    if (row === null) {
      // `resolveClusterModelPin` already warned with the cause. Say what WE did.
      const kept = this.lastRead ?? this.deps.fallbackModelId()
      this.deps.logger.warn('CLIP encoder kept its model — the cluster row could not be read', {
        meta: { modelId: kept, source: this.lastRead !== null ? 'last-read' : 'addon-config' },
      })
      // Not cached: the next call asks again rather than trusting the fallback for a TTL.
      return kept
    }
    const previous = this.lastRead
    if (row !== previous) {
      this.deps.logger.info('CLIP encoder follows the cluster model', {
        meta: { modelId: row, previous },
      })
    }
    this.lastRead = row
    this.cached = { modelId: row, at: now }
    if (previous !== null && row !== previous) this.deps.onChange?.(row, previous)
    return row
  }
}

/**
 * Filing a notification digest's MOSAIC, and bounding how many a rule keeps.
 *
 * ## Why this file exists (D480)
 *
 * The mosaic is filed where event media lives — the operator's directive: same
 * structure, same storage location, no second retained store. What it did NOT
 * have was an owner. It was written under a synthetic id
 * (`summary-<ruleId>-<windowEndMs>`) borrowing whichever owner kind was handy:
 * `'event'` first, then `'object'` after D476. No table has ever held either
 * id, so every probe answered "the owner is gone" or "I cannot resolve this",
 * and nothing could safely collect it. Measured on the live hub: 675 rows,
 * 271 MiB, one camera, one rule, growing ~27 MiB/day, none of it collectable.
 *
 * So the mosaic gets its own owner kind and its own bound, and both live HERE,
 * with the writer:
 *
 *  - the owner id is the RULE id, so `(ownerKind, ownerId)` names something
 *    real and `idx_media_owner` answers "what does this rule hold" in one
 *    index range;
 *  - everything older than the configured window is deleted through
 *    `deleteConfirmed` — unlink, re-probe, then drop the row —
 *    so a bound that cannot delete the bytes does not silently drop the row
 *    that names them;
 *  - the sweeper is told to keep its hands off (`writer-bounded`), because a
 *    sweep probing a table an id was never in is the mistake, not the cure.
 *
 * This is the shape `boundReferences` already uses for a scene's reference
 * pictures.
 *
 * ## The bound was a COUNT until 2026-09-13 (D485)
 *
 * D480 argued a writer-imposed limit has no clock, and that there is exactly
 * one age-keyed sweep in this system (D61). That argument was about the SWEEP,
 * and it still holds: this is not a sweep, and nothing else was given a
 * schedule. What changed is the operator's ask — they want to say how many DAYS
 * of digests they keep, in the same units as every other window on the page.
 * The bound still runs on the write path, still belongs to the writer, and the
 * sweeper is still told to keep its hands off.
 */

import type { IScopedLogger, MediaFileRef } from '@camstack/types'
import type { MediaDeleteCount } from '../../pipeline-analytics/store/media-store.js'
import { SUMMARY_MOSAIC_OWNER_KIND } from '../../pipeline-analytics/store/media-store.js'

/**
 * How long ONE rule's mosaics live, when the caller passes no window.
 *
 * This REPLACES a count bound of 200 per rule (D480), on the operator's
 * instruction — see D485. The mechanism changed, not just the number, and the
 * arithmetic from the live hub says the two are not interchangeable: the
 * busiest rule makes ~66 mosaics and ~27 MiB a day, so 14 days is ~370 MiB for
 * it against ~80 MiB before. A quiet rule (one digest a night) moves the other
 * way, from over six months of history to 14 days.
 *
 * It is a FALLBACK, not the authority: the configured window arrives from
 * `resolvePruneWindows` and this is what a caller with nothing configured gets.
 */
export const SUMMARY_MOSAIC_DEFAULT_WINDOW_MS = 14 * 24 * 3600_000

/** The mosaic's owner id: the rule itself. Nothing synthetic, nothing parsed. */
export function mosaicOwnerId(ruleId: string): string {
  return ruleId
}

/** What the writer needs to file a mosaic and hold its rule to the bound. */
export interface SummaryMosaicPorts {
  /**
   * `MediaStore.put`, with the owner kind ALREADY decided.
   *
   * There is deliberately no `ownerKind` parameter: the one way this went
   * wrong twice was a caller choosing a kind. The type is what stops a third.
   */
  readonly put: (input: {
    readonly deviceId: number
    readonly ownerId: string
    readonly timestamp: number
    readonly jpeg: Buffer
  }) => Promise<number>
  /** Index rows for one `(mosaic, ruleId)` pair — never the bytes. */
  readonly listInfo: (ownerId: string) => Promise<readonly MediaFileRef[]>
  /** `MediaStore.deleteConfirmed` — unlink, re-probe, then drop the row.
   *  Takes the rowid: a media row is addressed by its own id (D482). */
  readonly deleteConfirmed: (mediaId: number) => Promise<MediaDeleteCount>
  readonly logger: IScopedLogger
}

/**
 * Which of a rule's mosaics the bound evicts — pure, so the rule is testable
 * without a store.
 *
 * Newest-first by timestamp; ties broken by key so the answer is stable. The
 * order is explicit because the store's own `listInfo` answers oldest-first
 * and a bound that trusted the caller's order would delete the newest N.
 */
export type MosaicEvictionRule =
  /** Everything this rule holds — the rule itself was deleted. */
  | { readonly all: true }
  /**
   * Everything written strictly BEFORE this instant. `null` means there is no
   * cutoff, i.e. the operator set the window to 0 ("keep forever"), and it must
   * never be read as "keep zero of them".
   */
  | { readonly olderThanMs: number | null }

export function mosaicsToEvict(
  rows: readonly MediaFileRef[],
  rule: MosaicEvictionRule,
): readonly MediaFileRef[] {
  if ('all' in rule) return [...rows]
  const cutoff = rule.olderThanMs
  if (cutoff === null) return []
  // Strictly older: a row written AT the cutoff is not yet old, or a digest
  // delivered this instant can lose the mosaic it is still showing.
  return rows.filter((r) => r.timestamp < cutoff)
}

/** What one bound pass removed. `bytes` is what the deletes CONFIRMED. */
export interface SummaryMosaicBoundResult {
  readonly evicted: number
  readonly failed: number
  readonly bytes: number
}

/**
 * Hold one rule to the bound. Best-effort per row and LOUD about a row it
 * could not delete: a mosaic whose blob would not go keeps its index row, so
 * the next pass sees it again instead of leaving bytes nothing names.
 */
export async function boundRuleMosaics(
  ports: SummaryMosaicPorts,
  input: { readonly ruleId: string; readonly rule: MosaicEvictionRule },
): Promise<SummaryMosaicBoundResult> {
  const ownerId = mosaicOwnerId(input.ruleId)
  const rows = await ports.listInfo(ownerId)
  const doomed = mosaicsToEvict(rows, input.rule)
  let evicted = 0
  let failed = 0
  let bytes = 0
  for (const row of doomed) {
    try {
      const count = await ports.deleteConfirmed(row.mediaId)
      evicted += count.rows
      bytes += count.bytes
    } catch (err: unknown) {
      failed += 1
      ports.logger.warn(
        'summary mosaic bound: a mosaic was kept — its blob could not be confirmed gone',
        {
          meta: { ruleId: input.ruleId, mediaId: row.mediaId, error: String(err) },
        },
      )
    }
  }
  if (doomed.length > 0) {
    ports.logger.info('summary mosaic bound', {
      meta: {
        ruleId: input.ruleId,
        held: rows.length,
        rule: 'all' in input.rule ? 'all' : { olderThanMs: input.rule.olderThanMs },
        evicted,
        failed,
        bytes,
      },
    })
  }
  return { evicted, failed, bytes }
}

/**
 * File one mosaic and immediately hold its rule to the bound.
 *
 * The bound runs on the WRITE path on purpose. A bound enforced by a separate
 * schedule is a second sweep with its own reasons not to run, and this record
 * exists because the sweep that was supposed to cover these rows did not run
 * over them for ten days.
 *
 * Returns the media key, or `null` when the file did not land — the caller's
 * contract is unchanged: a mosaic that could not be filed never costs the
 * notification that carries it.
 */
export async function fileSummaryMosaic(
  ports: SummaryMosaicPorts,
  input: {
    readonly deviceId: number
    readonly ruleId: string
    readonly timestamp: number
    readonly jpeg: Buffer
    /**
     * The configured window. Absent falls back to the shipped default; `null`
     * is the operator's "keep forever" and evicts nothing.
     */
    readonly olderThanMs?: number | null
  },
): Promise<number | null> {
  const ownerId = mosaicOwnerId(input.ruleId)
  const mediaId = await ports.put({
    deviceId: input.deviceId,
    ownerId,
    timestamp: input.timestamp,
    jpeg: input.jpeg,
  })
  // The bound must never cost the write that just succeeded.
  try {
    await boundRuleMosaics(ports, {
      ruleId: input.ruleId,
      rule: {
        olderThanMs:
          input.olderThanMs === undefined
            ? input.timestamp - SUMMARY_MOSAIC_DEFAULT_WINDOW_MS
            : input.olderThanMs,
      },
    })
  } catch (err: unknown) {
    ports.logger.warn(
      'summary mosaic bound could not run — the rule may hold more than its bound',
      {
        meta: { ruleId: input.ruleId, ownerKind: SUMMARY_MOSAIC_OWNER_KIND, error: String(err) },
      },
    )
  }
  return mediaId
}

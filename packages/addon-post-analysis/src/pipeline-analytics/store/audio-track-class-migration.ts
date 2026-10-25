/**
 * The one-shot D189 migration: naked audio macros on `tracks.className` → the
 * taxonomy macro `audio`.
 *
 * Every audio-sourced track written before D189 carries the class it HEARD
 * (`speech`, `animal`, `water`) in the column that names what the subject IS —
 * so `className: 'animal'` meant a COCO quadruped on one row and a barking dog
 * on the next. The contract (`audio-track-class.ts`) is that an audio row says
 * `audio` and the heard class lives on `audioLabels`, exactly as it does on a
 * REGULAR track.
 *
 * **The information is already where it belongs.** Measured on the live hub:
 * 576 audio rows over 30 days, 100% of them carrying `audioLabels`. So this
 * pass does not RECOVER anything — it rewrites a class whose true value is not
 * in question. The `audioLabels` back-stop below exists only so the rewrite can
 * never be the step that destroys the sole copy of what was heard, on a row
 * shaped in some way the census did not see.
 *
 * **Why migrate at all, when the read already normalizes?**
 * `TrackStore.rowToTrack` applies the contract on hydration, so correctness
 * does not wait for this pass. But a permanent read compat is a second format
 * living on disk forever, and this repo has decided twice that it will not
 * carry those (D182, D185). The pass converges the disk so the read-side
 * normalization becomes provably dead and can be DELETED — the same arc the
 * object-embedding boot backfill completed and was removed for.
 *
 * Same machinery as {@link runLabelTierMigration}, and for the same reasons:
 * stateless (answers from the row alone — no media, no model, no node), paged,
 * bounded, idempotent, resumable, marker-gated, and run OFF the readiness path.
 */

import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import type { MigrationMarkerPort } from './migration-marker-store.js'
import { AUDIO_TRACK_CLASS } from './audio-track-class.js'

/** Rows read (and at most rewritten) per page. */
const AUDIO_CLASS_MIGRATION_PAGE_SIZE = 500

/**
 * Hard bound on rows visited in ONE run. The pass runs at addon initialize; a
 * fleet-scale tracks table must not turn a boot into an hour of writes. What is
 * not reached this run is reached the next, because the marker is only written
 * when the pass completed without truncating.
 */
const AUDIO_CLASS_MIGRATION_MAX_ROWS = 200_000

/** The marker's id in the `migrations` record kind (see `MigrationMarkerStore`). */
export const AUDIO_CLASS_MIGRATION_MARKER_KEY = 'audio-track-class-d189'

/** What the pass did. */
export interface AudioClassMigrationStats {
  readonly collection: string
  /** Rows examined. */
  readonly scanned: number
  /** Audio rows rewritten to the taxonomy macro. */
  readonly rewritten: number
  /** Of those, rows that had no `audioLabels` and were given one from the
   *  naked class. Expected to be 0 — a non-zero value is worth a look. */
  readonly labelsRecovered: number
  /** Non-audio rows, and audio rows already speaking the contract. */
  readonly skipped: number
  /** The bound was hit — another run is needed. */
  readonly truncated: boolean
}

interface AudioClassMigrationDeps {
  readonly store: SettingsStoreClient
  /** Where the completion marker is read and written. */
  readonly markers: MigrationMarkerPort
  readonly logger: IScopedLogger
  /** Injected so a test can freeze it. */
  readonly now: () => number
}

/**
 * The decision for ONE stored row, exposed so the rule is testable without a
 * store. `null` = leave the row alone.
 *
 * Reads the RAW row rather than a hydrated `Track` on purpose: this is the
 * column the pass rewrites, and hydrating through `rowToTrack` would apply the
 * read-side normalization and hide the very rows it is looking for.
 */
export function decideAudioClassRowMigration(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  if (data['source'] !== 'audio') return null
  const className = data['className']
  if (typeof className !== 'string' || className.length === 0) return null
  if (className === AUDIO_TRACK_CLASS) return null

  const stored = data['audioLabels']
  const hasLabels = Array.isArray(stored) && stored.length > 0
  if (hasLabels) return { className: AUDIO_TRACK_CLASS }

  const firstSeen = typeof data['firstSeen'] === 'number' ? data['firstSeen'] : 0
  const lastSeen = typeof data['lastSeen'] === 'number' ? data['lastSeen'] : firstSeen
  return {
    className: AUDIO_TRACK_CLASS,
    // No score: nothing on the row measured this. Left at 0 rather than
    // invented — the same reasoning the label-tier pass applies to its scores.
    audioLabels: [
      { label: className, peakScore: 0, count: 1, firstAt: firstSeen, lastAt: lastSeen },
    ],
  }
}

/**
 * Run the pass over the tracks collection, once.
 *
 * The marker short-circuits a completed migration; it is written only when the
 * pass did NOT truncate, so an interrupted run resumes on the next boot instead
 * of declaring itself done.
 */
export async function runAudioTrackClassMigration(
  deps: AudioClassMigrationDeps,
  collection: string,
): Promise<AudioClassMigrationStats | null> {
  try {
    if (await deps.markers.has(AUDIO_CLASS_MIGRATION_MARKER_KEY)) return null
  } catch {
    // No marker collection yet — first run. Not an error.
  }

  let scanned = 0
  let rewritten = 0
  let labelsRecovered = 0
  let skipped = 0
  let offset = 0
  let truncated = false

  for (;;) {
    if (scanned >= AUDIO_CLASS_MIGRATION_MAX_ROWS) {
      truncated = true
      break
    }
    const rows = await deps.store.query.query({
      collection,
      filter: { limit: AUDIO_CLASS_MIGRATION_PAGE_SIZE, offset },
    })
    if (rows.length === 0) break
    for (const row of rows) {
      scanned++
      const patch = decideAudioClassRowMigration(row.data)
      if (patch === null) {
        skipped++
        continue
      }
      const deviceId = typeof row.data['deviceId'] === 'number' ? row.data['deviceId'] : undefined
      try {
        await deps.store.update.mutate({ collection, id: row.id, data: patch })
        rewritten++
        if (patch['audioLabels'] !== undefined) labelsRecovered++
      } catch (err) {
        // A row that fails is left as it was and retried next run: the decision
        // is idempotent, so a partial pass is never a wrong pass. It is LOGGED
        // — a rewrite that silently declined would look exactly like a row that
        // was never legacy.
        deps.logger.warn('audio track class migration row failed', {
          ...(deviceId !== undefined ? { tags: { deviceId } } : {}),
          meta: { collection, id: row.id, error: err instanceof Error ? err.message : String(err) },
        })
        skipped++
      }
    }
    if (rows.length < AUDIO_CLASS_MIGRATION_PAGE_SIZE) break
    offset += rows.length
  }

  if (!truncated) {
    try {
      await deps.markers.set(AUDIO_CLASS_MIGRATION_MARKER_KEY, {
        completedAt: deps.now(),
        rewritten,
      })
    } catch (err) {
      // Losing the marker costs a re-scan, never correctness.
      deps.logger.warn('audio track class migration marker failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  const stats: AudioClassMigrationStats = {
    collection,
    scanned,
    rewritten,
    labelsRecovered,
    skipped,
    truncated,
  }
  deps.logger.info('audio track class migration', {
    meta: { ...stats },
  })
  return stats
}

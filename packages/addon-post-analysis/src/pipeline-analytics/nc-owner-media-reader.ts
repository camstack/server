/**
 * The notification centre's in-process media read — the production
 * `NcDispatcherDeps.getMediaForOwner` (D694).
 *
 * A named factory rather than a closure in `index.ts` because this is the hop
 * where the camera and generation filter actually takes effect: the dispatcher
 * and the centre's wrapper only CARRY the scope, and a closure that dropped it
 * left every spec green (fix round 1, M1). It is specced against a real
 * `MediaStore` holding two records' rows under one `object` owner id.
 *
 * - `track` owners resolve through the fusion alias store first (D683): a
 *   delivery after a fusion must reach the survivor's stills.
 * - `object` owners are a reusable event ROWID (D474). The scope is REQUIRED:
 *   the read is narrowed to the scope's camera in the store and then to rows
 *   stamped with the event's own timestamp, which is what the only `object`
 *   media writer (`event-media-dispatcher.ts` `writeEventMedia`) stamps. An
 *   unscoped object read returns nothing and ERROR-logs — the compatibility
 *   path that listed every row of the id is closed. Rows of the same id that
 *   fail the generation test belong to another record and are refused out loud.
 */

import type { IScopedLogger, MediaFileBytes } from '@camstack/types'
import type { NcDispatcherDeps } from '../notification-center/dispatcher.js'
import type { NcEventMediaScope } from '../notification-center/outbox-key.js'
import type { MediaKind, OwnerKind } from './store/media-store.js'

/** The production read, exactly as the dispatcher declares it. */
export type NcOwnerMediaRead = NcDispatcherDeps['getMediaForOwner']

/** The one `MediaStore` method this read needs. */
export interface NcOwnerMediaLister {
  listByOwner(
    ownerKind: OwnerKind,
    ownerId: string,
    deviceId?: number,
    kinds?: readonly MediaKind[],
  ): Promise<readonly MediaFileBytes[]>
}

export interface NcOwnerMediaReaderDeps {
  readonly media: NcOwnerMediaLister
  /** A `track` owner id → the id to read (its fusion survivor, or itself). */
  readonly resolveTrackOwnerId: (trackId: string) => Promise<string>
  readonly logger: IScopedLogger
}

/** Keep only the rows written for THIS generation of the event id. */
function ofGeneration(
  files: readonly MediaFileBytes[],
  scope: NcEventMediaScope,
): readonly MediaFileBytes[] {
  return files.filter((f) => f.timestamp === scope.recordAt)
}

export function makeNcOwnerMediaReader(deps: NcOwnerMediaReaderDeps): NcOwnerMediaRead {
  return async (ownerKind, ownerId, eventScope) => {
    if (ownerKind === 'track') {
      return deps.media.listByOwner('track', await deps.resolveTrackOwnerId(ownerId))
    }
    if (eventScope === undefined) {
      // D694 residual: refuse rather than list every generation of a reused id.
      deps.logger.error('object media read refused — NcEventMediaScope required', {
        meta: { ownerId },
      })
      return []
    }
    const onCamera = await deps.media.listByOwner('object', ownerId, eventScope.deviceId)
    const kept = ofGeneration(onCamera, eventScope)
    if (kept.length < onCamera.length) {
      // A branch that DROPS media logs it (D391): this is the reused-id case —
      // or a row written before the D476 migration that does not carry its
      // event's own timestamp, whose picture is then refused. WARN, so the
      // second case can never pass for "no media" in the log.
      deps.logger.warn('event media of another record on a reused event id — not used', {
        tags: { deviceId: eventScope.deviceId },
        meta: {
          ownerId,
          recordAt: eventScope.recordAt,
          refused: onCamera.length - kept.length,
          kept: kept.length,
        },
      })
    }
    return kept
  }
}

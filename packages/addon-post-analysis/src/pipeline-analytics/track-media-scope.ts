/**
 * track-media-scope — WHICH media rows belong to a track, and under WHICH kind
 * name they are published.
 *
 * ## The row that a track's media listing could not see
 *
 * A track's media is not all stored under `ownerKind: 'track'`. The subject
 * detail crops live under their own owners, prefixed with the track id:
 *
 *   ('track', `<trackId>`)          → thumbnail / keyFrame / firstFrame / …
 *   ('face',  `face-<trackId>`)     → the face crop   (stored `kind: 'crop'`)
 *   ('plate', `plate-<trackId>`)    → the plate crop  (stored `kind: 'crop'`)
 *
 * `listTrackMedia` / `getTrackMedia` read the FIRST line only, so a track's
 * plate crop was invisible to both: measured on three live tracks,
 * `listTrackMedia` answered 6-7 rows and not one plate, while
 * `plateGallery.getPlateByTrack` returned the crop for every one of them. The
 * viewer papered over it with a synthetic tile from the plate gallery and then
 * asked `getTrackMedia({ kinds: ['plateCrop'] })` for its bytes — wrong owner
 * AND wrong kind, so the answer was `[]`, which the detail reported as a
 * FAILED read (the red triangle) on a crop the hub was holding all along.
 * `event-thumbnail-resolver.ts` already walked all three owners; this makes the
 * track's own two listings do the same.
 *
 * ## Why the kind is RENAMED on the way out, and not asked for as `crop`
 *
 * The stored row says `kind: 'crop'`. That is unambiguous IN THE STORE, where
 * `ownerKind` sits beside it — a `crop` under the plate owner is a plate crop.
 * A wire row has no `ownerKind`: `MediaFile` is `{ key, kind, base64, … }`.
 * Publishing these rows as `crop` would therefore put them in the same bucket
 * as the track's own body `crop`, and the `kinds` filter — the whole mechanism
 * the lazy per-entry viewer fetch is built on — could no longer name one
 * without the other. `MediaFileKindEnum` already has the two names for exactly
 * this meaning (`faceCrop` / `plateCrop`), and the event-owned child crops are
 * already published under them. So the relabel happens HERE, once, on the way
 * out, and every consumer keeps one vocabulary.
 *
 * Only a stored `crop` is lifted from a detail owner. Anything else that ever
 * lands under `face-`/`plate-` (a re-owned gallery cover, say) is NOT the
 * track's media and is left where it is, rather than being renamed into a
 * crop it is not.
 *
 * Pure: no store, no I/O. The facade supplies the rows.
 */

import type { MediaFileKind } from '@camstack/types'
import {
  FACE_MEDIA_OWNER_PREFIX,
  type OwnerKind,
  PLATE_MEDIA_OWNER_PREFIX,
} from './store/media-store.js'

/** The stored kind a detail owner's crop is written with. */
const STORED_DETAIL_CROP_KIND: MediaFileKind = 'crop'

/** One owner a track's media listing has to read. */
export interface TrackMediaOwnerScope {
  readonly ownerKind: OwnerKind
  readonly ownerId: string
  /**
   * The kind a stored `crop` from this owner is PUBLISHED as, or `null` for the
   * track's own rows, which are published exactly as stored.
   *
   * Non-null also means "this owner contributes its `crop` rows and nothing
   * else" — see the module docblock.
   */
  readonly publishCropAs: MediaFileKind | null
}

/** The kinds only a detail owner can produce. */
const DETAIL_CROP_KINDS: readonly MediaFileKind[] = ['faceCrop', 'plateCrop']

/**
 * Every owner that holds media for `trackId`, in publication order (the track's
 * own rows first, then face, then plate).
 */
export function trackMediaOwnerScopes(trackId: string): readonly TrackMediaOwnerScope[] {
  return [
    { ownerKind: 'track', ownerId: trackId, publishCropAs: null },
    {
      ownerKind: 'face',
      ownerId: `${FACE_MEDIA_OWNER_PREFIX}${trackId}`,
      publishCropAs: 'faceCrop',
    },
    {
      ownerKind: 'plate',
      ownerId: `${PLATE_MEDIA_OWNER_PREFIX}${trackId}`,
      publishCropAs: 'plateCrop',
    },
  ]
}

/**
 * The scopes worth READING for a `kinds`-filtered request.
 *
 * A detail owner can only ever publish `faceCrop` / `plateCrop`, so a request
 * that names neither is answered without opening those two owners — which is
 * what keeps the common per-entry fetch (`kinds: ['keyFrameSmall']`) at exactly
 * its previous cost. The track scope is never skipped: it is the only owner
 * whose kinds are open-ended, and dropping it on a guess is how a listing
 * starts lying about what a track has.
 */
export function trackMediaScopesForKinds(
  trackId: string,
  kinds: readonly MediaFileKind[] | undefined,
): readonly TrackMediaOwnerScope[] {
  const scopes = trackMediaOwnerScopes(trackId)
  if (kinds === undefined || kinds.length === 0) return scopes
  const wantsDetail = kinds.some((kind) => DETAIL_CROP_KINDS.includes(kind))
  return wantsDetail ? scopes : scopes.filter((scope) => scope.publishCropAs === null)
}

/**
 * The STORED kinds worth reading from one scope for a `kinds` request, or
 * `null` when the scope cannot contribute to it at all.
 *
 * This is the same vocabulary translation {@link collectTrackMedia} performs on
 * the way out, moved to the way IN so it can narrow the query instead of the
 * answer. A caller naming `faceCrop` must ask the face owner for its stored
 * `crop` — asking it for `faceCrop` matches nothing, and asking it for
 * everything opens blobs the answer will discard.
 *
 * `undefined` means "every kind": the honest translation of an unfiltered
 * request, and the only safe answer for the open-ended track scope.
 *
 * `null` (skip) is only ever returned for a DETAIL owner whose one publishable
 * kind was not asked for. The track scope is never skipped — its kinds are
 * open-ended, and dropping it on a guess is how a listing starts lying.
 */
export function storedKindsForScope(
  scope: TrackMediaOwnerScope,
  kinds: readonly MediaFileKind[] | undefined,
): readonly MediaFileKind[] | undefined | null {
  if (kinds === undefined || kinds.length === 0) return undefined
  if (scope.publishCropAs === null) return kinds
  return kinds.includes(scope.publishCropAs) ? [STORED_DETAIL_CROP_KIND] : null
}

/** The rows one scope answered with. */
export interface ScopedMediaRows<TRow> {
  readonly scope: TrackMediaOwnerScope
  readonly rows: readonly TRow[]
}

/** The minimum a row must carry to be scoped, relabelled and filtered. */
export interface TrackMediaRowShape {
  readonly kind: MediaFileKind
  readonly timestamp: number
}

/**
 * Fold every scope's rows into ONE track media listing: detail crops
 * relabelled, everything filtered to `kinds`, ordered oldest first.
 *
 * `relabel` is injected rather than spread inline so the caller keeps its own
 * concrete row type (`MediaFile` with bytes, `MediaFileInfo` without) — there
 * is no cast and no third shape in between.
 */
export function collectTrackMedia<TRow extends TrackMediaRowShape>(
  scoped: readonly ScopedMediaRows<TRow>[],
  relabel: (row: TRow, kind: MediaFileKind) => TRow,
  kinds: readonly MediaFileKind[] | undefined,
): TRow[] {
  const out: TRow[] = []
  for (const { scope, rows } of scoped) {
    for (const row of rows) {
      if (scope.publishCropAs === null) {
        out.push(row)
        continue
      }
      if (row.kind !== STORED_DETAIL_CROP_KIND) continue
      out.push(relabel(row, scope.publishCropAs))
    }
  }
  const filtered =
    kinds === undefined || kinds.length === 0 ? out : out.filter((row) => kinds.includes(row.kind))
  return filtered.toSorted((a, b) => a.timestamp - b.timestamp)
}

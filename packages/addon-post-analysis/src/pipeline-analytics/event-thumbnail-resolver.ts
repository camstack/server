/**
 * Owner-path thumbnail resolution — the media the `/o/<ownerType>/<ownerId>`
 * plane form serves (event detail, and every list/reel tile that holds an id
 * and no media row).
 *
 * Preference: the owner's OWN media (`crop` → `fullFrameBoxed` → any) when it
 * has any; otherwise the event's OWNING TRACK media. `crop` / `fullFrameBoxed`
 * are RETIRED for new tracks — a common object event with no face/plate child
 * crop now owns NO media at all — so the track fallback is the PRIMARY path for
 * new events: it resolves via the event row's `trackId`. Old stored events keep
 * resolving by their own `crop` (their kinds still live in storage). An id that
 * is ALREADY a track id (a KeyEvent whose `bestEventId` is its track) misses
 * the object-event lookup and is used as the track id.
 *
 * The owner TYPE is a parameter throughout (D482). It used to be inferred by
 * probing motion → object → audio and taking the first hit, and on the live hub
 * that always answered `motion`.
 */
import type { MediaFileKind, MediaOwnerType } from '@camstack/types'

/**
 * The minimum a row needs to be RANKED by the ladders below: its kind, and the
 * id that would fetch its bytes.
 *
 * Every picker here compares `kind` and nothing else, so none of them needs the
 * bytes to choose. Saying so in the type is what lets the caller rank the INDEX
 * rows (`MediaFileInfo`, no blob touched) and open only the winner — both
 * `MediaFile` and `MediaFileInfo` satisfy this shape, so the existing
 * byte-carrying callers are unchanged.
 */
export interface RankableMediaRow {
  readonly mediaId: number
  readonly kind: MediaFileKind
}

/** Bytes of one resolved media row, and which row they came from. */
export interface ResolvedMediaBytes {
  readonly bytes: Uint8Array
  readonly mediaId: number
  /** The row's stored kind — the plane needs it to skip re-encoding a
   *  `thumbnailSmall` that is already a square (D482). */
  readonly kind: MediaFileKind
  /** The camera the media row names; the share-scope check reads it. */
  readonly deviceId?: number
}

/**
 * Rank `candidates` with `pick`, then open ONE blob — the winner's.
 *
 * The ladders decide on `kind` alone, so the bytes are dead weight until the
 * choice is made. Handing them pre-read rows meant a tile that serves the
 * 31 KB `thumbnailSmall` first read the whole 3 597 219-byte set, including a
 * 2.8 MB `keyFrame` no list view has ever rendered.
 *
 * A winner whose blob is GONE is dropped and the ladder re-run on the rest.
 * That fall-through is not an extra: `listByOwner` used to provide it for free
 * by skipping unreadable rows before the ladder ever saw them, and without it
 * an index row that outlived its file would 404 a tile that used to render.
 * Bounded by the candidate count — each attempt removes one row.
 */
export async function readWinningBlob<T extends RankableMediaRow>(
  candidates: readonly T[],
  pick: (rows: readonly T[]) => T | undefined,
  readBlob: (mediaId: number) => Promise<ResolvedMediaBytes | null>,
): Promise<ResolvedMediaBytes | null> {
  let remaining = candidates
  while (remaining.length > 0) {
    const winner = pick(remaining)
    if (winner === undefined) return null
    const bytes = await readBlob(winner.mediaId)
    if (bytes !== null) return bytes
    remaining = remaining.filter((row) => row.mediaId !== winner.mediaId)
  }
  return null
}

/** Pick an event-OWNED media blob: the tight `crop`, else the native-res boxed
 *  `fullFrameBoxed`, else any available file. Both preferred kinds are RETIRED
 *  for new tracks (served only for old stored rows). Undefined when the event
 *  owns no media. */
export function pickEventOwnedMedia<T extends RankableMediaRow>(
  files: readonly T[],
): T | undefined {
  return (
    files.find((f) => f.kind === 'crop') ??
    files.find((f) => f.kind === 'fullFrameBoxed') ??
    files[0]
  )
}

/** Pick a track's fallback media when no subject crop exists: `thumbnailSmall`
 *  → `thumbnail` → native `keyFrameSmall`/`keyFrame`/`fullFrame` → rolling
 *  `lastFrame` → `firstFrame` → newest `snapshot` → any blob. A full frame
 *  beats a class icon. Undefined when the owner has no media. */
export function pickTrackFallbackMedia<T extends RankableMediaRow>(
  files: readonly T[],
): T | undefined {
  return (
    files.find((f) => f.kind === 'thumbnailSmall') ??
    files.find((f) => f.kind === 'thumbnail') ??
    files.find((f) => f.kind === 'keyFrameSmall') ??
    files.find((f) => f.kind === 'keyFrame') ??
    files.find((f) => f.kind === 'fullFrame') ??
    files.find((f) => f.kind === 'lastFrame') ??
    files.find((f) => f.kind === 'firstFrame') ??
    [...files].reverse().find((f) => f.kind === 'snapshot') ??
    files[files.length - 1]
  )
}

/**
 * Crop-forced resolution (the `?kind=crop` / `?kind=thumbnailSmall` reel path).
 *
 * Ladder: body crop (track/event thumbnail) → tight face/plate crop → any
 * remaining image (keyFrame / lastFrame / …). The class icon is only honest
 * when the owner has no stored bytes at all.
 *
 * `pickClean` is injected because the clean-kind picker (`pickCleanMedia`) lives
 * in the addon `index.ts` over the concrete `MediaFileKind` set; this keeps the
 * composition pure + unit-testable here.
 */
export function resolveCropForcedMedia<T extends RankableMediaRow>(
  files: readonly T[],
  pickClean: (files: readonly T[]) => T | undefined,
  detailFiles: readonly T[] = [],
): T | undefined {
  return (
    pickClean(files) ?? pickClean(detailFiles) ?? pickTrackFallbackMedia([...files, ...detailFiles])
  )
}

/**
 * Owner kinds this resolver ever calls `listByOwner` with directly.
 *
 * `'event'` was removed (D476): it covered three tables (`motion` / `object` /
 * `audio`) under one owner kind, which stopped being safe once D474 made event
 * ids per-table rowid aliases. This resolver never lists by one of those three
 * kinds itself — `ownFiles` (the owner's OWN media) is listed by the CALLER,
 * from the table the URL NAMED (see `readOwnerThumbnail` in `index.ts`), and
 * handed in.
 */
export type CropForcedOwnerKind = 'track' | 'face' | 'plate'

export interface CropForcedMediaSource<T extends RankableMediaRow> {
  listByOwner(ownerKind: CropForcedOwnerKind, ownerId: string): Promise<readonly T[]>
  getTrackIdForEvent(eventId: string): Promise<string | null>
}

export interface CropForcedMediaLayers<T extends RankableMediaRow> {
  readonly bodyFiles: readonly T[]
  readonly detailFiles: readonly T[]
}

/**
 * Event + track media (the body/scene) and face/plate media (the detail
 * crops). Face rows live under `face-${trackId}`; a track can close with
 * `hasEmbeddedFace` and ZERO track files (0e343f86).
 *
 * `ownFiles` is the OWNER's own media, already listed by the caller from the
 * table the URL NAMED (the same rows the default path reuses via
 * {@link collectDefaultEventMedia}) — this function no longer lists by owner
 * kind `'event'` itself (D476), and no longer probes three tables for a bare
 * id either (D482; see {@link CropForcedOwnerKind}).
 */
export async function collectCropForcedMedia<T extends RankableMediaRow>(
  source: CropForcedMediaSource<T>,
  id: string,
  ownFiles: readonly T[],
): Promise<CropForcedMediaLayers<T>> {
  const trackFiles = await source.listByOwner('track', id)
  const ownerTrackId = trackFiles.length === 0 ? await source.getTrackIdForEvent(id) : null
  const owningTrackFiles =
    ownerTrackId === null ? [] : await source.listByOwner('track', ownerTrackId)
  const trackId = ownerTrackId ?? id
  const [faceFiles, plateFiles] = await Promise.all([
    source.listByOwner('face', `face-${trackId}`),
    source.listByOwner('plate', `plate-${trackId}`),
  ])
  return {
    bodyFiles: [...ownFiles, ...trackFiles, ...owningTrackFiles],
    detailFiles: [...faceFiles, ...plateFiles],
  }
}

/** Injected dependencies for {@link collectDefaultEventMedia}.
 *
 *  `ownFiles` is the already-fetched OWNER-owned media (the caller lists it
 *  once for both the crop-forced and default paths). `ownerType` is carried so
 *  this function can tell a track owner — which needs no event lookup at all —
 *  from an event owner, instead of discovering it by a failed query (D482).
 *  `getTrackIdForEvent` returns the owning track id for a genuine object
 *  event, or null when the id is not one. */
export interface DefaultEventMediaDeps<T extends RankableMediaRow> {
  readonly ownerType: MediaOwnerType
  readonly ownerId: string
  readonly ownFiles: readonly T[]
  listTrackMedia(trackId: string): Promise<readonly T[]>
  getTrackIdForEvent(eventId: string): Promise<string | null>
}

/** The rows the default path settled on, and the ladder that ranks them. */
export interface DefaultEventMediaCandidates<T extends RankableMediaRow> {
  readonly candidates: readonly T[]
  readonly pick: (rows: readonly T[]) => T | undefined
}

/**
 * Which rows the default path should serve from, and how to rank them: the
 * event's OWN media when it has any, else the owning track's.
 *
 * It yields the candidate SET rather than a winner so the caller can open one
 * blob and, if that blob has gone, re-rank the rest ({@link readWinningBlob}).
 * Returning a single row would force the caller to read it blind and 404 a tile
 * whose index row outlived its file.
 */
export async function collectDefaultEventMedia<T extends RankableMediaRow>(
  deps: DefaultEventMediaDeps<T>,
): Promise<DefaultEventMediaCandidates<T>> {
  if (deps.ownFiles.length > 0) {
    // A TRACK's own rows are the track ladder's rows, not an event's crop —
    // `pickEventOwnedMedia` prefers the retired `crop`/`fullFrameBoxed` kinds,
    // which a track does not own, and would then fall to `files[0]`.
    const pick = deps.ownerType === 'track' ? pickTrackFallbackMedia : pickEventOwnedMedia
    return { candidates: deps.ownFiles, pick }
  }
  // The owner owns nothing. For a TRACK that is the end of it: there is no
  // second place to look, and asking `getTrackIdForEvent` for a track id would
  // query the object-events table for a row that cannot be there.
  if (deps.ownerType === 'track') {
    return { candidates: [], pick: pickTrackFallbackMedia }
  }
  // An event with no media of its own resolves via the OWNING TRACK. Two paths
  // converge here —
  //  (a) an id that is ALREADY a track id (a KeyEvent whose bestEventId is its
  //      track): the object lookup misses and the id is used as the track id;
  //  (b) a new-style object event with retired crop/fullFrameBoxed: the event
  //      row carries its trackId. Look it up; fall back to id-as-track for (a).
  const trackId = (await deps.getTrackIdForEvent(deps.ownerId)) ?? deps.ownerId
  return { candidates: await deps.listTrackMedia(trackId), pick: pickTrackFallbackMedia }
}

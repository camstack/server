/**
 * What one track's rebuild inputs cost to assemble.
 *
 * ## Why this is its own module
 *
 * It used to be a closure inside `rebuildObjectEmbeddings`, and it called
 * `mediaStore.listByOwner('track', id)` — which READS AND BASE64-ENCODES EVERY
 * BLOB the track owns in order to `.find()` two of them. The store's own
 * docstring measures it: 23 files, 7.67 MB read, ~10 MB of string allocated,
 * for one 140 s track. `listInfoByOwner` has always answered `kind` and `key`
 * from the index rows alone.
 *
 * At fleet scale on hub-main's single thread that was not a micro-cost. A pass
 * on 2026-08-06 scanned 3,611 tracks and wrote 198 vectors; the main thread was
 * busy 82.2 s out of 120 with 42 s inside uninterrupted 2–7.3 s blocks, and
 * `nodes.topology` went from 0.25 s to 26 s for the 43 minutes it ran.
 *
 * So: **metadata first, then exactly one blob**, and the blob last — after the
 * event resolve that can reject the track for free. Extracted here so that
 * ordering is assertable, because "how much did it read" is invisible in the
 * result and a regression to `listByOwner` would look identical from outside.
 *
 * The two media references it produces are deliberately different in kind:
 * `keyFrame` is BYTES (the pixels the embedding is cut from) while `mediaId`
 * and `keyFrameMediaId` are media ROW IDS (pointers stored on the vector row so
 * a search hit can render the picture the operator recognises — D482). Only the
 * first costs a read.
 *
 * ## Where the box comes from (D664)
 *
 * The box must be the one MEASURED ON THE PIXELS being cut (D303). In order:
 *
 *  1. the key frame row's own `subjectBox` (D510) — recorded on that exact
 *     frame, read off the index row with no image read;
 *  2. for a key frame written before that column (2026-09-16T12:32Z), the
 *     track position whose timestamp is EXACTLY the key frame's — the same
 *     frame, measured by the tracker. Never the nearest: nearest is a pairing,
 *     and a pairing is how the crop left the subject;
 *  3. the best event's box ONLY when there is no key frame row at all — the
 *     pixels can then only come from a recording re-decode AT the event's
 *     instant, so event time = frame time;
 *  4. otherwise refuse, BY NAME ({@link RebuildBoxRefusal}), before the blob.
 *
 * It used to take the box of `bestEventId`'s event for every track: measured
 * on another frame (median IoU 0.50 against the key frame's subjectBox, 6/36
 * under 0.1), and — since `left` lost its bbox on 2026-09-07 and outranked
 * `entered` in `peakForTrack` — usually no box at all.
 */
import type { MediaFileBytes, MediaFileRef } from '@camstack/types'
import {
  normaliseEventBbox,
  type NormalisedBbox,
  type RebuildBoxRefusal,
  type RebuildBoxSource,
  type RebuildSource,
} from './embedding-rebuild.js'

/** A frame-space rectangle with the frame it was measured on. */
export interface RebuildMeasuredBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly frameWidth: number
  readonly frameHeight: number
}

/** A media row that recorded where its subject was (D510) — index only. */
export interface RebuildSubjectBoxRow {
  readonly mediaId: number
  readonly kind: MediaFileRef['kind']
  readonly timestamp: number
  readonly subjectBox: RebuildMeasuredBox
}

/**
 * The media reads a rebuild is allowed to make.
 *
 * Structural on purpose: naming `listByOwner` here would make the expensive
 * call reachable again, and the point of this seam is that it is not.
 */
export interface RebuildMediaReader {
  listInfoByOwner(ownerKind: 'track', ownerId: string): Promise<readonly MediaFileRef[]>
  /** Index-only: the rows that carry their own subject box. No blob is opened. */
  listSubjectBoxesByOwner(
    ownerKind: 'track',
    ownerId: string,
  ): Promise<readonly RebuildSubjectBoxRow[]>
  getById(mediaId: number): Promise<MediaFileBytes | null>
}

/** One stored track position, as much of it as the fallback reads. */
export interface RebuildTrackPosition {
  readonly timestamp: number
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

/** The part of a persisted track the positions fallback reads. */
export interface RebuildTrackRow {
  readonly positions: readonly RebuildTrackPosition[]
  /** The detection frame the positions live in; absent when never known. */
  readonly frameWidth?: number
  readonly frameHeight?: number
}

/** Read only for a key frame that predates `subjectBox` — the ~14% path. */
export interface RebuildTrackReader {
  getPersistedByTrackId(trackId: string): Promise<RebuildTrackRow | null>
}

/** One stored object event, as much of it as the rebuild reads. */
export interface RebuildObjectEvent {
  /** The row's own id — a number (D474). */
  readonly id: number
  readonly deviceId: number
  readonly timestamp: number
  readonly className: string
  readonly confidence?: number
  readonly bbox?: { x: number; y: number; w: number; h: number }
  readonly frameWidth?: number
  readonly frameHeight?: number
}

export interface RebuildEventReader {
  /**
   * `bestEventId` stays a STRING: it is a pointer HELD on the track row and
   * read back by the viewer, and widening it would push the same choice onto
   * every consumer of `Track` (D474). Compared against `String(event.id)`.
   */
  peakForTrack(trackId: string): Promise<{ readonly bestEventId: string | undefined }>
  queryObjectByTrackIds(trackIds: readonly string[]): Promise<readonly RebuildObjectEvent[]>
}

export interface RebuildSourceLoaderDeps {
  readonly media: RebuildMediaReader
  readonly events: RebuildEventReader
  readonly tracks: RebuildTrackReader
}

/** A box on the key frame, or `null` with the named reason there is none. */
interface KeyFrameBox {
  readonly bbox: NormalisedBbox | null
  readonly boxSource: RebuildBoxSource
}

function refused(reason: RebuildBoxRefusal): KeyFrameBox {
  return { bbox: null, boxSource: { kind: 'refused', reason } }
}

function normaliseMeasured(box: RebuildMeasuredBox): NormalisedBbox | null {
  if (box.frameWidth <= 0 || box.frameHeight <= 0 || box.w <= 0 || box.h <= 0) return null
  return {
    x: box.x / box.frameWidth,
    y: box.y / box.frameHeight,
    w: box.w / box.frameWidth,
    h: box.h / box.frameHeight,
  }
}

/**
 * The box measured on THIS key frame: its own `subjectBox`, else the track
 * position at exactly its instant, else a named refusal. Never another
 * frame's box (D303).
 */
async function keyFrameBox(
  deps: RebuildSourceLoaderDeps,
  trackId: string,
  keyFrame: MediaFileRef,
): Promise<KeyFrameBox> {
  const boxed = await deps.media.listSubjectBoxesByOwner('track', trackId)
  const own = boxed.find((row) => row.mediaId === keyFrame.mediaId)
  if (own !== undefined) {
    const bbox = normaliseMeasured(own.subjectBox)
    if (bbox !== null) return { bbox, boxSource: { kind: 'subjectBox' } }
  }
  const track = await deps.tracks.getPersistedByTrackId(trackId)
  if (track === null) return refused('track-row-missing')
  const { frameWidth, frameHeight } = track
  if (frameWidth === undefined || frameHeight === undefined) {
    return refused('track-frame-size-unknown')
  }
  const at = track.positions.find((p) => p.timestamp === keyFrame.timestamp)
  if (at === undefined) return refused('no-position-at-key-frame')
  const bbox = normaliseMeasured({ ...at.bbox, frameWidth, frameHeight })
  if (bbox === null) return refused('no-position-at-key-frame')
  return { bbox, boxSource: { kind: 'positions' } }
}

function hasBox(event: RebuildObjectEvent): boolean {
  return event.bbox !== undefined && event.bbox.w > 0 && event.bbox.h > 0
}

/**
 * Assemble one track's rebuild inputs, reading at most ONE blob.
 *
 * Returns `null` when the track has no object event at all — there is nothing
 * to describe, and the caller counts it. A track WITH an event but WITHOUT a
 * key frame still returns a source (with `keyFrame: null`) so the caller's
 * `missingKeyFrame` counter stays the one place that decision is made; no blob
 * is read in that case either. A key frame with no box measured on it returns
 * `bbox: null` and a named refusal, also without reading the blob.
 */
export async function loadRebuildSource(
  deps: RebuildSourceLoaderDeps,
  trackId: string,
): Promise<RebuildSource | null> {
  const media = await deps.media.listInfoByOwner('track', trackId)
  // Re-box from the NATIVE key frame. The thumbnail is left untouched — it is a
  // display artefact and stays the operator-facing crop, while the embedding
  // window is a model input and wants more context. The two diverge on purpose.
  const keyFrameInfo = media.find((m) => m.kind === 'keyFrame')
  const cropInfo = media.find((m) => m.kind === 'thumbnail')

  // BEFORE the blob read: a track with no event is unusable, and discovering
  // that after reading its key frame is the same wasted work one order of
  // magnitude smaller.
  const peak = await deps.events.peakForTrack(trackId)
  const events = await deps.events.queryObjectByTrackIds([trackId])
  const best =
    events.find((e) => String(e.id) === peak.bestEventId) ?? events.find(hasBox) ?? events[0]
  if (best === undefined) return null

  const common = {
    trackId,
    deviceId: best.deviceId,
    className: best.className,
    confidence: best.confidence ?? 0,
    ...(cropInfo !== undefined ? { mediaId: cropInfo.mediaId } : {}),
  }

  if (keyFrameInfo === undefined) {
    // No stored key frame: the only pixels left are a recording re-decode AT
    // the event's instant, so the event's box is the one measured on them.
    const bbox = normaliseEventBbox(best)
    return {
      ...common,
      timestamp: best.timestamp,
      bbox,
      boxSource:
        bbox !== null ? { kind: 'event' } : { kind: 'refused', reason: 'event-without-box' },
      keyFrame: null,
    }
  }

  const box = await keyFrameBox(deps, trackId, keyFrameInfo)
  const keyed = {
    ...common,
    // The key frame's own instant: a recording recovery of a vanished blob
    // must decode the frame the box was measured on.
    timestamp: keyFrameInfo.timestamp,
    bbox: box.bbox,
    boxSource: box.boxSource,
    keyFrameMediaId: keyFrameInfo.mediaId,
  }
  // Refused before the blob — the cheap question first (D54).
  if (box.bbox === null) return { ...keyed, keyFrame: null }

  const keyFrameFile = await deps.media.getById(keyFrameInfo.mediaId)
  return {
    ...keyed,
    keyFrame: keyFrameFile ? Buffer.from(keyFrameFile.base64, 'base64') : null,
  }
}

/**
 * Human labels + a URL builder for the event-media rows shown in the
 * EventDetailPanel filmstrip.
 *
 * Each `listTrackMedia` / `listEventMedia` row carries a `kind` (what the
 * frame IS) and a server-minted `url` (D482: `/addon/<addonId>/event-media
 * /m/<mediaId>`, the row's own address). This module maps the kind to an
 * operator-facing title and combines that `url` with an origin, for both the
 * LAN (current admin origin) and an optional public tunnel origin — it does
 * NOT build the path itself; prefer the row's `url` over reconstructing one.
 */
import type { MediaFileKind } from '@camstack/types'

/**
 * kind → title. Keyed by the closed `MediaFileKind` union so a new media kind
 * added to the cap surfaces a type error here rather than silently rendering
 * the raw enum string.
 */
const MEDIA_KIND_LABELS: Record<MediaFileKind, string> = {
  firstFrame: 'First frame (track start)',
  lastFrame: 'Last frame (track end)',
  thumbnail: 'Best detection',
  thumbnailSmall: 'Best detection (480)',
  snapshot: 'Snapshot',
  keyFrame: 'Key frame (native-res)',
  keyFrameSmall: 'Key frame (960)',
  crop: 'Object crop',
  fullFrame: 'Full frame',
  fullFrameBoxed: 'Full frame (boxed)',
  faceCrop: 'Face crop',
  plateCrop: 'Plate crop',
  // The pixels the confirmation gate judged, kept when it refused to confirm —
  // the only thing that can settle "was the detector right about this birth".
  confirmationCrop: 'Confirmation crop (what the gate saw)',
  // Stored only for a track the operator marked debug: the subject WITH its
  // neighbourhood — and the rival box where a decision compared two — with the
  // decision and its numbers burnt in. The opposite of every other crop here,
  // which are model inputs and therefore exclude the context on purpose.
  debugCrop: 'Debug crop (why this decision)',
  // Retired 2026-09-03, the day it shipped: the clean twin of the boxed
  // timeline tile. Nothing writes it any more, but rows written during those
  // hours are still stored and still rendered — which is exactly why the kind
  // stayed in the enum and why it needs a label here.
  sceneFrame: 'Scene frame (clean)',
  lastSceneFrame: 'Last frame (clean)',
}

function isKnownKind(kind: string): kind is MediaFileKind {
  return kind in MEDIA_KIND_LABELS
}

/** Operator-facing title for a media `kind`; falls back to the raw kind. */
export function mediaKindLabel(kind: string): string {
  return isKnownKind(kind) ? MEDIA_KIND_LABELS[kind] : kind
}

/**
 * Combine an origin with an event-media plane PATH — a row's own
 * server-minted `url` (D482), never a raw id/key spliced in here. The route
 * is Bearer-token gated, so the result only renders inside an authenticated
 * session (fine for debugging / sharing with an authed browser).
 */
export function buildMediaUrl(origin: string, path: string): string {
  return `${origin}${path}`
}

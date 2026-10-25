/**
 * The shape of the debug bundle — one directory per track, and the names inside
 * it.
 *
 * ```
 * manifest.json
 * tracks/101/6a1f…-9c/track.json      the whole row, verbatim
 * tracks/101/6a1f…-9c/analysis.json   the findings this tab showed
 * tracks/101/6a1f…-9c/events.json     the track's object events
 * tracks/101/6a1f…-9c/media/keyFrame.jpg
 * tracks/101/6a1f…-9c/media/snapshot-1700000020000.jpg
 * ```
 *
 * Two decisions are worth stating.
 *
 * **`manifest.json` is written LAST, and it is accurate.** The training exports
 * write their manifest first because tar is read front to back; ZIP is indexed
 * from a central directory at the END, so entry order does not affect lookup
 * (`unzip -p bundle.zip manifest.json` finds it wherever it sits). That buys the
 * one thing the tar manifests cannot have: it is written after every blob has
 * been attempted, so it records what the archive CONTAINS rather than what the
 * plan hoped for. A manifest describing a file the archive does not carry is how
 * an operator concludes the export is broken when the capture was.
 *
 * **A media file is named for its kind, never for its storage key.** The key is
 * `track:<uuid>:keyFrame`, which tells the operator nothing they cannot already
 * see from the directory. The kind is the whole question they opened the bundle
 * to ask. Kinds that occur more than once per track carry their timestamp, and a
 * collision on that pair gets an ordinal — deterministic, so two exports of an
 * unchanged track produce byte-identical names.
 */

import type { MediaFileRef } from '@camstack/types'
import type { DebugTrackReport } from './debug-track-analysis.js'
import { toAsciiZipName } from './zip-stream.js'

export const DEBUG_EXPORT_PREFIX = 'debug-export'
export const DEBUG_MANIFEST_ENTRY = 'manifest.json'
export const DEBUG_TRACK_ENTRY = 'track.json'
export const DEBUG_ANALYSIS_ENTRY = 'analysis.json'
export const DEBUG_EVENTS_ENTRY = 'events.json'

/** One media file, resolved to the name it will carry inside the archive. */
export interface DebugMediaEntry {
  /** The media row's own id (D482) — read the bytes with `MediaStore.getById`. */
  readonly mediaId: number
  /** Path inside the archive, relative to the track directory. */
  readonly name: string
  readonly kind: string
  readonly timestamp: number
  readonly sizeBytes: number
}

/** `tracks/<deviceId>/<trackId>` — ASCII by construction, both parts are ids. */
export function debugTrackDir(deviceId: number, trackId: string): string {
  return toAsciiZipName(`tracks/${String(deviceId)}/${trackId}`)
}

/**
 * Resolve every media row of one track to an archive-relative name.
 *
 * Deterministic: the input order (the store returns `timestamp asc`) fully
 * determines the output, so re-exporting an unchanged track produces the same
 * names. A kind that occurs once is bare (`keyFrame.jpg`); a kind that repeats
 * carries its timestamp; a genuine duplicate of both gets `-2`, `-3`, …
 */
export function planTrackMediaNames(media: readonly MediaFileRef[]): readonly DebugMediaEntry[] {
  const occurrences = new Map<string, number>()
  for (const m of media) occurrences.set(m.kind, (occurrences.get(m.kind) ?? 0) + 1)

  const used = new Set<string>()
  const out: DebugMediaEntry[] = []
  for (const m of media) {
    const repeats = (occurrences.get(m.kind) ?? 0) > 1
    const base = repeats ? `${m.kind}-${String(m.timestamp)}` : m.kind
    let name = `media/${base}.jpg`
    for (let n = 2; used.has(name); n++) name = `media/${base}-${String(n)}.jpg`
    used.add(name)
    out.push({
      mediaId: m.mediaId,
      name: toAsciiZipName(name),
      kind: m.kind,
      timestamp: m.timestamp,
      sizeBytes: m.sizeBytes,
    })
  }
  return out
}

/** Everything about one track the bundle needs — index rows only, no blobs. */
export interface DebugBundleTrack {
  readonly report: DebugTrackReport
  /** The whole persisted row, as `track.json`. */
  readonly track: Record<string, unknown>
  /** The track's object events, as `events.json`. */
  readonly events: readonly Record<string, unknown>[]
  readonly media: readonly DebugMediaEntry[]
}

export interface DebugBundlePlan {
  readonly generatedAt: number
  readonly deviceIds: readonly number[]
  readonly tracks: readonly DebugBundleTrack[]
  /** True when more tracks are marked than one bundle is allowed to carry. */
  readonly capped: boolean
}

/** What actually reached the archive, per track. */
export interface DebugManifestTrack {
  readonly trackId: string
  readonly deviceId: number
  readonly dir: string
  readonly className: string
  readonly label?: string
  readonly firstSeen: number
  readonly lastSeen: number
  readonly durationMs: number
  readonly eventCount: number
  readonly findings: readonly string[]
  /** Archive-relative names of the media that LANDED. */
  readonly mediaIncluded: readonly string[]
  /** Media row ids (D482) whose bytes could not be read — the gap, named. */
  readonly mediaMissing: readonly number[]
}

export interface DebugBundleManifest {
  readonly generatedAt: number
  readonly deviceIds: readonly number[]
  readonly trackCount: number
  readonly mediaIncluded: number
  readonly mediaMissing: number
  /**
   * True when the bundle carries less than was marked — either the plan hit the
   * per-export track cap, or the byte budget stopped the stream, or an entry was
   * refused by the archive's own ceilings. Always paired with `stoppedBecause`.
   */
  readonly truncated: boolean
  /** Why, when `truncated` — `null` when the bundle is complete. */
  readonly stoppedBecause: 'track-cap' | 'byte-budget' | 'zip-ceiling' | null
  /**
   * Said in the manifest because it changes how the contents must be read: a
   * debug mark does NOT pin retention (D81), so a track missing all of its media
   * may simply have been evicted.
   */
  readonly retentionNote: string
  readonly tracks: readonly DebugManifestTrack[]
}

export const DEBUG_RETENTION_NOTE =
  'A `debug` mark does not pin retention. A track with no media here may have been evicted rather than never captured.'

/** The archive filename, stamped so two downloads never collide in ~/Downloads. */
export function debugArchiveFilename(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  return `camstack-debug-${stamp}.zip`.replace(/[\r\n"]/g, '')
}

/** Parse `?deviceIds=101,102` — empty means every camera. */
export function parseDebugDeviceIds(url: string): readonly number[] {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  const raw = new URLSearchParams(query).get('deviceIds')
  if (raw === null || raw.trim() === '') return []
  const out: number[] = []
  for (const part of raw.split(',')) {
    const n = Number.parseInt(part.trim(), 10)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

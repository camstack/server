/**
 * The ffmpeg INPUT playlist for one recording export.
 *
 * Exports must NOT reuse the playback variant playlist. That file lives under
 * `<dataDir>/playback` while its segments live under a recordings LOCATION root,
 * and the two trees are unified only by the HTTP data-plane's ordered multi-root
 * search. ffmpeg has no such fallback — it resolves every segment URI against
 * the playlist's own directory — so a playback playlist handed to `-i` ENOENTs
 * on every segment and dies with `AVERROR_INVALIDDATA` (exit 183).
 *
 * So each export gets its OWN playlist whose segment URIs are ABSOLUTE on-disk
 * paths, written at a PER-EXPORT path. Per-export is load-bearing twice over:
 * the playback playlist sits at a shared fixed path that `buildPlaybackManifest`
 * rewrites on every playback request, so an operator scrubbing the same camera
 * mid-render would otherwise swap ffmpeg's input out from under it.
 *
 * The file is transient — `ExportEngine` deletes it when the render finishes
 * (success, failure or cancel).
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { exportTenantDirFor } from './export-store.js'
import { buildVariantPlaylist } from '../playlist.js'
import type { ExportSegmentTiming } from './export-dense-map.js'
import { buildExportConcatList, type ExportConcatSegment } from './export-ffmpeg-args.js'
import { collectRangeSegments, type RecordingProviderDeps } from './recording-provider.js'

/** Everything needed to render one export's source playlist. */
export interface ExportSourcePlaylistInput {
  readonly deps: RecordingProviderDeps
  /** Absolute `<dataDir>/exports` dir (the export MP4s live here too). */
  readonly exportsDir: string
  readonly exportId: string
  readonly deviceId: number
  readonly profile: string
  readonly fromMs: number
  readonly toMs: number
}

/**
 * Absolute path of ONE export's source playlist:
 * `<root>/<deviceId>/exports/<exportId>.src.m3u8` — inside the exports
 * TENANT subtree of the shared `artifacts` class root, derived through
 * {@link exportTenantDirFor} so no caller can join the path a second way.
 * Unique per export id, so two concurrent renders (and any concurrent
 * playback request) never share a file.
 */
export function exportSourcePlaylistPath(
  exportsDir: string,
  deviceId: number,
  exportId: string,
): string {
  return path.join(exportTenantDirFor(exportsDir, deviceId), `${exportId}.src.m3u8`)
}

/**
 * Absolute path of the same export's FFCONCAT list — the timelapse pass-1
 * input (`buildConcatPassArgs`). Sibling of the m3u8, same uniqueness rules.
 */
export function exportSourceConcatPath(
  exportsDir: string,
  deviceId: number,
  exportId: string,
): string {
  return path.join(exportTenantDirFor(exportsDir, deviceId), `${exportId}.src.ffconcat`)
}

/**
 * A written source playlist: the file ffmpeg reads, and the TIMELINE it encodes.
 *
 * The segments ride along because they are the only description of what
 * ffmpeg's `t` will be — the concatenation of these files, gaps removed. A
 * caller that speaks WALL time (a dense-range overlay does) cannot translate
 * without them, and nothing downstream of here can reconstruct them: the
 * playlist file is deleted the moment the render ends. See `export-dense-map.ts`.
 */
export interface ExportSourcePlaylist {
  /** Absolute path of the written playlist. */
  readonly path: string
  /**
   * Absolute path of the written FFCONCAT list — what the timelapse pass-1
   * remux reads. Its `duration` lines carry the SAME `durMs` values as
   * {@link ExportSourcePlaylist.segments}, so ffmpeg's `t` and the dense map's
   * `recordedMsBefore` agree at every segment boundary by construction.
   */
  readonly concatPath: string
  /** Playlist order — the order ffmpeg concatenates them in. */
  readonly segments: readonly ExportSegmentTiming[]
  /**
   * The same concat list as STRUCTURED rows, so a long timelapse can be cut
   * into hour-sized chunks without re-reading and re-parsing the file at
   * {@link ExportSourcePlaylist.concatPath}.
   *
   * This is built here (below) and consumed by `ExportEngine`, which declares
   * it in its own input type — it was simply never declared on the type in
   * between, so the field travelled from producer to consumer through a hole
   * in the contract. `tsc` said so; nothing else could, because `camstack
   * deploy` builds with vite and vite does not typecheck.
   */
  readonly concatEntries: readonly ExportConcatSegment[]
}

/**
 * Write the export's source playlist and return it, or null when no segment of
 * the requested profile is present on disk for the range (the engine then fails
 * the job with 'no footage for range').
 */
export async function writeExportSourcePlaylist(
  input: ExportSourcePlaylistInput,
): Promise<ExportSourcePlaylist | null> {
  const { segments } = await collectRangeSegments(
    input.deps,
    input.deviceId,
    input.profile,
    input.fromMs,
    input.toMs,
    'absolute',
  )
  if (segments.length === 0) return null

  const playlistPath = exportSourcePlaylistPath(input.exportsDir, input.deviceId, input.exportId)
  const concatPath = exportSourceConcatPath(input.exportsDir, input.deviceId, input.exportId)
  await fs.mkdir(path.dirname(playlistPath), { recursive: true })
  await fs.writeFile(playlistPath, buildVariantPlaylist(segments), 'utf8')
  await fs.writeFile(
    concatPath,
    buildExportConcatList(segments.map((s) => ({ uri: s.uri, durMs: s.durMs }))),
    'utf8',
  )
  return {
    path: playlistPath,
    concatPath,
    segments: segments.map((s) => ({ startMs: s.startMs, durMs: s.durMs })),
    concatEntries: segments.map((s) => ({ uri: s.uri, durMs: s.durMs })),
  }
}

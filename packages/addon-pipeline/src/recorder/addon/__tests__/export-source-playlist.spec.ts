/**
 * End-to-end coverage of the EXPORT INPUT PLAYLIST resolution against a real
 * temp filesystem laid out in the two-root shape playback uses:
 *   - playlists under `<dataDir>/playback` (or `<dataDir>/exports` for exports)
 *   - segments under `<locationRoot>/<deviceId>/<profile>/Y/M/D/H/<file>.m4s`
 *
 * The HTTP data-plane unifies those two trees with an ordered multi-root search;
 * ffmpeg does NOT — it resolves every segment URI against the PLAYLIST'S OWN
 * directory. So the export's input playlist must carry URIs that resolve on the
 * local filesystem. That is exactly what this spec asserts, and it is the
 * assertion `export-engine.spec.ts` could never make (it mocks `resolvePlaylist`).
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import { segmentRelPath } from '../../segment-path.js'
import type { SegmentStore } from '../../segment-store.js'
import type { RecordingConfigsState } from '../config-store.js'
import {
  type ExportSourcePlaylist,
  exportSourcePlaylistPath,
  writeExportSourcePlaylist,
} from '../export-source-playlist.js'
import { MAX_WINDOW_SHIFT_MS, slideWindowToAvailable } from '../footage-render.js'
import { buildPlaybackManifest, type RecordingProviderDeps } from '../recording-provider.js'
import { type RecordingsLocation, recordingsLocationOfMode } from '../roots.js'

const noopLogger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

const DEVICE_ID = 102
const PROFILE = 'high'

interface Fixture {
  readonly deps: RecordingProviderDeps
  readonly dataDir: string
  readonly root: string
  readonly absSegments: readonly string[]
}

const tmpDirs: string[] = []
afterEach(async () => {
  for (const dir of tmpDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

/**
 * Three consecutive on-disk segments under a location root that is NOT under
 * `<dataDir>` — the production shape (`/mnt/recordings` vs `/data/addons-data`).
 */
async function fixture(): Promise<Fixture> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rec-export-src-'))
  tmpDirs.push(tmp)
  const root = path.join(tmp, 'recordings')
  const dataDir = path.join(tmp, 'addon-data')

  const index = new RecordingIndex()
  const absSegments: string[] = []
  for (let i = 0; i < 3; i++) {
    const startMs = 1_784_918_985_000 + i * 8_000
    const bytes = 1_000 + i
    const rel = segmentRelPath(DEVICE_ID, PROFILE, startMs, 8_000, bytes)
    const abs = path.join(root, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, Buffer.alloc(bytes))
    absSegments.push(abs)
    index.addSegment({
      deviceId: DEVICE_ID,
      profile: PROFILE,
      startMs,
      durMs: 8_000,
      bytes,
      path: rel,
      locationId: 'loc-a',
    })
  }

  const locations: readonly RecordingsLocation[] = [
    recordingsLocationOfMode({ id: 'loc-a', type: 'recordings', root }, 'active'),
  ]
  const deps: RecordingProviderDeps = {
    index,
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger: noopLogger,
    configStore: {} as unknown as RecordingConfigsState,
    locations: () => locations,
    refreshLocations: async () => locations,
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir,
    playbackBaseUrl: () => '/addon/recorder/playback',
  }
  return { deps, dataDir, root, absSegments }
}

/** Segment URIs of a playlist (every non-comment, non-blank line). */
function playlistUris(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
}

/** Resolve a playlist URI the way ffmpeg's HLS demuxer does: against the
 *  playlist's OWN directory (absolute URIs pass through unchanged). */
function resolveLikeFfmpeg(playlistPath: string, uri: string): string {
  return path.resolve(path.dirname(playlistPath), uri)
}

/** The export input resolution, exactly as `addon/index.ts` composes it. */
async function resolveExportPlaylist(
  fx: Fixture,
  exportId: string,
): Promise<ExportSourcePlaylist | null> {
  return writeExportSourcePlaylist({
    deps: fx.deps,
    exportsDir: path.join(fx.dataDir, 'artifacts'),
    exportId,
    deviceId: DEVICE_ID,
    profile: PROFILE,
    fromMs: 0,
    toMs: Number.MAX_SAFE_INTEGER,
  })
}

/** Just the path, for the assertions that only care where the file landed. */
async function resolveExportPlaylistPath(fx: Fixture, exportId: string): Promise<string | null> {
  return (await resolveExportPlaylist(fx, exportId))?.path ?? null
}

describe('export input playlist — ffmpeg-resolvable segment URIs', () => {
  it('every segment URI of the export input playlist resolves to a file on disk', async () => {
    const fx = await fixture()

    const playlist = await resolveExportPlaylistPath(fx, 'exp-1')
    expect(playlist).not.toBeNull()
    // The playlist and its segments live in DIFFERENT trees — the whole point.
    expect(path.dirname(playlist as string).startsWith(fx.root)).toBe(false)

    const uris = playlistUris(await fs.readFile(playlist as string, 'utf8'))
    expect(uris).toHaveLength(3)

    const missing: string[] = []
    for (const uri of uris) {
      const resolved = resolveLikeFfmpeg(playlist as string, uri)
      try {
        await fs.stat(resolved)
      } catch {
        missing.push(resolved)
      }
    }
    expect(missing).toEqual([])
    expect(uris).toEqual([...fx.absSegments])
  })

  it('writes a distinct playlist per export id (a concurrent render/scrub cannot swap it)', async () => {
    const fx = await fixture()

    const a = await resolveExportPlaylistPath(fx, 'exp-a')
    const b = await resolveExportPlaylistPath(fx, 'exp-b')

    expect(a).toBe(exportSourcePlaylistPath(path.join(fx.dataDir, 'artifacts'), DEVICE_ID, 'exp-a'))
    expect(a).not.toBe(b)

    // ...and it is never the SHARED playback variant playlist, which every
    // playback request rewrites for ITS OWN window — an operator scrubbing this
    // camera mid-render used to swap ffmpeg's input out from under it.
    const playbackVariant = path.join(fx.dataDir, 'playback', String(DEVICE_ID), `${PROFILE}.m3u8`)
    expect(a).not.toBe(playbackVariant)

    const before = await fs.readFile(a as string, 'utf8')
    await buildPlaybackManifest(
      fx.deps,
      new Map<string, string>(),
      DEVICE_ID,
      0,
      Number.MAX_SAFE_INTEGER,
    )
    // The playback request really did rewrite its own playlist...
    await fs.stat(playbackVariant)
    // ...and left both export inputs alone.
    expect(await fs.readFile(a as string, 'utf8')).toBe(before)
  })

  // The dense overlay speaks WALL time; ffmpeg's `t` is the concatenation of
  // exactly these files with the gaps removed. This list is the ONLY thing that
  // relates the two, and it cannot be recovered later — the playlist file is
  // deleted as soon as the render ends. See `export-dense-map.ts`.
  it('answers the segment timeline the dense mapping is computed from', async () => {
    const fx = await fixture()

    const written = await resolveExportPlaylist(fx, 'exp-t')

    expect(written?.segments).toEqual([
      { startMs: 1_784_918_985_000, durMs: 8_000 },
      { startMs: 1_784_918_993_000, durMs: 8_000 },
      { startMs: 1_784_919_001_000, durMs: 8_000 },
    ])
  })

  // The timelapse pass-1 input. `duration` lines carry the SAME durMs the dense
  // map sums, so ffmpeg's `t` and `recordedMsBefore` agree at every segment
  // boundary by construction — the HLS demuxer's content-length stitching is
  // what let them drift ~495 s apart over one night (see export-ffmpeg-args).
  it('writes the ffconcat sidecar pass 1 reads, durations equal to the mapped durMs', async () => {
    const fx = await fixture()

    const written = await resolveExportPlaylist(fx, 'exp-c')

    // Device-first inside the shared artifacts root: the scratch sits beside
    // the export MP4s in the SAME `<deviceId>/exports/` tenant subtree.
    expect(written?.concatPath).toBe(
      path.join(fx.dataDir, 'artifacts', String(DEVICE_ID), 'exports', 'exp-c.src.ffconcat'),
    )
    const text = await fs.readFile(written?.concatPath as string, 'utf8')
    expect(text).toBe(
      'ffconcat version 1.0\n' +
        fx.absSegments.map((abs) => `file '${abs}'\nduration 8\n`).join(''),
    )
  })

  it('returns null when no segment of the range is present on disk', async () => {
    const fx = await fixture()
    await fs.rm(fx.root, { recursive: true, force: true })

    expect(await resolveExportPlaylistPath(fx, 'exp-gone')).toBeNull()
  })

  it('leaves the PLAYBACK variant playlist relative (data-plane multi-root search)', async () => {
    const fx = await fixture()

    const manifest = await buildPlaybackManifest(
      fx.deps,
      new Map<string, string>(),
      DEVICE_ID,
      0,
      Number.MAX_SAFE_INTEGER,
    )

    expect(manifest.localMasterPath).not.toBeNull()
    const variant = path.join(fx.dataDir, 'playback', String(DEVICE_ID), `${PROFILE}.m3u8`)
    for (const uri of playlistUris(await fs.readFile(variant, 'utf8'))) {
      expect(path.isAbsolute(uri)).toBe(false)
      expect(uri.startsWith(`${PROFILE}/`)).toBe(true)
    }
  })
})

// ── Sliding a render window onto FINALIZED footage (2026-07-30) ─────────────
// Only finalized segments are addressable, and the segment covering "now" is
// still being written — measured 13.2 s behind on the live hub. An `immediate`
// notification rule asks for `[event-2s, event+5s]`, entirely inside that tail,
// so a gif OF THE EVENT cannot exist at fire time. Sliding the window back
// yields the approach to the trigger, which is the informative part.
describe('slideWindowToAvailable', () => {
  it('leaves a window that already lands on finalized footage', () => {
    expect(slideWindowToAvailable(1_000, 2_000, 5_000)).toEqual({
      fromMs: 1_000,
      toMs: 2_000,
    })
  })

  it('slides the window back, PRESERVING its duration', () => {
    const out = slideWindowToAvailable(10_000, 17_000, 14_000)
    expect(out).toEqual({ fromMs: 7_000, toMs: 14_000 })
    expect((out?.toMs ?? 0) - (out?.fromMs ?? 0)).toBe(7_000)
  })

  it('refuses a shift beyond the cap — video from long before the event is a lie', () => {
    expect(slideWindowToAvailable(1_000_000, 1_007_000, 1_000_000 - MAX_WINDOW_SHIFT_MS)).toBeNull()
  })

  it('accepts a shift exactly AT the cap', () => {
    const availableEnd = 1_007_000 - MAX_WINDOW_SHIFT_MS
    expect(slideWindowToAvailable(1_000_000, 1_007_000, availableEnd)).toEqual({
      fromMs: 1_000_000 - MAX_WINDOW_SHIFT_MS,
      toMs: availableEnd,
    })
  })

  it('refuses when the camera has no finalized footage at all', () => {
    expect(slideWindowToAvailable(1_000, 2_000, null)).toBeNull()
  })
})

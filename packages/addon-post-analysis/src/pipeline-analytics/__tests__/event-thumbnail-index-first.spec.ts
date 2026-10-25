/**
 * The events-list tile decides on the INDEX and opens ONE blob.
 *
 * This is the path every Events tile takes: the viewer renders each tile from
 * the `event-media` HTTP plane, which resolves an id to bytes through the
 * ladders in `event-thumbnail-resolver.ts`. Those ladders rank rows by `kind`
 * alone — but they were handed rows produced by `listByOwner`, which reads and
 * base64-encodes EVERY blob the owner holds before the first comparison is
 * made. Measured on the live hub (2026-08-30): a track's six kinds are
 * 3 597 219 bytes and the tile serves `thumbnailSmall`, 31 155 of them. Forty
 * tiles therefore read ~144 MB off disk and allocated ~190 MB of base64 to
 * deliver ~1.2 MB.
 *
 * The load-bearing assertion is the COUNT OF BLOBS OPENED, not wall clock.
 *
 * The second test is the one that keeps this honest. `listByOwner` silently
 * skipped a row whose blob was missing, so the ladder fell through to the next
 * candidate. Deciding on the index moves that decision BEFORE the read, and a
 * winner whose blob has gone would 404 a tile that used to render. The
 * fall-through has to survive the change — this repo has lost rows to exactly
 * this kind of quiet drop.
 */

import type { MediaFileInfo } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeTestMediaFileInfo } from '../../__tests__/support/media-file.js'
import {
  pickTrackFallbackMedia,
  type ResolvedMediaBytes,
  readWinningBlob,
} from '../event-thumbnail-resolver.js'

/** The real per-track index rows, with the measured byte sizes. A row's own
 *  id is a rowid (D482) — arbitrary, never derived from owner or kind. */
const TRACK_INDEX: readonly MediaFileInfo[] = [
  makeTestMediaFileInfo({ mediaId: 401, kind: 'firstFrame', sizeBytes: 187_000, timestamp: 10 }),
  makeTestMediaFileInfo({ mediaId: 402, kind: 'keyFrame', sizeBytes: 2_824_077, timestamp: 11 }),
  makeTestMediaFileInfo({ mediaId: 403, kind: 'keyFrameSmall', sizeBytes: 177_000, timestamp: 12 }),
  makeTestMediaFileInfo({ mediaId: 404, kind: 'thumbnail', sizeBytes: 200_000, timestamp: 13 }),
  makeTestMediaFileInfo({ mediaId: 405, kind: 'thumbnailSmall', sizeBytes: 31_155, timestamp: 14 }),
  makeTestMediaFileInfo({ mediaId: 406, kind: 'lastFrame', sizeBytes: 177_000, timestamp: 15 }),
]

interface Reader {
  readonly opened: number[]
  readonly read: (mediaId: number) => Promise<ResolvedMediaBytes | null>
}

/** A blob reader that records what it opened. `missing` ids answer null — the
 *  index row survived a blob that did not. */
function makeReader(missing: ReadonlySet<number> = new Set()): Reader {
  const opened: number[] = []
  return {
    opened,
    read: async (mediaId: number) => {
      opened.push(mediaId)
      if (missing.has(mediaId)) return null
      const kind = TRACK_INDEX.find((r) => r.mediaId === mediaId)?.kind ?? 'crop'
      return { bytes: Uint8Array.from([1, 2, 3]), mediaId, kind }
    },
  }
}

describe('readWinningBlob', () => {
  it('opens exactly ONE blob — the ladder winner', async () => {
    const reader = makeReader()

    const out = await readWinningBlob(TRACK_INDEX, pickTrackFallbackMedia, reader.read)

    expect(out?.mediaId).toBe(405)
    expect(reader.opened).toEqual([405])
  })

  it('never opens the 2.8 MB keyFrame to serve a 31 KB tile', async () => {
    const reader = makeReader()
    await readWinningBlob(TRACK_INDEX, pickTrackFallbackMedia, reader.read)
    expect(reader.opened).not.toContain(402)
  })

  it('falls through to the next candidate when the winner has no blob', async () => {
    // What `listByOwner`'s try/catch used to do for free. Losing it would 404 a
    // tile whose index row outlived its file.
    const reader = makeReader(new Set([405]))

    const out = await readWinningBlob(TRACK_INDEX, pickTrackFallbackMedia, reader.read)

    expect(out?.mediaId).toBe(404)
    expect(reader.opened).toEqual([405, 404])
  })

  it('exhausts the whole ladder before giving up, and only then answers null', async () => {
    const reader = makeReader(new Set(TRACK_INDEX.map((r) => r.mediaId)))

    const out = await readWinningBlob(TRACK_INDEX, pickTrackFallbackMedia, reader.read)

    expect(out).toBeNull()
    expect(reader.opened).toHaveLength(TRACK_INDEX.length)
  })

  it('opens nothing at all when the owner has no rows', async () => {
    const reader = makeReader()
    expect(await readWinningBlob([], pickTrackFallbackMedia, reader.read)).toBeNull()
    expect(reader.opened).toHaveLength(0)
  })
})

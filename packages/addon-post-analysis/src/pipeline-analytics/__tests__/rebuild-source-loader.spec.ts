/**
 * What a rebuild PAYS to assemble one track.
 *
 * This is a cost test, and it exists because cost is invisible in the result.
 * The loader used to call `mediaStore.listByOwner`, which reads and
 * base64-encodes EVERY blob a track owns in order to `.find()` two of them — 23
 * files and ~10 MB of string on one measured track. Swapping it back would
 * produce byte-identical output and nothing would fail.
 *
 * So the assertions here are about which store methods were called, and in what
 * order, rather than about the source that comes out.
 */
import { describe, expect, it, vi } from 'vitest'
import type { MediaFileBytes, MediaFileInfo } from '@camstack/types'
import {
  loadRebuildSource,
  type RebuildEventReader,
  type RebuildMediaReader,
  type RebuildObjectEvent,
  type RebuildSubjectBoxRow,
  type RebuildTrackReader,
  type RebuildTrackRow,
} from '../rebuild-source-loader.js'

function info(
  mediaId: number,
  kind: MediaFileInfo['kind'],
  timestamp = KEY_FRAME_TS,
): MediaFileInfo {
  return { mediaId, kind, sizeBytes: 1000, timestamp, url: `/m/${mediaId}` }
}

/** The key frame's own instant — deliberately NOT the event's (1000). */
const KEY_FRAME_TS = 1450

/** A key-frame row that recorded where its subject was (D510), in a 2000×1000 frame. */
function boxed(mediaId: number, kind: MediaFileInfo['kind'] = 'keyFrame'): RebuildSubjectBoxRow {
  return {
    mediaId,
    kind,
    timestamp: KEY_FRAME_TS,
    subjectBox: { x: 400, y: 100, w: 200, h: 500, frameWidth: 2000, frameHeight: 1000 },
  }
}

function file(mediaId: number, kind: MediaFileInfo['kind']): MediaFileBytes {
  return {
    mediaId,
    kind,
    base64: Buffer.from('pixels').toString('base64'),
    sizeBytes: 6,
    timestamp: 1,
  }
}

const EVENT: RebuildObjectEvent = {
  id: 1,
  deviceId: 102,
  timestamp: 1000,
  className: 'person',
  confidence: 0.7,
  bbox: { x: 100, y: 50, w: 200, h: 400 },
  frameWidth: 1000,
  frameHeight: 1000,
}

interface Harness {
  readonly media: RebuildMediaReader
  readonly events: RebuildEventReader
  readonly tracks: RebuildTrackReader
  readonly listInfo: ReturnType<typeof vi.fn>
  readonly getById: ReturnType<typeof vi.fn>
  readonly getTrack: ReturnType<typeof vi.fn>
  readonly calls: string[]
}

const TRACK: RebuildTrackRow = {
  frameWidth: 1000,
  frameHeight: 500,
  positions: [
    { timestamp: 1000, bbox: { x: 0, y: 0, w: 10, h: 10 } },
    { timestamp: KEY_FRAME_TS, bbox: { x: 100, y: 50, w: 250, h: 200 } },
    { timestamp: 1900, bbox: { x: 900, y: 400, w: 10, h: 10 } },
  ],
}

function makeHarness(
  mediaInfo: readonly MediaFileInfo[],
  events: readonly RebuildObjectEvent[] = [EVENT],
  subjectBoxes: readonly RebuildSubjectBoxRow[] = [boxed(1)],
  track: RebuildTrackRow | null = TRACK,
): Harness {
  const calls: string[] = []
  const listInfo = vi.fn(async () => {
    calls.push('listInfoByOwner')
    return mediaInfo
  })
  const getById = vi.fn(async (mediaId: number) => {
    calls.push(`getById:${mediaId}`)
    return file(mediaId, 'keyFrame')
  })
  const getTrack = vi.fn(async () => {
    calls.push('getPersistedByTrackId')
    return track
  })
  return {
    calls,
    listInfo,
    getById,
    getTrack,
    tracks: { getPersistedByTrackId: getTrack },
    media: {
      listInfoByOwner: listInfo,
      listSubjectBoxesByOwner: async () => {
        calls.push('listSubjectBoxesByOwner')
        return subjectBoxes
      },
      getById,
    },
    events: {
      peakForTrack: async () => {
        calls.push('peakForTrack')
        return { bestEventId: '1' }
      },
      queryObjectByTrackIds: async () => {
        calls.push('queryObjectByTrackIds')
        return events
      },
    },
  }
}

describe('loadRebuildSource', () => {
  it('reads metadata, then EXACTLY ONE blob', async () => {
    // The whole point. `listByOwner` would have read all three.
    const h = makeHarness([info(1, 'keyFrame'), info(2, 'thumbnail'), info(3, 'thumbnailSmall')])
    await loadRebuildSource({ media: h.media, events: h.events, tracks: h.tracks }, 't1')

    expect(h.getById).toHaveBeenCalledTimes(1)
    expect(h.getById).toHaveBeenCalledWith(1)
  })

  it('reads the blob AFTER the event resolve, never before', async () => {
    // A track with no event is rejected for free; discovering that after a
    // 4 MB read is the same wasted work, one order of magnitude smaller.
    const h = makeHarness([info(1, 'keyFrame')])
    await loadRebuildSource({ media: h.media, events: h.events, tracks: h.tracks }, 't1')

    // The box comes off the INDEX row (no image read) and is asked before the
    // blob: a key frame nobody can place a box on is refused for free.
    expect(h.calls).toEqual([
      'listInfoByOwner',
      'peakForTrack',
      'queryObjectByTrackIds',
      'listSubjectBoxesByOwner',
      'getById:1',
    ])
  })

  it('reads NOTHING for a track with no object event', async () => {
    const h = makeHarness([info(1, 'keyFrame')], [])
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )

    expect(source).toBeNull()
    expect(h.getById).not.toHaveBeenCalled()
  })

  it('reads NOTHING for a track with no key frame, and still describes it', async () => {
    // The caller owns the `missingKeyFrame` decision; this side must not turn a
    // countable skip into a silent null, nor pay a read to reach it.
    const h = makeHarness([info(2, 'thumbnail')])
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )

    expect(h.getById).not.toHaveBeenCalled()
    expect(source?.keyFrame).toBeNull()
    expect(source?.mediaId).toBe(2)
    expect(source?.deviceId).toBe(102)
  })

  it('carries the thumbnail as an ID, never as bytes', async () => {
    // The vector row points at the thumbnail so a search hit renders the
    // picture the operator recognises. Pointing at it costs nothing; reading it
    // was most of the old cost.
    const h = makeHarness([info(1, 'keyFrame'), info(2, 'thumbnail')])
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )

    expect(source?.mediaId).toBe(2)
    expect(source?.keyFrameMediaId).toBe(1)
    expect(h.getById.mock.calls.map((c) => c[0])).toEqual([1])
  })

  // ── D664: the box is the one measured on the key frame itself ─────────
  //
  // The rebuild used to take the box of `bestEventId`'s event — measured on a
  // DIFFERENT frame (median IoU 0.50 against the key frame's own subjectBox,
  // 6/36 under 0.1: crop off the subject), and since 2026-09-07 usually a
  // `left` departure with no box at all (missingBbox).

  it('takes the box from the key frame row’s own subjectBox, normalised by THAT frame', async () => {
    const h = makeHarness([info(1, 'keyFrame')])
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.bbox).toEqual({ x: 0.2, y: 0.1, w: 0.1, h: 0.5 })
    expect(source?.boxSource).toEqual({ kind: 'subjectBox' })
    // The instant is the key frame's, not the event's.
    expect(source?.timestamp).toBe(KEY_FRAME_TS)
    // Never the track row when the media row can answer.
    expect(h.getTrack).not.toHaveBeenCalled()
  })

  it('ignores a subjectBox that belongs to ANOTHER media row', async () => {
    // keyFrameSmall shares the instant but is another row; the key frame row
    // itself carries none → the positions fallback, not a borrowed box.
    const h = makeHarness(
      [info(1, 'keyFrame'), info(4, 'keyFrameSmall')],
      [EVENT],
      [boxed(4, 'keyFrameSmall')],
    )
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.boxSource).toEqual({ kind: 'positions' })
  })

  it('a key frame WITHOUT subjectBox takes track.positions at EXACTLY its instant', async () => {
    const h = makeHarness([info(1, 'keyFrame')], [EVENT], [])
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.bbox).toEqual({ x: 0.1, y: 0.1, w: 0.25, h: 0.4 })
    expect(source?.boxSource).toEqual({ kind: 'positions' })
    expect(source?.timestamp).toBe(KEY_FRAME_TS)
  })

  it('REFUSES by name when no position sits exactly on the key frame (D303) — no nearest', async () => {
    const off: RebuildTrackRow = {
      ...TRACK,
      positions: [{ timestamp: KEY_FRAME_TS + 1, bbox: { x: 100, y: 50, w: 250, h: 200 } }],
    }
    const h = makeHarness([info(1, 'keyFrame')], [EVENT], [], off)
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.bbox).toBeNull()
    expect(source?.boxSource).toEqual({ kind: 'refused', reason: 'no-position-at-key-frame' })
    // Refused BEFORE the blob — the cheap question first (D54).
    expect(h.getById).not.toHaveBeenCalled()
  })

  it('REFUSES by name when the track frame size is unknown', async () => {
    const h = makeHarness([info(1, 'keyFrame')], [EVENT], [], { positions: TRACK.positions })
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.boxSource).toEqual({ kind: 'refused', reason: 'track-frame-size-unknown' })
    expect(source?.bbox).toBeNull()
  })

  it('REFUSES by name when the track row is gone', async () => {
    const h = makeHarness([info(1, 'keyFrame')], [EVENT], [], null)
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.boxSource).toEqual({ kind: 'refused', reason: 'track-row-missing' })
  })

  it('NEVER uses the event box for a stored key frame, even when the event has one', async () => {
    // The event was measured on another frame; cutting it from the key frame
    // is the off-subject crop D303 forbids.
    const h = makeHarness([info(1, 'keyFrame')], [EVENT], [], {
      positions: [],
      frameWidth: 1000,
      frameHeight: 1000,
    })
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.bbox).toBeNull()
    expect(source?.boxSource.kind).toBe('refused')
  })

  it('a track with NO key frame row uses the event box at the EVENT instant (recovery decodes there)', async () => {
    const h = makeHarness([info(2, 'thumbnail')])
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.bbox).toEqual({ x: 0.1, y: 0.05, w: 0.2, h: 0.4 })
    expect(source?.boxSource).toEqual({ kind: 'event' })
    expect(source?.timestamp).toBe(EVENT.timestamp)
    expect(source?.keyFrame).toBeNull()
  })

  it('a track with no key frame and a box-less event is refused by name', async () => {
    const { bbox: _gone, ...noBox } = EVENT
    const h = makeHarness([info(2, 'thumbnail')], [noBox])
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.boxSource).toEqual({ kind: 'refused', reason: 'event-without-box' })
  })

  it('falls back to the first event when the peak names none', async () => {
    const h = makeHarness([info(1, 'keyFrame')], [{ ...EVENT, id: 999 }])
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.className).toBe('person')
  })

  it('a blob that has gone missing yields a null key frame, not a throw', async () => {
    const h = makeHarness([info(1, 'keyFrame')])
    h.getById.mockResolvedValue(null)
    const source = await loadRebuildSource(
      { media: h.media, events: h.events, tracks: h.tracks },
      't1',
    )
    expect(source?.keyFrame).toBeNull()
  })
})

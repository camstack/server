/**
 * Unit tests for the default-path event thumbnail resolver.
 *
 * The plain `mediaUrl` (event detail / event-keyed list surfaces) resolves an
 * event id to media. Since `crop` / `fullFrameBoxed` are RETIRED for new
 * tracks, a common object event owns no media and MUST resolve via its OWNING
 * TRACK (the event row carries `trackId`); old stored events keep resolving by
 * their own `crop`. A KeyEvent passes its track id as the event id — the
 * object-event lookup misses and the id is treated AS a track id.
 */

import type { MediaFile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeTestMediaFile } from '../../__tests__/support/media-file.js'
import {
  collectCropForcedMedia,
  collectDefaultEventMedia,
  pickEventOwnedMedia,
  pickTrackFallbackMedia,
  resolveCropForcedMedia,
} from '../event-thumbnail-resolver.js'

// A media row's id is a surrogate rowid (D482) — arbitrary and unrelated to
// its owner or kind. Unless a test needs to pick a specific row back out
// again (in which case it passes an explicit id), a fresh unique one is
// minted, which is closer to production than reusing a per-kind default ever
// was.
let nextMediaId = 1
function file(kind: MediaFile['kind'], mediaId?: number): MediaFile {
  return makeTestMediaFile({
    mediaId: mediaId ?? nextMediaId++,
    kind,
    base64: 'AAAA',
    sizeBytes: 4,
    timestamp: 1_000,
  })
}

// A stand-in for the addon's `pickCleanMedia(files, 'crop')` — clean kinds only.
const CLEAN = new Set<MediaFile['kind']>(['crop', 'thumbnail', 'thumbnailSmall'])
const pickCleanStub = (files: readonly MediaFile[]): MediaFile | undefined =>
  files.find((f) => CLEAN.has(f.kind))

describe('resolveCropForcedMedia', () => {
  it('prefers a CLEAN frame when one exists', () => {
    const files = [file('lastFrame'), file('thumbnail'), file('snapshot')]
    expect(resolveCropForcedMedia(files, pickCleanStub)?.kind).toBe('thumbnail')
  })

  it('falls back to a full-frame tile when the subject crop is missing', () => {
    // Operator rule 2026-08-24: never show the class icon while ANY image
    // exists. A keyFrame of the parking lot is worse than a person crop and
    // better than an empty tile (20da3195, 86918072).
    const files = [file('snapshot'), file('lastFrame'), file('keyFrame')]
    expect(resolveCropForcedMedia(files, pickCleanStub)?.kind).toBe('keyFrame')
  })

  it('prefers a body thumbnail over a tight face/plate crop', () => {
    const body = [file('thumbnail', 201)]
    const detail = [file('crop', 202)]
    expect(resolveCropForcedMedia(body, pickCleanStub, detail)?.mediaId).toBe(201)
  })

  it('serves a face crop rather than the class icon when the track has no body media', () => {
    const detail = [file('crop', 202)]
    expect(resolveCropForcedMedia([], pickCleanStub, detail)?.mediaId).toBe(202)
  })

  it('returns undefined only when the owner has no media at all', () => {
    expect(resolveCropForcedMedia([], pickCleanStub)).toBeUndefined()
  })
})

describe('pickEventOwnedMedia', () => {
  it('prefers the legacy crop', () => {
    expect(pickEventOwnedMedia([file('fullFrameBoxed'), file('crop')])?.kind).toBe('crop')
  })

  it('falls back to fullFrameBoxed, then any file', () => {
    expect(pickEventOwnedMedia([file('snapshot'), file('fullFrameBoxed')])?.kind).toBe(
      'fullFrameBoxed',
    )
    expect(pickEventOwnedMedia([file('snapshot')])?.kind).toBe('snapshot')
  })

  it('returns undefined for an empty list', () => {
    expect(pickEventOwnedMedia([])).toBeUndefined()
  })
})

describe('pickTrackFallbackMedia', () => {
  it('prefers the best thumbnail', () => {
    expect(pickTrackFallbackMedia([file('lastFrame'), file('thumbnail')])?.kind).toBe('thumbnail')
  })

  it('prefers thumbnailSmall (fast-load) over the native thumbnail', () => {
    expect(
      pickTrackFallbackMedia([file('lastFrame'), file('thumbnail'), file('thumbnailSmall')])?.kind,
    ).toBe('thumbnailSmall')
  })

  it('degrades thumbnail → keyFrame → lastFrame → firstFrame → snapshot → any', () => {
    expect(pickTrackFallbackMedia([file('firstFrame'), file('lastFrame')])?.kind).toBe('lastFrame')
    expect(pickTrackFallbackMedia([file('snapshot'), file('firstFrame')])?.kind).toBe('firstFrame')
    expect(pickTrackFallbackMedia([file('keyFrame'), file('snapshot')])?.kind).toBe('keyFrame')
    expect(pickTrackFallbackMedia([file('lastFrame'), file('keyFrame')])?.kind).toBe('keyFrame')
    expect(pickTrackFallbackMedia([file('keyFrame')])?.kind).toBe('keyFrame')
  })

  it('returns undefined for an empty list', () => {
    expect(pickTrackFallbackMedia([])).toBeUndefined()
  })
})

/** The default path yields candidates + a ladder; the winner is what the
 *  caller would then open. */
async function chooseDefault(
  deps: Parameters<typeof collectDefaultEventMedia<MediaFile>>[0],
): Promise<MediaFile | null> {
  const { candidates, pick } = await collectDefaultEventMedia(deps)
  return pick(candidates) ?? null
}

describe('collectDefaultEventMedia', () => {
  it('resolves a new-style event (no own media) via its owning track thumbnail', async () => {
    let trackLookedUp: string | null = null
    const chosen = await chooseDefault({
      ownerType: 'object',
      ownerId: 'evt-1',
      ownFiles: [],
      getTrackIdForEvent: async (id) => (id === 'evt-1' ? 'track-9' : null),
      listTrackMedia: async (tid) => {
        trackLookedUp = tid
        return [file('lastFrame'), file('thumbnail', 203)]
      },
    })
    expect(chosen?.mediaId).toBe(203)
    expect(trackLookedUp).toBe('track-9')
  })

  it('resolves a legacy event by its own crop, never touching the track', async () => {
    let trackTouched = false
    const chosen = await chooseDefault({
      ownerType: 'object',
      ownerId: 'evt-legacy',
      ownFiles: [file('crop', 204)],
      getTrackIdForEvent: async () => {
        throw new Error('should not resolve track when event owns a crop')
      },
      listTrackMedia: async () => {
        trackTouched = true
        return []
      },
    })
    expect(chosen?.mediaId).toBe(204)
    expect(trackTouched).toBe(false)
  })

  it('returns null when the event owns nothing and its track has no media', async () => {
    const chosen = await chooseDefault({
      ownerType: 'object',
      ownerId: 'evt-2',
      ownFiles: [],
      getTrackIdForEvent: async () => 'track-empty',
      listTrackMedia: async () => [],
    })
    expect(chosen).toBeNull()
  })

  it('treats the id AS a track id when no object event owns it (KeyEvent path)', async () => {
    const chosen = await chooseDefault({
      ownerType: 'object',
      ownerId: 'track-key',
      ownFiles: [],
      getTrackIdForEvent: async () => null,
      listTrackMedia: async (tid) => (tid === 'track-key' ? [file('thumbnail', 205)] : []),
    })
    expect(chosen?.mediaId).toBe(205)
  })

  it('a TRACK owner with no media of its own answers empty WITHOUT asking for a track id — there is no second place to look', async () => {
    let trackIdAsked = false
    const chosen = await chooseDefault({
      ownerType: 'track',
      ownerId: 'track-lonely',
      ownFiles: [],
      getTrackIdForEvent: async () => {
        trackIdAsked = true
        return null
      },
      listTrackMedia: async () => [file('thumbnail', 999)],
    })
    expect(chosen).toBeNull()
    expect(trackIdAsked).toBe(false)
  })
})

describe('collectCropForcedMedia', () => {
  it('includes the face crop when the track owns no media (0e343f86)', async () => {
    const listed: string[] = []
    const layers = await collectCropForcedMedia(
      {
        listByOwner: async (ownerKind, ownerId) => {
          listed.push(`${ownerKind}:${ownerId}`)
          if (ownerKind === 'face' && ownerId === 'face-0e343f86') {
            return [file('crop', 206)]
          }
          return []
        },
        getTrackIdForEvent: async () => null,
      },
      '0e343f86',
      [], // ownFiles — fetched by the caller (D476), none here
    )
    expect(layers.bodyFiles).toEqual([])
    expect(layers.detailFiles.map((f) => f.mediaId)).toEqual([206])
    expect(listed).toContain('face:face-0e343f86')
    expect(listed).toContain('plate:plate-0e343f86')
    expect(listed).not.toContain('event:0e343f86')
  })

  it('resolves an object-event id to the owning track face/plate owners', async () => {
    const layers = await collectCropForcedMedia(
      {
        listByOwner: async (ownerKind, ownerId) => {
          if (ownerKind === 'track' && ownerId === 'track-9') return [file('keyFrame', 208)]
          if (ownerKind === 'plate' && ownerId === 'plate-track-9') {
            return [file('crop', 207)]
          }
          return []
        },
        getTrackIdForEvent: async (id) => (id === 'evt-1' ? 'track-9' : null),
      },
      'evt-1',
      [], // no owner-owned media — the object event has none
    )
    expect(layers.bodyFiles.map((f) => f.mediaId)).toEqual([208])
    expect(layers.detailFiles.map((f) => f.mediaId)).toEqual([207])
  })

  it('includes the caller-supplied ownFiles in bodyFiles', async () => {
    const layers = await collectCropForcedMedia(
      {
        listByOwner: async () => [],
        getTrackIdForEvent: async () => null,
      },
      'm-1',
      [file('snapshot', 209)],
    )
    expect(layers.bodyFiles.map((f) => f.mediaId)).toEqual([209])
  })
})

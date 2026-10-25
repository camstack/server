/**
 * The night-time thumbnail, reduced to a test (D482).
 *
 * ## What the operator saw
 *
 * A track from 2026-09-12 17:34 on camera 101 showed a NIGHT-TIME picture.
 * Its `bestEventId` was `101314` — an object event created that afternoon, the
 * migrated maximum being 100 051 — and `listEventMedia({ eventId: '101314' })`
 * answered with exactly one row: a `snapshot` from 02/09 22:35.
 *
 * An event created today cannot own media from eleven days earlier. The row
 * belonged to **motion #101314**, a different table's row that spells the same
 * number, because D474 made every event id a per-table SQLite rowid alias.
 * D476 had already split the media KEY three ways (`motion:` / `object:` /
 * `audio:`) — but `getEventMedia` / `listEventMedia` still took a bare id and
 * the provider probed motion → object → audio, stopping at the first table
 * that owned anything.
 *
 * That probe was not a coin flip. Measured on a copy of the live hub
 * (2026-09-12): of 300 559 event-owned media rows, **299 883 are `motion` and
 * ZERO are `object`** — object events own their media through their TRACK, not
 * directly. So the probe answered `motion` every single time an object id had
 * a motion namesake, and object ids 1–100 051 all do (motion runs to
 * 1 665 459). 27 084 tracks carry a non-empty `bestEventId`.
 *
 * ## What is asserted
 *
 * The owner TYPE is part of the question. Asking for object #101314's media
 * gets object #101314's media — which is NOTHING, and nothing is the correct
 * answer. That is the whole fix: a listing by owner cannot be answered from
 * another owner's rows.
 *
 * The surrogate `media.id` alone does NOT close this defect, and that is worth
 * writing down: the address stops embedding a foreign id, so a media URL can
 * never name the wrong row — but a LOOKUP BY OWNER still needs the owner, and
 * an owner is `(table, id)`. Both halves of D482 are load-bearing.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import { MediaStore } from '../store/media-store.js'

/** The id from the report. Object #101314 and motion #101314 both exist. */
const COLLIDING_ID = 101_314
const DEVICE_ID = 101
const PREFIX = '/addon/pipeline-analytics/event-media'

interface StoredRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

/**
 * The live-hub shape: the motion namesake owns a snapshot, the object event
 * owns nothing at all. Its media hangs off its track.
 */
const ROWS: readonly StoredRow[] = [
  {
    // 02/09 22:35 — the night-time picture the operator was shown.
    id: '7701',
    data: {
      ownerKind: 'motion',
      ownerId: String(COLLIDING_ID),
      deviceId: DEVICE_ID,
      kind: 'snapshot',
      timestamp: 1_788_363_763_546,
      slotTs: 1_788_363_763_546,
      sizeBytes: 51_200,
      path: 'night.jpg',
    },
  },
]

function makeStore(): MediaStore {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as unknown as IScopedLogger
  return new MediaStore({
    logger,
    storage: {
      write: async () => {},
      read: async () => Buffer.from('jpeg'),
      delete: async () => {},
      exists: async () => true,
    } as never,
    store: {
      query: {
        query: async (input: {
          filter?: { where?: Record<string, unknown> }
        }): Promise<readonly StoredRow[]> => {
          const where = input.filter?.where ?? {}
          return ROWS.filter(
            (row) =>
              Object.entries(where).every(([k, v]) => row.data[k] === v) ||
              // `deviceId` is stamped as a number and compared as one.
              Object.entries(where).every(([k, v]) => String(row.data[k]) === String(v)),
          )
        },
      },
    } as never,
  })
}

function makeFacade(store: MediaStore): AnalyticsQueryFacade {
  return new AnalyticsQueryFacade({
    mediaStore: () => store,
    eventMediaPathPrefix: () => PREFIX,
    eventMediaBaseUrl: () => PREFIX,
  } as never)
}

describe('event media names its table', () => {
  it('asking for the OBJECT event returns nothing — not the motion namesake', async () => {
    const facade = makeFacade(makeStore())
    const rows = await facade.listEventMedia({
      ownerType: 'object',
      eventId: COLLIDING_ID,
      deviceId: DEVICE_ID,
    })
    // The object event owns no media. Empty is the truth; the night snapshot
    // was never its to serve.
    expect(rows).toEqual([])
  })

  it('asking for the MOTION event returns the motion event’s own row', async () => {
    const facade = makeFacade(makeStore())
    const rows = await facade.listEventMedia({
      ownerType: 'motion',
      eventId: COLLIDING_ID,
      deviceId: DEVICE_ID,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('snapshot')
    expect(rows[0]?.timestamp).toBe(1_788_363_763_546)
  })

  it('the row it hands back is addressed by its OWN id, not by its owner', async () => {
    const facade = makeFacade(makeStore())
    const rows = await facade.listEventMedia({
      ownerType: 'motion',
      eventId: COLLIDING_ID,
      deviceId: DEVICE_ID,
    })
    const row = rows[0]
    expect(row?.mediaId).toBe(7701)
    expect(row?.url).toBe(`${PREFIX}/m/7701`)
    // Nothing in the address names the owner, so no consumer can accidentally
    // hand it another table's id.
    expect(row?.url).not.toContain(String(COLLIDING_ID))
    expect(row?.url).not.toContain('motion')
  })

  it('getEventMedia answers the same question, with the bytes', async () => {
    const facade = makeFacade(makeStore())
    const objectRows = await facade.getEventMedia({
      ownerType: 'object',
      eventId: COLLIDING_ID,
      deviceId: DEVICE_ID,
    })
    expect(objectRows).toEqual([])

    const motionRows = await facade.getEventMedia({
      ownerType: 'motion',
      eventId: COLLIDING_ID,
      deviceId: DEVICE_ID,
    })
    expect(motionRows).toHaveLength(1)
    expect(motionRows[0]?.mediaId).toBe(7701)
  })
})

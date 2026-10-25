/**
 * `getFaceMedia` / `getPlateMedia` carry an ADDRESS, never bytes.
 *
 * ## Why these two could go all the way when `getTrackMedia` could not
 *
 * `MediaFileSchema`'s `base64` is still populated because the deployed viewer
 * requires the field to parse a track-media row at all. These two methods have
 * no such reader: each is called from exactly ONE place — the admin UI's face
 * and plate detail modals — and neither the viewer nor the embed calls them at
 * all. So for these the field is not transitional, it is dead, and it is
 * deleted here rather than carried.
 *
 * ## What the modals actually needed
 *
 * They needed a crop to render, and they were building
 * `data:image/jpeg;base64,…` from a row whose `id` was sitting right beside
 * it — while the very same panels already rendered their key FRAME from the
 * `event-media` plane through `useKeyFrameAdapter`. The plane addresses one
 * row by its OWN id (`/addon/<addonId>/event-media/m/<mediaId>`, D482), so
 * this needs no new plane and no new access decision: the same
 * `authenticated` level already serves the key frame the operator is looking
 * at in the same dialog.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { MediaStore } from '../store/media-store.js'

const FACE_ID = 'face-a3019e7a-ff67-4098-aae4-20dd552dedbe'
const PLATE_ID = 'plate-a3019e7a-ff67-4098-aae4-20dd552dedbe'
const PREFIX = '/addon/pipeline-analytics/event-media'

interface StoredRow {
  readonly id: string
  readonly data: Record<string, unknown>
}

const ROWS: readonly StoredRow[] = [
  {
    id: '14',
    data: {
      ownerKind: 'face',
      ownerId: FACE_ID,
      deviceId: 102,
      kind: 'crop',
      sizeBytes: 8_204,
      timestamp: 14,
      path: 'c',
    },
  },
  {
    id: '15',
    data: {
      ownerKind: 'plate',
      ownerId: PLATE_ID,
      deviceId: 102,
      kind: 'crop',
      sizeBytes: 6_180,
      timestamp: 15,
      path: 'd',
    },
  },
]

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

interface QueryFilter {
  readonly where?: Record<string, unknown>
}

interface QueryInput {
  readonly collection: string
  readonly filter?: QueryFilter
}

function makeStore(): MediaStore {
  const settings = {
    query: {
      query: async (input: QueryInput): Promise<readonly StoredRow[]> => {
        const where = input.filter?.where ?? {}
        return ROWS.filter((row) =>
          Object.entries(where).every(([field, value]) => row.data[field] === value),
        )
      },
    },
    declareCollection: { mutate: async (): Promise<void> => undefined },
    set: { mutate: async (): Promise<void> => undefined },
    delete: { mutate: async (): Promise<void> => undefined },
  }
  const storage = {
    read: async (): Promise<Buffer> => Buffer.from('jpeg-bytes'),
    write: async (): Promise<void> => undefined,
    delete: async (): Promise<void> => undefined,
  }
  return new MediaStore({
    store: settings,
    storage,
    logger: silentLogger,
  } as unknown as ConstructorParameters<typeof MediaStore>[0])
}

/** The provider method bodies are one `map` each over `listByOwner`; both are
 *  exercised through the shared helper they now both call. */
import { toGalleryMediaRow } from '../gallery-media-row.js'

describe('gallery media rows', () => {
  it('address the face crop on the event-media plane', async () => {
    const rows = await makeStore().listByOwner('face', FACE_ID)
    const wire = rows.map((row) => toGalleryMediaRow(row, PREFIX))
    expect(wire).toHaveLength(1)
    expect(wire[0]?.url).toBe(`${PREFIX}/m/14`)
  })

  it('address the plate crop the same way', async () => {
    const rows = await makeStore().listByOwner('plate', PLATE_ID)
    const wire = rows.map((row) => toGalleryMediaRow(row, PREFIX))
    expect(wire[0]?.url).toBe(`${PREFIX}/m/15`)
  })

  it('carry NO base64 — the field is gone, not merely unread', async () => {
    const rows = await makeStore().listByOwner('face', FACE_ID)
    for (const row of rows.map((r) => toGalleryMediaRow(r, PREFIX))) {
      expect(row).not.toHaveProperty('base64')
    }
  })

  it('keep the mediaId, kind and size the modal picks a crop with', async () => {
    const rows = await makeStore().listByOwner('face', FACE_ID)
    const wire = rows.map((row) => toGalleryMediaRow(row, PREFIX))
    expect(wire[0]?.kind).toBe('crop')
    expect(wire[0]?.sizeBytes).toBe(8_204)
    expect(wire[0]?.mediaId).toBe(14)
    expect(wire[0]?.timestamp).toBe(14)
  })
})

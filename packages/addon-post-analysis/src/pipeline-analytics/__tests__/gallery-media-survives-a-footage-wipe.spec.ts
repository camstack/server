/**
 * The enrolled gallery must not live on the footage volume.
 *
 * ## What this pins, and what it cost to learn
 *
 * `RETENTION_EXEMPT_OWNER_KINDS` declares `identity` / `vehicle` / `scene`
 * media immortal, and every sweep in the addon honours it. That exemption is
 * enforced in SOFTWARE only: the blobs were written to the `eventMedia`
 * location, whose declaration says `defaultsTo: 'recordings'` — the footage
 * volume. Footage is the disposable class by definition: quota-evicted,
 * per-device, wipeable from the recordings UI, and swappable for another disk.
 *
 * On 2026-08-17 the operator wiped the recordings volume. Every
 * `<deviceId>/events/identity/**` blob went with it, together with the scene
 * reference photographs and the whole retrain frame dataset. The index rows
 * survived — `coverMediaId` still present, `coverBase64` absent on all four
 * identities — and 28 of 32 gallery samples became un-re-embeddable forever.
 * Nothing reported it, because the disk-wins reconcile deliberately does not
 * probe exempt owner kinds: the exemption is exactly what stopped anyone
 * noticing that the exempt bytes were already gone.
 *
 * So the invariant is not "a sweep must skip identity". It is **an entity
 * retention declares immortal does not live on a volume whose contract is
 * disposal** — its blob belongs beside its row, on the data volume.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SettingsStoreClient } from '@camstack/types'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
  type FakeSettingsStore,
  type FakeStorageProvider,
} from './test-helpers.js'
import {
  DEFAULT_MEDIA_LOCATION,
  GALLERY_MEDIA_LOCATION,
  GALLERY_TENANT_SUBPATH,
  LEGACY_ADDON_DATA_GALLERY_LOCATION,
  locationForOwnerKind,
  MEDIA_COLLECTION,
  MediaStore,
  OWNER_KINDS,
} from '../store/media-store.js'
import { isRetentionExemptOwnerKind } from '../retention/retention-model.js'

describe('enrolled gallery media lives off the footage volume', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let store: MediaStore

  /** Everything the recordings volume held, gone — the 2026-08-17 wipe. */
  const wipeTheFootageVolume = (): void => {
    for (const key of [...storage.files.keys()]) {
      if (key.startsWith(`${DEFAULT_MEDIA_LOCATION}:`)) storage.files.delete(key)
    }
  }

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    storage = makeFakeStorageProvider()
    store = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    await MediaStore.declare(fake.client)
  })

  it('routes exactly the retention-exempt owner kinds to the gallery location — both directions', () => {
    // Derived from the two declarations, never a third hand-written list: a
    // new exempt kind is protected the moment it is declared exempt.
    for (const kind of OWNER_KINDS) {
      expect(locationForOwnerKind(kind)).toBe(
        isRetentionExemptOwnerKind(kind) ? GALLERY_MEDIA_LOCATION : DEFAULT_MEDIA_LOCATION,
      )
    }
    expect(GALLERY_MEDIA_LOCATION).not.toBe(DEFAULT_MEDIA_LOCATION)
    // The gallery is a declared storage LOCATION, resolved through the
    // storage cap — never the addon's data dir ("le cartelle addons non
    // devono trasportare nulla" [the addons folders must not carry anything], operator 2026-09-04, D341) and never the
    // footage volume (D197). The 2026-08-31 addon-data pin is a legacy row
    // value the read alias still resolves; it must never be the write target
    // again.
    expect(GALLERY_MEDIA_LOCATION).toBe('galleryMedia')
    expect(GALLERY_MEDIA_LOCATION).not.toBe(LEGACY_ADDON_DATA_GALLERY_LOCATION)
  })

  // The gallery is the THIRD tenant of the shared `artifacts` class (operator
  // 2026-09-04: one class, one root — "no nessuna eccezione. Rimane li in
  // artifacts." [no, no exception. It stays there in artifacts.]). `galleryMedia` is no longer a declared storage class: it is
  // the rows' PERMANENT locationId ref, mapped by the media-storage wiring to
  // the `gallery/` tenant subtree of the artifacts root. Rows are never
  // restamped for this move — remapping the ref is what makes a
  // second missing-count disaster unrepresentable.
  it('the gallery is a TENANT of artifacts, not a declared class of its own', () => {
    expect(GALLERY_TENANT_SUBPATH).toBe('gallery')
    const raw: unknown = JSON.parse(
      readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'),
    )
    const addons = (
      raw as {
        camstack?: {
          addons?: readonly { id: string; storageLocations?: readonly { id: string }[] }[]
        }
      }
    ).camstack?.addons
    const analytics = addons?.find((a) => a.id === 'pipeline-analytics')
    const ids = (analytics?.storageLocations ?? []).map((d) => d.id)
    // A leftover declaration would re-seed a location nobody resolves.
    expect(ids).not.toContain('galleryMedia')
    expect(ids).toContain('artifacts')
  })

  it('an identity crop is written to the gallery location and its row says so', async () => {
    const mediaId = await store.put({
      deviceId: 107,
      ownerKind: 'identity',
      ownerId: 'ident-1',
      kind: 'crop',
      timestamp: 1000,
      data: Buffer.from('face'),
    })

    expect([...storage.files.keys()]).toEqual([
      `${GALLERY_MEDIA_LOCATION}:107/events/identity/ident-1/crop-1000.jpg`,
    ])
    const row = (await fake.client.get.query({
      collection: MEDIA_COLLECTION,
      key: String(mediaId),
    })) as Record<string, unknown> | null
    // A NULL locationId means "the eventMedia default", which is the footage
    // volume — the row has to NAME its location or a repoint re-aims it.
    expect(row?.['locationId']).toBe(GALLERY_MEDIA_LOCATION)
  })

  it('an unassigned face crop stays on the footage volume and dies with the wipe', async () => {
    const mediaId = await store.put({
      deviceId: 107,
      ownerKind: 'face',
      ownerId: 'face-t1',
      kind: 'crop',
      timestamp: 1000,
      data: Buffer.from('face'),
    })
    expect(await store.getById(mediaId)).not.toBeNull()

    wipeTheFootageVolume()

    // The control: an UNenrolled crop is footage and is expected to go. If it
    // survived here the wipe simulation would be proving nothing.
    expect(await store.getById(mediaId)).toBeNull()
  })

  it('THE CHAIN: enrolment moves the crop off the footage volume, so a wipe cannot un-enrol', async () => {
    // 1. The recognizer buffers the aligned crop under the track's face owner.
    const faceMediaId = await store.put({
      deviceId: 107,
      ownerKind: 'face',
      ownerId: 'face-t1',
      kind: 'crop',
      timestamp: 1000,
      data: Buffer.from('aligned-112x112'),
    })

    // 2. The operator enrols it — `assignFace` reowns face → identity.
    const identityMediaId = await store.reown({
      fromOwnerKind: 'face',
      fromOwnerId: 'face-t1',
      toOwnerKind: 'identity',
      toOwnerId: 'ident-1',
      mediaId: faceMediaId,
    })
    expect(await store.getById(identityMediaId)).not.toBeNull()

    // 3. The recordings volume is wiped.
    wipeTheFootageVolume()

    // 4. The gallery is still a gallery.
    const media = await store.getById(identityMediaId)
    expect(media).not.toBeNull()
    expect(Buffer.from(media!.base64, 'base64').toString()).toBe('aligned-112x112')
  })

  it('un-assignment puts the crop BACK on the footage volume — the gallery volume holds only enrolled bytes', async () => {
    const faceMediaId = await store.put({
      deviceId: 107,
      ownerKind: 'face',
      ownerId: 'face-t1',
      kind: 'crop',
      timestamp: 1000,
      data: Buffer.from('aligned'),
    })
    const identityMediaId = await store.reown({
      fromOwnerKind: 'face',
      fromOwnerId: 'face-t1',
      toOwnerKind: 'identity',
      toOwnerId: 'ident-1',
      mediaId: faceMediaId,
    })
    const backMediaId = await store.reown({
      fromOwnerKind: 'identity',
      fromOwnerId: 'ident-1',
      toOwnerKind: 'face',
      toOwnerId: 'face-t1',
      mediaId: identityMediaId,
    })

    expect([...storage.files.keys()]).toEqual([
      `${DEFAULT_MEDIA_LOCATION}:107/events/face/face-t1/crop-1000.jpg`,
    ])
    expect(await store.getById(backMediaId)).not.toBeNull()
  })

  describe('relocateExemptMediaToGallery — the rows written before this fix', () => {
    /**
     * Write an exempt row the OLD way: onto the footage volume, unstamped.
     *
     * The row's own id used to be its composite key; under D482 it is an
     * INTEGER rowid the table's own migration assigned when it was rebuilt —
     * a pre-existing row is simply SOME number after that rebuild, so the
     * seed picks one directly rather than reconstructing the retired key
     * shape.
     */
    const seedLegacyIdentityRow = async (input: {
      readonly mediaId: number
      readonly deviceId: number
      readonly ownerId: string
      readonly timestamp: number
      readonly data: Buffer
    }): Promise<number> => {
      const path = `${input.deviceId}/events/identity/${input.ownerId}/crop-${input.timestamp}.jpg`
      await storage.write({
        location: DEFAULT_MEDIA_LOCATION,
        relativePath: path,
        data: input.data,
      })
      await (fake.client as SettingsStoreClient).set.mutate({
        collection: MEDIA_COLLECTION,
        key: String(input.mediaId),
        value: {
          deviceId: input.deviceId,
          ownerKind: 'identity',
          ownerId: input.ownerId,
          kind: 'crop',
          timestamp: input.timestamp,
          path,
          sizeBytes: input.data.length,
          locationId: null,
        },
      })
      return input.mediaId
    }

    it('moves a legacy identity blob onto the gallery volume, and it then survives a wipe', async () => {
      const mediaId = await seedLegacyIdentityRow({
        mediaId: 9001,
        deviceId: 107,
        ownerId: 'ident-1',
        timestamp: 1000,
        data: Buffer.from('legacy-face'),
      })

      const moved = await store.relocateExemptMediaToGallery()
      expect(moved.relocated).toBe(1)
      expect(moved.failed).toBe(0)

      wipeTheFootageVolume()

      const media = await store.getById(mediaId)
      expect(media).not.toBeNull()
      expect(Buffer.from(media!.base64, 'base64').toString()).toBe('legacy-face')
    })

    it('is idempotent — a second pass moves nothing', async () => {
      await seedLegacyIdentityRow({
        mediaId: 9001,
        deviceId: 107,
        ownerId: 'ident-1',
        timestamp: 1000,
        data: Buffer.from('legacy-face'),
      })
      await store.relocateExemptMediaToGallery()
      expect((await store.relocateExemptMediaToGallery()).relocated).toBe(0)
    })

    it('a row whose blob is ALREADY gone is counted as lost and its row is left standing', async () => {
      // The 28. The embedding in `identity-samples` is still a valid matching
      // vector, so the row must NOT be collected — but the pass has to say so
      // out loud rather than report a clean run.
      await (fake.client as SettingsStoreClient).set.mutate({
        collection: MEDIA_COLLECTION,
        key: '9001',
        value: {
          deviceId: 107,
          ownerKind: 'identity',
          ownerId: 'ident-1',
          kind: 'crop',
          timestamp: 1000,
          path: '107/events/identity/ident-1/crop-1000.jpg',
          sizeBytes: 4,
          locationId: null,
        },
      })

      const result = await store.relocateExemptMediaToGallery()
      expect(result.relocated).toBe(0)
      expect(result.missing).toBe(1)
      expect(
        await fake.client.get.query({
          collection: MEDIA_COLLECTION,
          key: '9001',
        }),
      ).not.toBeNull()
    })
  })
})

/**
 * PlateGalleryProvider — vehicle CRUD + assign/unassign tests.
 *
 * Mirrors face-gallery-provider.spec's real-store-with-spies harness so
 * `recomputeTrackImportance` runs against real Track/Event stores.
 */

import type { PipelineAnalyticsPlateGalleryChangedPayload } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { mediaFileUrl } from '../media-file-url.js'
import { PlateGalleryProvider } from '../plate-gallery-provider.js'
import { EventStore } from '../store/event-store.js'
import { MediaStore } from '../store/media-store.js'
import { PlateStore } from '../store/plate-store.js'
import { TrackStore } from '../store/track-store.js'
import { VehicleStore } from '../store/vehicle-store.js'
import { makeFakeSettingsStore, makeFakeStorageProvider, makeSilentLogger } from './test-helpers.js'
import { makeAnalyticsWorld } from './fake-records.js'

const EVENT_MEDIA_BASE = '/addon/pipeline-analytics/event-media'

function makeEmit(): {
  readonly emitted: PipelineAnalyticsPlateGalleryChangedPayload[]
  emit: (payload: PipelineAnalyticsPlateGalleryChangedPayload) => void
} {
  const emitted: PipelineAnalyticsPlateGalleryChangedPayload[] = []
  return { emitted, emit: (payload) => emitted.push(payload) }
}

async function makeHarness() {
  const fake = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const logger = makeSilentLogger()
  const { ledgers } = await makeAnalyticsWorld()

  const plateStore = new PlateStore({ logger, plateLedger: ledgers.plates })
  const vehicleStore = new VehicleStore({
    logger,
    vehicleLedger: ledgers.vehicles,
    sampleLedger: ledgers.vehicleSamples,
  })
  const mediaStore = new MediaStore({ storage, store: fake.client, logger })
  const trackStore = new TrackStore({ store: fake.client, logger })
  const eventStore = new EventStore({
    store: fake.client,
    logger,
    motionLedger: ledgers.motion,
    audioLedger: ledgers.audio,
  })
  await MediaStore.declare(fake.client)
  await TrackStore.declare(fake.client)
  await EventStore.declareObjectCollection(fake.client)

  const setLabel = vi.spyOn(trackStore, 'applyLabelCandidate')
  const clearLabel = vi.spyOn(trackStore, 'clearLabel')
  const setLabelForTrack = vi.spyOn(eventStore, 'projectTrackLabel')
  const clearLabelForTrack = vi.spyOn(eventStore, 'clearLabelForTrack')

  const refreshGallery = vi.fn()
  const emitFake = makeEmit()

  const provider = new PlateGalleryProvider({
    plateStore,
    vehicleStore,
    mediaStore,
    trackStore,
    eventStore,
    logger,
    refreshGallery,
    eventMediaBaseUrl: () => EVENT_MEDIA_BASE,
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    emitPlateGalleryChanged: emitFake.emit,
  })

  // The TRACK is the label authority and the events copy its decision, so a
  // harness with no track row exercises nothing — it used to assert a
  // back-patch that production could not perform.
  trackStore.upsert({
    trackId: 't1',
    deviceId: 9,
    className: 'vehicle',
    timestamp: 1,
    position: { x: 0, y: 0, timestamp: 1, bbox: { x: 0, y: 0, w: 10, h: 10 } },
    zones: [],
    state: 'new',
  })

  await plateStore.insert({
    id: 'plate-t1',
    deviceId: 9,
    trackId: 't1',
    timestamp: 1,
    text: 'AB123CD',
    score: 0.9,
    corrected: false,
    assigned: false,
  })

  return {
    provider,
    plateStore,
    vehicleStore,
    mediaStore,
    refreshGallery,
    emitFake,
    spies: { setLabel, clearLabel, setLabelForTrack, clearLabelForTrack },
  }
}

describe('PlateGalleryProvider — vehicles + assign', () => {
  it('correctPlateText emits a camera-scoped gallery invalidation', async () => {
    const h = await makeHarness()

    await h.provider.correctPlateText({ plateId: 'plate-t1', text: ' zz 999 zz ' })

    expect((await h.plateStore.get('plate-t1'))?.text).toBe('ZZ999ZZ')
    expect(h.emitFake.emitted).toContainEqual({
      deviceId: 9,
      plateId: 'plate-t1',
      kind: 'corrected',
    })
  })

  it('createVehicle then assignPlate enrolls a sample, marks assigned, labels the track', async () => {
    const h = await makeHarness()
    const v = await h.provider.createVehicle({ name: 'Van' })
    await h.provider.assignPlate({ plateId: 'plate-t1', vehicleId: v.id })

    const p = await h.plateStore.get('plate-t1')
    expect(p!.assigned).toBe(true)
    expect(p!.recognizedVehicleId).toBe(v.id)

    const samples = await h.vehicleStore.listSamples(v.id)
    expect(samples[0]!.text).toBe('AB123CD')

    // TIER 2 with operator authority — a named vehicle is the instance, and the
    // operator outranks the OCR read applied at ingest.
    const expected = expect.objectContaining({
      text: 'Van',
      tier: 2,
      operatorAuthority: true,
    })
    expect(h.spies.setLabel).toHaveBeenCalledWith('t1', expected)
    // The events take the PATCH the track accepted, never the candidate.
    expect(h.spies.setLabelForTrack).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ subLabel: 'Van' }),
    )
    expect(h.emitFake.emitted).toContainEqual(
      expect.objectContaining({ deviceId: 9, plateId: 'plate-t1', kind: 'assigned' }),
    )
  })

  it('unassignPlate clears the assignment + track label', async () => {
    const h = await makeHarness()
    const v = await h.provider.createVehicle({ name: 'Van' })
    await h.provider.assignPlate({ plateId: 'plate-t1', vehicleId: v.id })
    await h.provider.unassignPlate({ plateId: 'plate-t1' })

    const p = await h.plateStore.get('plate-t1')
    expect(p!.assigned).toBe(false)
    expect(p!.recognizedVehicleId).toBeUndefined()
    // Tier 2 only: the vehicle name is what is being taken back.
    expect(h.spies.clearLabel).toHaveBeenCalledWith('t1', 2)
    expect(h.spies.clearLabelForTrack).toHaveBeenCalledWith('t1', 2)
  })

  it('assignPlate rolls back the reown when sample enrollment throws', async () => {
    const h = await makeHarness()
    const v = await h.provider.createVehicle({ name: 'Van' })
    vi.spyOn(h.vehicleStore, 'addSample').mockRejectedValueOnce(new Error('boom'))
    await expect(h.provider.assignPlate({ plateId: 'plate-t1', vehicleId: v.id })).rejects.toThrow()
    const p = await h.plateStore.get('plate-t1')
    expect(p!.assigned).toBe(false)
  })

  it('deleteVehicle detaches assigned plates first (no orphaned assignment)', async () => {
    const h = await makeHarness()
    const v = await h.provider.createVehicle({ name: 'Van' })
    await h.provider.assignPlate({ plateId: 'plate-t1', vehicleId: v.id })
    await h.provider.deleteVehicle({ id: v.id })
    expect(await h.vehicleStore.listVehicles()).toHaveLength(0)
    const p = await h.plateStore.get('plate-t1')
    expect(p!.assigned).toBe(false)
    expect(p!.recognizedVehicleId).toBeUndefined()
  })

  it('assignPlates collects per-plate failures', async () => {
    const h = await makeHarness()
    const v = await h.provider.createVehicle({ name: 'Van' })
    const res = await h.provider.assignPlates({ plateIds: ['plate-t1', 'nope'], vehicleId: v.id })
    expect(res.assigned).toBe(1)
    expect(res.failed).toEqual(['nope'])
  })

  it('listVehicles + listVehicleSamples expose sample text/score', async () => {
    const h = await makeHarness()
    const v = await h.provider.createVehicle({ name: 'Van' })
    await h.provider.assignPlate({ plateId: 'plate-t1', vehicleId: v.id })
    const vehicles = await h.provider.listVehicles()
    expect(vehicles.map((x) => x.name)).toEqual(['Van'])
    expect(vehicles[0]!.sampleCount).toBe(1)
    const samples = await h.provider.listVehicleSamples({ vehicleId: v.id })
    expect(samples[0]!.text).toBe('AB123CD')
    expect(samples[0]!.score).toBe(0.9)
  })

  it('listPlates resolves recognizedVehicleId → vehicleName after assign', async () => {
    const h = await makeHarness()
    const v = await h.provider.createVehicle({ name: 'Van' })
    await h.provider.assignPlate({ plateId: 'plate-t1', vehicleId: v.id })
    const plates = await h.provider.listPlates({ deviceId: 9 })
    const row = plates.find((x) => x.plateId === 'plate-t1')
    expect(row!.assigned).toBe(true)
    expect(row!.recognizedVehicleId).toBe(v.id)
    expect(row!.vehicleName).toBe('Van')
  })
})

describe('PlateGalleryProvider — crop delivery', () => {
  it('getPlateByTrack returns a cropUrl and never inlines the JPEG', async () => {
    const h = await makeHarness()
    const mediaId = await h.mediaStore.put({
      deviceId: 9,
      ownerKind: 'plate',
      ownerId: 'plate-t1',
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    await h.plateStore.insert({
      id: 'plate-t1',
      deviceId: 9,
      trackId: 't1',
      timestamp: 1,
      text: 'AB123CD',
      score: 0.9,
      corrected: false,
      assigned: false,
      mediaId,
    })

    const result = await h.provider.getPlateByTrack({ deviceId: 9, trackId: 't1' })
    expect(result?.cropUrl).toBe(mediaFileUrl(EVENT_MEDIA_BASE, mediaId))
    expect(result?.base64).toBeUndefined()
  })

  /**
   * `listPlates` is the plate twin of `faceGallery.listRecentFaces`, and it was
   * the ONE gallery list left without the crop opt-out its sibling already had
   * (`face-gallery.cap.ts` `includeCrops`). Measured on the live hub, 500 rows:
   * 879,403 B and 27.7 s with the crops inline. The rows already carry
   * `cropUrl`, so the bytes buy nothing a caller cannot fetch lazily and cache.
   */
  const seedPlateWithCrop = async (h: Awaited<ReturnType<typeof makeHarness>>): Promise<number> => {
    const mediaId = await h.mediaStore.put({
      deviceId: 9,
      ownerKind: 'plate',
      ownerId: 'plate-L1',
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    await h.plateStore.insert({
      id: 'plate-L1',
      deviceId: 9,
      trackId: 'L1',
      timestamp: 1,
      text: 'ZZ999ZZ',
      score: 0.9,
      corrected: false,
      assigned: false,
      mediaId,
    })
    return mediaId
  }

  it('listPlates does NOT inline base64 by DEFAULT — 826 KB a poll is not a default', async () => {
    const h = await makeHarness()
    await seedPlateWithCrop(h)

    const plates = await h.provider.listPlates({ deviceId: 9 })
    const row = plates.find((p) => p.plateId === 'plate-L1')
    expect(row?.base64).toBeUndefined()
    expect(row?.cropUrl).toBeDefined()
  })

  it('listPlates inlines base64 when a caller explicitly asks', async () => {
    const h = await makeHarness()
    await seedPlateWithCrop(h)

    const plates = await h.provider.listPlates({ deviceId: 9, includeCrops: true })
    const row = plates.find((p) => p.plateId === 'plate-L1')
    expect((row?.base64 ?? '').length).toBeGreaterThan(0)
  })

  it('listPlates drops the inline base64 — and only it — when includeCrops is false', async () => {
    const h = await makeHarness()
    const mediaId = await seedPlateWithCrop(h)

    const plates = await h.provider.listPlates({ deviceId: 9, includeCrops: false })
    const row = plates.find((p) => p.plateId === 'plate-L1')
    // The payload the 879 KB lived in is gone...
    expect(row?.base64).toBeUndefined()
    // ...and the row still says where to get the image.
    expect(row?.cropUrl).toBe(mediaFileUrl(EVENT_MEDIA_BASE, mediaId))
    expect(row?.text).toBe('ZZ999ZZ')
  })

  it('searchPlates honours includeCrops too — same rows, same opt-out', async () => {
    const h = await makeHarness()
    const mediaId = await seedPlateWithCrop(h)

    const plates = await h.provider.searchPlates({ text: 'ZZ999ZZ', includeCrops: false })
    const row = plates.find((p) => p.plateId === 'plate-L1')
    expect(row?.base64).toBeUndefined()
    expect(row?.cropUrl).toBe(mediaFileUrl(EVENT_MEDIA_BASE, mediaId))
  })
})

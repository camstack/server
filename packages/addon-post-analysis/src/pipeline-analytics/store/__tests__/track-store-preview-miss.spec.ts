/**
 * `TrackStore.setPreviewMiss` — the readable per-track answer to "perché manca
 * l'immagine?" [why is the image missing?] (D276/B2).
 *
 * The close path composes the reason (`composePreviewMissReason`) and persists
 * it HERE, on the row `expireStale` already wrote; the late keyFrame upgrade
 * CLEARS it when a native tile lands after all. What is pinned:
 *
 *  - the reason round-trips through both projections (the events grid reads
 *    slim pages);
 *  - `null` clears it — a redeemed track must stop claiming a miss;
 *  - absent stays absent: a row that never missed (or predates the column)
 *    reports nothing, never an empty-string positive.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { TrackStore } from '../track-store.js'

const DEVICE_ID = 108

describe('TrackStore — the preview-miss record', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    trackStore = new TrackStore({ store: fake.client, logger: makeSilentLogger() })
    await TrackStore.declare(fake.client)
  })

  function upsertLive(trackId: string, timestamp: number): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp,
      position: { x: 0.5, y: 0.5, timestamp, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })
  }

  /** Expire a lived-in track (past the short-motionless stationary window)
   *  so the row persists WITHOUT a stationary close marker. */
  async function closeAsPassage(trackId: string): Promise<void> {
    upsertLive(trackId, 1_000)
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp: 31_000,
      position: { x: 0.8, y: 0.5, timestamp: 31_000, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
    })
    await trackStore.expireStale(31_000 + 60_000)
  }

  it('persists the reason on a closed row, readable in BOTH projections', async () => {
    await closeAsPassage('t-miss')

    await trackStore.setPreviewMiss('t-miss', 'no-key-frame capture=keyframe:native-missx4')

    const full = await trackStore.queryHistorical({ deviceId: DEVICE_ID })
    expect(full[0]?.previewMissReason).toBe('no-key-frame capture=keyframe:native-missx4')
    const slim = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection: 'slim' })
    expect(slim[0]?.previewMissReason).toBe('no-key-frame capture=keyframe:native-missx4')
  })

  it('clears with null — the late-keyFrame upgrade redeemed the tile', async () => {
    await closeAsPassage('t-redeemed')
    await trackStore.setPreviewMiss('t-redeemed', 'no-key-frame')

    await trackStore.setPreviewMiss('t-redeemed', null)

    const row = await trackStore.getPersistedByTrackId('t-redeemed')
    expect(row?.previewMissReason).toBeUndefined()
  })

  it('a row that never missed reports NOTHING', async () => {
    await closeAsPassage('t-clean')
    const row = await trackStore.getPersistedByTrackId('t-clean')
    expect(row?.previewMissReason).toBeUndefined()
    expect(row?.previewMissReason).toBeUndefined()
  })

  it('survives a later partial patch of the row', async () => {
    await closeAsPassage('t-patched')
    await trackStore.setPreviewMiss('t-patched', 'raster-tile tile=raster')

    await trackStore.setFlags('t-patched', { markForTrain: true })
    await trackStore.markFaceDetected('t-patched')

    const row = await trackStore.getPersistedByTrackId('t-patched')
    expect(row?.previewMissReason).toBe('raster-tile tile=raster')
    expect(row?.hasFace).toBe(true)
  })
})

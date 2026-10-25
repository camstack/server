/**
 * A track records WHICH MODEL produced it and the FRAME SIZE its boxes live in
 * (D646).
 *
 * Without them a stored track could not be compared with a replay: the
 * positions are pixels in a detection frame whose size was nowhere on the row
 * (the envelope columns had it, but only when an envelope was computed, and
 * the read never surfaced it), and nothing said which detector drew them — so
 * "what would model X have seen that the camera's model did not" had no
 * baseline to name.
 *
 * Both are a BIRTH fact: the frame the track was born on decides them, a later
 * frame never rewrites them. Absent stays absent — a frame no pipeline root
 * produced (the camera's own detector) has no model id, and a row from before
 * the columns is not a claim about either.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  makeFakeSettingsStore,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { trackProvenanceOf } from '../../pipeline/track-provenance.js'
import { TrackStore } from '../track-store.js'

const DEVICE_ID = 101

describe('TrackStore — provenance (modelId + detection frame size)', () => {
  let fake: FakeSettingsStore
  let trackStore: TrackStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore({ enforceDeclaredColumns: true })
    trackStore = new TrackStore({
      store: fake.client,
      logger: makeSilentLogger(),
      // The per-device LATEST dims — deliberately different from the birth
      // frame, to prove which one a row keeps.
      frameDims: () => ({ w: 1920, h: 1080 }),
    })
    await TrackStore.declare(fake.client)
  })

  function upsert(
    trackId: string,
    timestamp: number,
    provenance?: { modelId?: string; frameWidth: number; frameHeight: number },
  ): void {
    trackStore.upsert({
      trackId,
      deviceId: DEVICE_ID,
      className: 'person',
      timestamp,
      position: { x: 0.5, y: 0.5, timestamp, bbox: { x: 10, y: 10, w: 20, h: 40 } },
      zones: [],
      state: 'moving',
      ...(provenance !== undefined ? { provenance } : {}),
    })
  }

  it('keeps the model and the frame size of the frame the track was BORN on', async () => {
    upsert('t1', 1_000, { modelId: 'yolov9s-640', frameWidth: 640, frameHeight: 360 })
    upsert('t1', 1_100, { modelId: 'yolo26n', frameWidth: 1280, frameHeight: 720 })
    await trackStore.expireStale(1_100 + 60_000)

    for (const projection of ['full', 'slim'] as const) {
      const rows = await trackStore.queryHistorical({ deviceId: DEVICE_ID, projection })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.modelId).toBe('yolov9s-640')
      expect(rows[0]!.frameWidth).toBe(640)
      expect(rows[0]!.frameHeight).toBe(360)
    }
  })

  it('a track born on a frame with no pipeline model keeps its frame size and NO model id', async () => {
    upsert('t-onboard', 1_000, { frameWidth: 640, frameHeight: 360 })
    await trackStore.expireStale(1_000 + 60_000)
    const row = await trackStore.getPersistedByTrackId('t-onboard')
    expect(row?.modelId).toBeUndefined()
    expect(row?.frameWidth).toBe(640)
  })

  it('without provenance the row still reports the per-device dims it was normalised by', async () => {
    upsert('t-legacy', 1_000)
    await trackStore.expireStale(1_000 + 60_000)
    const row = await trackStore.getPersistedByTrackId('t-legacy')
    expect(row?.modelId).toBeUndefined()
    expect(row?.frameWidth).toBe(1920)
    expect(row?.frameHeight).toBe(1080)
  })
})

describe('trackProvenanceOf — what a frame result says about the tracks born on it', () => {
  it('carries the stamped root model and the frame size', () => {
    expect(trackProvenanceOf({ width: 640, height: 360, rootModelId: 'yolov9s-640' })).toEqual({
      modelId: 'yolov9s-640',
      frameWidth: 640,
      frameHeight: 360,
    })
  })

  it('omits the model when the frame carries none — absent, never an empty string', () => {
    const p = trackProvenanceOf({ width: 640, height: 360 })
    expect(p).toEqual({ frameWidth: 640, frameHeight: 360 })
    expect(p !== undefined && 'modelId' in p).toBe(false)
  })

  it('says nothing when the frame size is unknown', () => {
    expect(trackProvenanceOf({ width: 0, height: 0, rootModelId: 'x' })).toBeUndefined()
  })
})

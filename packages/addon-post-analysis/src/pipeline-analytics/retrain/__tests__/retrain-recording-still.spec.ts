/**
 * A frame from the RECORDING joins the one retrain corpus as a trackless copy.
 *
 * The material it exists for is the frame the model saw nothing in: there is
 * no track, no media row, no key frame — only the recording at an instant.
 * It is copied like every other retrain frame (the dataset owns the bytes on
 * the durable tenant), named by `(deviceId, epochMs)` so adding the same
 * moment twice reuses one copy, and kept apart on disk from track copies.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  RETRAIN_MEDIA_LOCATION,
  RetrainFrameStore,
  recordingFrameId,
} from '../retrain-frame-store.js'
import { jpegOf, type MemoryBlobs, memoryBlobs } from './retrain-fixtures.js'

const AT = 1_700_000_123_456

describe('RetrainFrameStore — recording stills', () => {
  let blobs: MemoryBlobs
  let store: RetrainFrameStore

  beforeEach(async () => {
    const { ledgers } = await makeAnalyticsWorld()
    blobs = memoryBlobs()
    store = new RetrainFrameStore({
      frameLedger: ledgers.retrainFrames,
      storage: blobs,
      logger: makeSilentLogger(),
      now: () => 1_700_000_200_000,
      readSource: async () => null,
    })
  })

  it('stores a still as a trackless copy on the durable tenant, captured at the instant', async () => {
    const result = await store.storeRecordingStill({
      deviceId: 101,
      epochMs: AT,
      bytes: jpegOf(2560, 1440),
    })
    expect(result.kind).toBe('copied')
    if (result.kind !== 'copied') return
    expect(result.reused).toBe(false)
    expect(result.frame).toMatchObject({
      frameId: recordingFrameId(101, AT),
      origin: 'recording',
      deviceId: 101,
      epochMs: AT,
      capturedAt: AT,
      width: 2560,
      height: 1440,
      locationId: RETRAIN_MEDIA_LOCATION,
      complete: false,
    })
    const [key] = [...blobs.files.keys()]
    expect(key).toMatch(
      new RegExp(`^${RETRAIN_MEDIA_LOCATION}:retrain/101/recording/[0-9a-f]+\\.jpg$`),
    )
    expect(await store.readFrame(result.frame)).toEqual(jpegOf(2560, 1440))
  })

  it('the same moment twice is ONE copy', async () => {
    await store.storeRecordingStill({ deviceId: 101, epochMs: AT, bytes: jpegOf(106, 360) })
    const again = await store.storeRecordingStill({
      deviceId: 101,
      epochMs: AT,
      bytes: jpegOf(640, 360),
    })
    expect(again).toMatchObject({ kind: 'copied', reused: true })
    expect(blobs.files.size).toBe(1)
  })

  it('refuses bytes that are not a JPEG, writing nothing', async () => {
    const result = await store.storeRecordingStill({
      deviceId: 101,
      epochMs: AT,
      bytes: Buffer.from('not a jpeg'),
    })
    expect(result).toEqual({ kind: 'refused', reason: 'unreadable-image' })
    expect(blobs.files.size).toBe(0)
    expect(await store.get(recordingFrameId(101, AT))).toBeNull()
  })

  it('a recording still is never listed as a track copy, and is found by id', async () => {
    await store.storeRecordingStill({ deviceId: 101, epochMs: AT, bytes: jpegOf(106, 360) })
    expect(await store.listByTrack('')).toEqual([])
    const many = await store.getMany([recordingFrameId(101, AT), 'retrain:missing'])
    expect(many.map((f) => f.frameId)).toEqual([recordingFrameId(101, AT)])
    expect(await store.listDeviceIds()).toEqual([101])
  })

  it('deleting a recording still removes its blob too', async () => {
    const result = await store.storeRecordingStill({
      deviceId: 101,
      epochMs: AT,
      bytes: jpegOf(640, 360),
    })
    if (result.kind !== 'copied') throw new Error('expected a copy')
    await store.deleteFrame(result.frame)
    expect(blobs.files.size).toBe(0)
    expect(await store.get(result.frame.frameId)).toBeNull()
  })
})

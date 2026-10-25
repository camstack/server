/**
 * The service end of the P3 frame facts: selecting a frame records the
 * source's capture time, and the operator's completeness is set through the
 * service, scoped to the track the frame belongs to.
 */
import type { MediaFileRef } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { RetrainAnnotationStore } from '../retrain-annotation-store.js'
import { RetrainFrameStore } from '../retrain-frame-store.js'
import { RetrainService } from '../retrain-service.js'

function jpegOf(width: number, height: number): Buffer {
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])])
}

const CAPTURED = 1_699_999_000_000
const MEDIA: readonly MediaFileRef[] = [
  { mediaId: 501, kind: 'keyFrame', sizeBytes: 10, timestamp: CAPTURED },
]

describe('retrain service frame facts', () => {
  let service: RetrainService

  beforeEach(async () => {
    const { ledgers } = await makeAnalyticsWorld()
    const blobs = new Map<string, Buffer>()
    service = new RetrainService({
      tracks: {
        listStaging: async () => [],
        listDeviceIds: async () => [],
        getPersistedByTrackId: async () => null,
        readStatus: async () => null,
        setStatus: async () => undefined,
      },
      media: { listTrackMedia: async () => MEDIA, readBlob: async () => null },
      frames: new RetrainFrameStore({
        frameLedger: ledgers.retrainFrames,
        storage: {
          write: async ({ relativePath, data }) => void blobs.set(relativePath, data),
          read: async ({ relativePath }) => blobs.get(relativePath) ?? Buffer.alloc(0),
          delete: async ({ relativePath }) => void blobs.delete(relativePath),
        },
        logger: makeSilentLogger(),
        now: () => 1_700_000_000_000,
        readSource: async () => jpegOf(640, 480),
      }),
      annotations: new RetrainAnnotationStore({
        annotationLedger: ledgers.retrainAnnotations,
        frameLedger: ledgers.retrainFrames,
        logger: makeSilentLogger(),
        now: () => 0,
        newId: () => 'id',
      }),
      runner: async () => {
        throw new Error('not used')
      },
      logger: makeSilentLogger(),
    })
  })

  it('a selected frame carries the capture time of the media it was copied from', async () => {
    const selection = await service.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })

    expect(selection.copied[0]?.capturedAt).toBe(CAPTURED)
    expect(selection.copied[0]?.complete).toBe(false)
  })

  it('marks a frame complete, and refuses a frame of another track', async () => {
    const selection = await service.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })
    const frameId = selection.copied[0]?.frameId ?? ''

    const marked = await service.setFrameComplete({
      deviceId: 101,
      trackId: 't',
      frameId,
      complete: true,
    })
    expect(marked.complete).toBe(true)

    await expect(
      service.setFrameComplete({ deviceId: 101, trackId: 'other', frameId, complete: true }),
    ).rejects.toThrow(/does not belong/)
  })
})

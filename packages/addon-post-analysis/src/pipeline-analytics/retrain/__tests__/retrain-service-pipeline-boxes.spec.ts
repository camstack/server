/**
 * The service end of Step 1: a listed copy carries the boxes the pipeline drew
 * on it, read from the track store — never a model re-run.
 */
import type { MediaFileRef, Track } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { RetrainAnnotationStore } from '../retrain-annotation-store.js'
import { RetrainFrameStore } from '../retrain-frame-store.js'
import { type RetrainPipelineEvidence, RetrainService } from '../retrain-service.js'

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

const OWN: Track = {
  trackId: 't',
  deviceId: 101,
  className: 'person',
  firstSeen: CAPTURED - 1000,
  lastSeen: CAPTURED + 1000,
  positions: [
    { x: 0, y: 0, timestamp: CAPTURED, bbox: { x: 0, y: 0, w: 100, h: 100 }, score: 0.7 },
  ],
  snapshots: [],
  zonesVisited: [],
  modelId: 'yolov9m-320',
  frameWidth: 1000,
  frameHeight: 1000,
  totalDistance: 0,
  state: 'left',
  active: false,
}

const CAT: Track = {
  ...OWN,
  trackId: 'cat',
  className: 'animal',
  label: 'cat',
  positions: [
    { x: 0, y: 0, timestamp: CAPTURED + 20, bbox: { x: 500, y: 500, w: 100, h: 50 }, score: 0.55 },
  ],
}

async function build(evidence?: RetrainPipelineEvidence): Promise<RetrainService> {
  const { ledgers } = await makeAnalyticsWorld()
  const blobs = new Map<string, Buffer>()
  return new RetrainService({
    tracks: {
      listStaging: async () => [],
      listDeviceIds: async () => [],
      getPersistedByTrackId: async (id) => (id === 't' ? OWN : null),
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
      readSource: async () => jpegOf(640, 640),
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
    ...(evidence !== undefined ? { pipelineEvidence: evidence } : {}),
  })
}

describe('listFrames carries the pipeline boxes of each copy', () => {
  it('the recorded subject box for the own track, plus every other track on the frame', async () => {
    const asked: Array<{ deviceId: number; at: number }> = []
    const service = await build({
      tracksAround: async (deviceId, at) => {
        asked.push({ deviceId, at })
        return [OWN, CAT]
      },
      subjectBoxes: async () => [
        {
          mediaId: 501,
          subjectBox: { x: 10, y: 10, w: 90, h: 90, frameWidth: 1000, frameHeight: 1000 },
        },
      ],
    })
    await service.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })

    const list = await service.listFrames('t')
    const boxes = list.copies[0]?.pipelineBoxes ?? []

    expect(asked).toEqual([{ deviceId: 101, at: CAPTURED }])
    expect(boxes.map((b) => [b.trackId, b.basis])).toEqual([
      ['t', 'subject-box'],
      ['cat', 'position'],
    ])
    expect(boxes[0]).toMatchObject({ modelId: 'yolov9m-320', score: 0.7, macroClass: 'person' })
    expect(boxes[1]).toMatchObject({ macroClass: 'animal', label: 'cat', score: 0.55 })
  })

  it('a failing evidence read leaves the copy listed with what CAN be placed, never an error', async () => {
    const service = await build({
      tracksAround: async () => {
        throw new Error('store down')
      },
      subjectBoxes: async () => {
        throw new Error('store down')
      },
    })
    await service.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })

    const list = await service.listFrames('t')
    expect(list.copies).toHaveLength(1)
    // The own track is still readable, so its nearest position is offered.
    expect(list.copies[0]?.pipelineBoxes?.map((b) => [b.trackId, b.basis])).toEqual([
      ['t', 'position'],
    ])
  })

  it('without the evidence port the field is simply absent', async () => {
    const service = await build()
    await service.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })
    const list = await service.listFrames('t')
    expect(list.copies[0]?.pipelineBoxes).toBeUndefined()
  })
})

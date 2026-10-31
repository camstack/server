/**
 * What the operator answered on a notification reaches the retrain listing:
 * the staging worklist and the frames copied from the answered track carry the
 * verdict, and a track nobody answered carries none.
 */
import type { MediaFileRef, RetrainVerdict, Track } from '@camstack/types'
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

const ANSWERED: Track = {
  trackId: 'trk-dog',
  deviceId: 101,
  className: 'dog',
  firstSeen: CAPTURED - 1000,
  lastSeen: CAPTURED + 1000,
  positions: [],
  snapshots: [],
  zonesVisited: [],
  totalDistance: 0,
  state: 'moving',
  active: true,
}
const SILENT: Track = { ...ANSWERED, trackId: 'trk-cat', className: 'cat' }
const WRONG: RetrainVerdict = { verdict: 'wrong', trackId: 'trk-dog', suggestedClass: 'cat', at: 5 }

describe('retrain verdicts on the listing', () => {
  async function build(verdicts: boolean) {
    const { ledgers } = await makeAnalyticsWorld()
    const blobs = new Map<string, Buffer>()
    const asked: string[][] = []
    const service = new RetrainService({
      tracks: {
        listStaging: async () => [ANSWERED, SILENT],
        listDeviceIds: async () => [101],
        getPersistedByTrackId: async () => ANSWERED,
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
      ...(verdicts
        ? {
            verdicts: {
              forTracks: async (ids: readonly string[]) => {
                asked.push([...ids])
                return new Map(ids.includes('trk-dog') ? [['trk-dog', WRONG]] : [])
              },
            },
          }
        : {}),
    })
    return { service, asked }
  }

  it('the staging worklist carries the answer of the track that has one', async () => {
    const { service } = await build(true)
    const rows = await service.listStaging({})
    expect(rows.find((r) => r.trackId === 'trk-dog')?.verdict).toEqual(WRONG)
    expect(rows.find((r) => r.trackId === 'trk-cat')?.verdict).toBeUndefined()
  })

  it('a frame copied from the answered track carries the answer', async () => {
    const { service } = await build(true)
    await service.selectFrames({ deviceId: 101, trackId: 'trk-dog', mediaIds: [501] })
    const wire = (await service.listFrames('trk-dog')).copies[0]
    expect(wire?.verdict).toEqual(WRONG)
  })

  it('without a verdict source the listing is unchanged', async () => {
    const { service } = await build(false)
    const rows = await service.listStaging({})
    expect(rows.every((r) => r.verdict === undefined)).toBe(true)
  })
})

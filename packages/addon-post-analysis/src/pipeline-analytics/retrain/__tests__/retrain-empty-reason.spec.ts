/**
 * The empty-worklist line names the RIGHT reason, per camera (D654, D391).
 *
 * It used to say every empty track's media had "aged out". Since the retrain
 * picker stopped treating the boxed timeline tiles as clean, a track that only
 * ever held those tiles is empty for a different reason, and the operator
 * reading the line has to be able to tell the two apart — per camera.
 */
import type { MediaFileRef, Track } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { type AnalyticsLedgers, makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { RetrainAnnotationStore } from '../retrain-annotation-store.js'
import { RetrainFrameStore } from '../retrain-frame-store.js'
import { RetrainService } from '../retrain-service.js'

const TRACK: Track = {
  trackId: 'trk-1',
  deviceId: 101,
  className: 'person',
  firstSeen: 1,
  lastSeen: 2,
  positions: [],
  snapshots: [],
  zonesVisited: [],
  totalDistance: 0,
  state: 'moving',
  active: false,
}

function row(mediaId: number, kind: MediaFileRef['kind']): MediaFileRef {
  return { mediaId, kind, sizeBytes: 10, timestamp: 1 }
}

describe('RetrainService.listFrames — an empty track says why', () => {
  let log: ReturnType<typeof makeLogRecorder>
  let ledgers: AnalyticsLedgers

  function service(media: readonly MediaFileRef[]): RetrainService {
    return new RetrainService({
      tracks: {
        listStaging: async () => [],
        listDeviceIds: async () => [],
        getPersistedByTrackId: async () => TRACK,
        readStatus: async () => null,
        setStatus: async () => undefined,
      },
      media: { listTrackMedia: async () => media, readBlob: async () => null },
      frames: new RetrainFrameStore({
        frameLedger: ledgers.retrainFrames,
        storage: {
          write: async () => undefined,
          read: async () => Buffer.alloc(0),
          delete: async () => undefined,
        },
        logger: log.logger,
        now: () => 0,
        readSource: async () => null,
      }),
      annotations: new RetrainAnnotationStore({
        annotationLedger: ledgers.retrainAnnotations,
        frameLedger: ledgers.retrainFrames,
        logger: log.logger,
        now: () => 0,
        newId: () => 'id',
      }),
      runner: async () => {
        throw new Error('unused')
      },
      logger: log.logger,
    })
  }

  beforeEach(async () => {
    log = makeLogRecorder()
    ledgers = (await makeAnalyticsWorld()).ledgers
  })

  const emptyLine = () => log.entries.find((e) => e.message.includes('no annotatable frame'))

  it('a track holding only boxed tiles: annotated-frames-only, tagged with its camera', async () => {
    await service([row(1, 'firstFrame'), row(2, 'lastFrame')]).listFrames('trk-1')
    expect(emptyLine()?.extras).toMatchObject({
      tags: { deviceId: 101 },
      meta: { reason: 'annotated-frames-only', annotatedRows: 2 },
    })
  })

  it('a track whose whole-frame media is gone: no-whole-frame-media', async () => {
    await service([row(3, 'thumbnail')]).listFrames('trk-1')
    expect(emptyLine()?.extras).toMatchObject({
      tags: { deviceId: 101 },
      meta: { reason: 'no-whole-frame-media' },
    })
  })
})

/**
 * Named collections, end to end over fakes: a frame from the recording lands
 * as a trackless retrain copy in a collection — including the moment the model
 * saw nothing — or the operator is told exactly why not.
 */
import type { MediaFileRef, Track } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeAnalyticsWorld } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { RecoveredStill } from '../../recorded-still.js'
import { RetrainAnnotationStore } from '../retrain-annotation-store.js'
import { RetrainCollectionService } from '../retrain-collection-service.js'
import { RetrainCollectionStore } from '../retrain-collection-store.js'
import { RetrainFrameStore, recordingFrameId } from '../retrain-frame-store.js'
import { type RetrainPipelineEvidence, RetrainService } from '../retrain-service.js'
import { jpegOf, type MemoryBlobs, memoryBlobs } from './retrain-fixtures.js'

const AT = 1_700_000_123_456
const MEDIA: readonly MediaFileRef[] = [
  { mediaId: 501, kind: 'keyFrame', sizeBytes: 10, timestamp: AT - 60_000 },
]

interface Harness {
  readonly collections: RetrainCollectionService
  readonly retrain: RetrainService
  readonly annotations: RetrainAnnotationStore
  readonly blobs: MemoryBlobs
  readonly captured: Array<{ deviceId: number; epochMs: number }>
  setStill(still: RecoveredStill): void
}

async function harness(evidence?: RetrainPipelineEvidence): Promise<Harness> {
  const { ledgers } = await makeAnalyticsWorld()
  const blobs = memoryBlobs()
  let ids = 0
  const frames = new RetrainFrameStore({
    frameLedger: ledgers.retrainFrames,
    storage: blobs,
    logger: makeSilentLogger(),
    now: () => AT + 1,
    readSource: async () => jpegOf(640, 360),
  })
  const annotations = new RetrainAnnotationStore({
    annotationLedger: ledgers.retrainAnnotations,
    frameLedger: ledgers.retrainFrames,
    logger: makeSilentLogger(),
    now: () => AT + 2,
    newId: () => `ann-${++ids}`,
  })
  const store = new RetrainCollectionStore({
    collectionLedger: ledgers.retrainCollections,
    membershipLedger: ledgers.retrainCollectionFrames,
    logger: makeSilentLogger(),
    now: () => AT + 3,
    newId: () => `col-${++ids}`,
  })
  const retrain = new RetrainService({
    tracks: {
      listStaging: async () => [],
      listDeviceIds: async () => [],
      getPersistedByTrackId: async () => null,
      readStatus: async () => null,
      setStatus: async () => undefined,
    },
    media: { listTrackMedia: async () => MEDIA, readBlob: async () => null },
    frames,
    annotations,
    runner: async () => {
      throw new Error('not used')
    },
    logger: makeSilentLogger(),
    memberships: store,
    ...(evidence !== undefined ? { pipelineEvidence: evidence } : {}),
  })
  let still: RecoveredStill = { outcome: 'ok', jpeg: jpegOf(2560, 1440), gopStartMs: AT - 400 }
  const captured: Array<{ deviceId: number; epochMs: number }> = []
  const collections = new RetrainCollectionService({
    collections: store,
    frames,
    annotations,
    retrain,
    captureStill: async (deviceId, epochMs) => {
      captured.push({ deviceId, epochMs })
      return still
    },
    logger: makeSilentLogger(),
  })
  return {
    collections,
    retrain,
    annotations,
    blobs,
    captured,
    setStill: (next) => {
      still = next
    },
  }
}

async function newCollection(h: Harness, name: string): Promise<string> {
  const created = await h.collections.create({ name })
  if (created.kind !== 'created') throw new Error('expected created')
  return created.collection.id
}

describe('RetrainCollectionService', () => {
  let h: Harness

  beforeEach(async () => {
    h = await harness()
  })

  it('adds a frame from the recording: a trackless copy, in the collection', async () => {
    const id = await newCollection(h, 'missed at night')
    const result = await h.collections.addFrameFromRecording({
      collectionId: id,
      deviceId: 101,
      epochMs: AT,
    })
    expect(h.captured).toEqual([{ deviceId: 101, epochMs: AT }])
    expect(result).toMatchObject({
      kind: 'added',
      collectionId: id,
      reused: false,
      frame: {
        frameId: recordingFrameId(101, AT),
        origin: 'recording',
        deviceId: 101,
        epochMs: AT,
        capturedAt: AT,
        width: 2560,
        height: 1440,
        collectionIds: [id],
      },
    })
    if (result.kind !== 'added') return
    expect(result.frame).not.toHaveProperty('trackId')
    expect(result.frame).not.toHaveProperty('sourceMediaId')
    expect((await h.collections.list())[0]?.frameCount).toBe(1)
  })

  it('the same moment added twice is one copy, reused, and one membership', async () => {
    const id = await newCollection(h, 'a')
    await h.collections.addFrameFromRecording({ collectionId: id, deviceId: 101, epochMs: AT })
    const again = await h.collections.addFrameFromRecording({
      collectionId: id,
      deviceId: 101,
      epochMs: AT,
    })
    expect(again).toMatchObject({ kind: 'added', reused: true })
    // An existing copy is never re-decoded.
    expect(h.captured).toHaveLength(1)
    expect((await h.collections.listFrames({ collectionId: id })).length).toBe(1)
  })

  it('names every refusal, and writes nothing on one', async () => {
    expect(
      await h.collections.addFrameFromRecording({
        collectionId: 'nope',
        deviceId: 101,
        epochMs: AT,
      }),
    ).toEqual({ kind: 'refused', reason: 'unknown-collection' })
    expect(h.captured).toEqual([])

    const id = await newCollection(h, 'a')
    const cases: ReadonlyArray<[RecoveredStill, string]> = [
      [{ outcome: 'no-recording' }, 'still-unavailable'],
      [{ outcome: 'no-footage' }, 'still-unavailable'],
      [{ outcome: 'busy' }, 'still-busy'],
      [{ outcome: 'decode-failed' }, 'still-unavailable'],
      [{ outcome: 'ok', jpeg: Buffer.from('nope') }, 'unreadable-image'],
    ]
    for (const [still, reason] of cases) {
      h.setStill(still)
      const result = await h.collections.addFrameFromRecording({
        collectionId: id,
        deviceId: 101,
        epochMs: AT,
      })
      expect(result).toMatchObject({ kind: 'refused', reason })
    }
    expect(h.blobs.files.size).toBe(0)
    expect((await h.collections.list())[0]?.frameCount).toBe(0)
  })

  it('adds existing track frames to a collection and names the unknown ones', async () => {
    const id = await newCollection(h, 'a')
    const selection = await h.retrain.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })
    const frameId = selection.copied[0]!.frameId
    const result = await h.collections.addFrames({ collectionId: id, frameIds: [frameId, 'ghost'] })
    expect(result).toEqual({ added: 1, alreadyMember: 0, unknownFrameIds: ['ghost'] })
    const listed = await h.collections.listFrames({ collectionId: id })
    expect(listed.map((f) => [f.origin, f.trackId])).toEqual([['track', 't']])
  })

  it('removing a recording still from its only collection deletes it with its annotations', async () => {
    const id = await newCollection(h, 'a')
    const added = await h.collections.addFrameFromRecording({
      collectionId: id,
      deviceId: 101,
      epochMs: AT,
    })
    if (added.kind !== 'added') throw new Error('expected added')
    await h.retrain.saveAnnotations({
      deviceId: 101,
      frameId: added.frame.frameId,
      annotations: [
        {
          bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
          macroClass: 'person',
          kind: 'subject',
          source: 'operator',
        },
      ],
    })
    const removed = await h.collections.removeFrame({
      collectionId: id,
      frameId: added.frame.frameId,
    })
    expect(removed).toEqual({ removed: true, deletedFrame: true })
    expect(h.blobs.files.size).toBe(0)
    expect(await h.annotations.listByFrame(added.frame.frameId)).toEqual([])
  })

  it('a still kept by another collection survives; a track frame always survives', async () => {
    const a = await newCollection(h, 'a')
    const b = await newCollection(h, 'b')
    const added = await h.collections.addFrameFromRecording({
      collectionId: a,
      deviceId: 101,
      epochMs: AT,
    })
    if (added.kind !== 'added') throw new Error('expected added')
    await h.collections.addFrames({ collectionId: b, frameIds: [added.frame.frameId] })
    const selection = await h.retrain.selectFrames({ deviceId: 101, trackId: 't', mediaIds: [501] })
    await h.collections.addFrames({ collectionId: a, frameIds: [selection.copied[0]!.frameId] })

    const deleted = await h.collections.delete({ id: a })
    expect(deleted).toEqual({ deleted: true, removedFrames: 0 })
    expect(h.blobs.files.size).toBe(2)

    const deletedB = await h.collections.delete({ id: b })
    // Now the still has no collection left: it goes. The track copy stays.
    expect(deletedB).toEqual({ deleted: true, removedFrames: 1 })
    expect(h.blobs.files.size).toBe(1)
  })

  it('a recording still is annotated, completed and deselected without a track', async () => {
    const id = await newCollection(h, 'a')
    const added = await h.collections.addFrameFromRecording({
      collectionId: id,
      deviceId: 101,
      epochMs: AT,
    })
    if (added.kind !== 'added') throw new Error('expected added')
    const frameId = added.frame.frameId

    const done = await h.retrain.setFrameComplete({ deviceId: 101, frameId, complete: true })
    expect(done.complete).toBe(true)
    await expect(
      h.retrain.setFrameComplete({ deviceId: 101, trackId: 't', frameId, complete: true }),
    ).rejects.toThrow(/does not belong/)
    await expect(
      h.retrain.setFrameComplete({ deviceId: 102, frameId, complete: true }),
    ).rejects.toThrow(/does not belong/)

    const listed = await h.retrain.listAnnotations({ frameIds: [frameId] })
    expect(listed).toEqual([])

    expect(await h.retrain.deselectFrame({ deviceId: 101, frameId })).toEqual({
      removed: true,
      removedAnnotations: 0,
    })
    // Deselecting the frame removes its memberships too.
    expect((await h.collections.list())[0]?.frameCount).toBe(0)
  })
})

/** The dog the notification was about, and the walker beside it. */
const DOG_BOX = { x: 0.5, y: 0.25, w: 0.1, h: 0.5 }
const WALKER: Track = {
  trackId: 'trk-walker',
  deviceId: 615,
  className: 'person',
  firstSeen: AT - 60_000,
  lastSeen: AT + 60_000,
  positions: [{ x: 0, y: 0, timestamp: AT, bbox: { x: 100, y: 50, w: 80, h: 250 }, score: 0.9 }],
  snapshots: [],
  zonesVisited: [],
  frameWidth: 640,
  frameHeight: 360,
  totalDistance: 0,
  state: 'moving',
  active: true,
}

describe('a verdict still carries the subject the notification reported', () => {
  const evidence: RetrainPipelineEvidence = {
    tracksAround: async () => [WALKER],
    subjectBoxes: async () => [],
  }

  async function landDogStill(
    verdictSubject: Parameters<
      RetrainCollectionService['addFrameFromRecording']
    >[0]['verdictSubject'],
  ) {
    const h = await harness(evidence)
    h.setStill({ outcome: 'ok', jpeg: jpegOf(3840, 2160), gopStartMs: AT - 400 })
    const id = await newCollection(h, 'Notification verdicts')
    const result = await h.collections.addFrameFromRecording({
      collectionId: id,
      deviceId: 615,
      epochMs: AT,
      ...(verdictSubject !== undefined ? { verdictSubject } : {}),
    })
    if (result.kind !== 'added') throw new Error('expected added')
    return { h, id, frame: result.frame }
  }

  const SUBJECT = {
    trackId: 'trk-dog',
    className: 'dog',
    bbox: DOG_BOX,
    verdict: 'wrong' as const,
    suggestedClass: 'person',
    at: AT + 13_000,
  }

  it("the notified box is the first (own) proposal, in the still's own frame space", async () => {
    const { frame } = await landDogStill(SUBJECT)
    const [own, ...rest] = frame.pipelineBoxes ?? []
    expect(own).toMatchObject({
      trackId: 'trk-dog',
      basis: 'verdict',
      macroClass: 'animal',
      label: 'dog',
      bbox: DOG_BOX,
    })
    // A 3840x2160 still reads the same normalised box as the 640x360 detection
    // frame it was measured on: 0.5 / 0.25 / 0.1 / 0.5 of the frame.
    const px = (v: number, extent: number): number => Math.round(v * extent)
    expect([
      px(own?.bbox.x ?? 0, frame.width),
      px(own?.bbox.y ?? 0, frame.height),
      px(own?.bbox.w ?? 0, frame.width),
      px(own?.bbox.h ?? 0, frame.height),
    ]).toEqual([1920, 540, 384, 1080])
    // The neighbour (the dog walker) is still there, but second.
    expect(rest.map((b) => b.trackId)).toEqual(['trk-walker'])
    expect(rest[0]?.basis).toBe('position')
  })

  it('reports the verdict on the still', async () => {
    const { frame } = await landDogStill(SUBJECT)
    expect(frame.verdict).toEqual({
      verdict: 'wrong',
      suggestedClass: 'person',
      suggestedMacroClass: 'person',
      trackId: 'trk-dog',
      at: AT + 13_000,
    })
  })

  it('is stored on the row: a later listing still has it', async () => {
    const { h, id, frame } = await landDogStill(SUBJECT)
    const listed = await h.collections.listFrames({ collectionId: id })
    expect(listed[0]?.frameId).toBe(frame.frameId)
    expect(listed[0]?.pipelineBoxes?.[0]?.basis).toBe('verdict')
    expect(listed[0]?.verdict?.verdict).toBe('wrong')
  })

  it('a still with no verdict subject offers only the neighbours, as before', async () => {
    const { frame } = await landDogStill(undefined)
    expect((frame.pipelineBoxes ?? []).map((b) => b.trackId)).toEqual(['trk-walker'])
    expect(frame.verdict).toBeUndefined()
  })

  it('a subject with no box still reports its verdict, and draws nothing of its own', async () => {
    const { bbox: _omitted, ...noBox } = SUBJECT
    const { frame } = await landDogStill(noBox)
    expect(frame.verdict?.verdict).toBe('wrong')
    expect((frame.pipelineBoxes ?? []).map((b) => b.basis)).toEqual(['position'])
  })

  it('the moment already in the dataset takes the verdict subject too', async () => {
    const h = await harness(evidence)
    const id = await newCollection(h, 'Notification verdicts')
    await h.collections.addFrameFromRecording({ collectionId: id, deviceId: 615, epochMs: AT })
    const again = await h.collections.addFrameFromRecording({
      collectionId: id,
      deviceId: 615,
      epochMs: AT,
      verdictSubject: SUBJECT,
    })
    if (again.kind !== 'added') throw new Error('expected added')
    expect(again.reused).toBe(true)
    expect(again.frame.pipelineBoxes?.[0]?.basis).toBe('verdict')
  })
})

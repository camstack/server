/**
 * COPY-ON-SELECT — the contract that makes `trained` evictable.
 *
 * Three properties, and each one is a way the dataset silently loses entries if
 * it is wrong:
 *
 * 1. Selecting copies the bytes IMMEDIATELY. Not a reference, not a lease.
 * 2. Selecting the same frame twice reuses the one copy — the dataset does not
 *    double its disk because the operator clicked again.
 * 3. **An evaporated original blocks the selection OF THE ORIGINAL, and never
 *    the copy already taken.** This is the one that decides whether an
 *    annotation made last week survives retention sweeping the track it came
 *    from, and it is the reason `copyFrame` reads the copy index BEFORE it
 *    reads the source.
 *
 * Red-green: inverting steps 1 and 2 of `copyFrame` (source read first) makes
 * the third test fail and nothing else — verified by doing it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callDeferredRelease } from '../../../__tests__/support/vitest-mock.js'
import { type FakeRecords, kindRows, makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { EventLedgerCollection } from '../../store/event-ledger-collection.js'
import { wireRetrainFrameLedger } from '../../store/event-ledger-wiring.js'
import type { MediaBlobStorage } from '../../location-aware-media-storage.js'
import { MediaWriteGate } from '../../media-write-gate.js'
import { RetrainFrameStore, retrainFrameId } from '../retrain-frame-store.js'

/** A 4×2 baseline JPEG header — enough for `readJpegSize`, no encoder needed. */
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

interface Harness {
  readonly store: RetrainFrameStore
  readonly written: Map<string, Buffer>
  readonly sourceReads: number[]
  readonly setSource: (mediaId: number, data: Buffer | null) => void
  readonly world: FakeRecords
  readonly frameLedger: EventLedgerCollection
  /** Rows the `retrain-frames` kind holds. */
  readonly frameRows: () => number
}

async function makeHarness(): Promise<Harness> {
  const world = await makeAnalyticsRecords()
  const frameLedger = wireRetrainFrameLedger({ records: world.records })
  const written = new Map<string, Buffer>()
  const sources = new Map<number, Buffer | null>()
  const sourceReads: number[] = []
  const storage: MediaBlobStorage = {
    write: async ({ relativePath, data }) => {
      written.set(relativePath, data)
    },
    read: async ({ relativePath }) => {
      const found = written.get(relativePath)
      if (!found) throw new Error(`no blob at ${relativePath}`)
      return found
    },
    delete: async ({ relativePath }) => {
      written.delete(relativePath)
    },
  }
  const store = new RetrainFrameStore({
    frameLedger,
    storage,
    logger: makeSilentLogger(),
    now: () => 1_700_000_000_000,
    readSource: async (mediaId) => {
      sourceReads.push(mediaId)
      return sources.get(mediaId) ?? null
    },
  })
  return {
    store,
    written,
    sourceReads,
    setSource: (mediaId, data) => sources.set(mediaId, data),
    world,
    frameLedger,
    frameRows: () => kindRows(world, 'retrain-frames').length,
  }
}

const SELECTION = {
  deviceId: 101,
  trackId: 'track-a',
  sourceMediaId: 501,
  sourceKind: 'keyFrame',
} as const

describe('copy-on-select', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  it('copies the bytes at selection time and records the copy', async () => {
    h.setSource(SELECTION.sourceMediaId, jpegOf(3840, 2160))

    const result = await h.store.copyFrame(SELECTION)

    expect(result.kind).toBe('copied')
    if (result.kind !== 'copied') return
    expect(result.reused).toBe(false)
    expect(result.frame.width).toBe(3840)
    expect(result.frame.height).toBe(2160)
    // The blob really landed — a row with no blob is an entry the dataset
    // believes in and cannot produce.
    expect(h.written.size).toBe(1)
    expect(h.frameRows()).toBe(1)
  })

  it('reuses the one copy when the same frame is selected twice', async () => {
    h.setSource(SELECTION.sourceMediaId, jpegOf(1920, 1080))

    const first = await h.store.copyFrame(SELECTION)
    const second = await h.store.copyFrame(SELECTION)

    expect(first.kind).toBe('copied')
    expect(second.kind).toBe('copied')
    if (second.kind !== 'copied') return
    expect(second.reused).toBe(true)
    expect(second.frame.frameId).toBe(retrainFrameId(SELECTION.trackId, SELECTION.sourceMediaId))
    expect(h.frameRows()).toBe(1)
    // And the source was read EXACTLY once — the second selection never touched
    // the original at all.
    expect(h.sourceReads).toEqual([SELECTION.sourceMediaId])
  })

  it('an evaporated original never invalidates the copy already taken', async () => {
    h.setSource(SELECTION.sourceMediaId, jpegOf(1920, 1080))
    await h.store.copyFrame(SELECTION)

    // Retention swept the track's own media.
    h.setSource(SELECTION.sourceMediaId, null)

    const again = await h.store.copyFrame(SELECTION)
    expect(again.kind).toBe('copied')
    if (again.kind !== 'copied') return
    expect(again.reused).toBe(true)
    // Still readable, because the dataset owns these pixels outright.
    expect(await h.store.readFrame(again.frame)).not.toBeNull()
  })

  it('refuses — with a named reason — a first selection whose original is gone', async () => {
    h.setSource(SELECTION.sourceMediaId, null)

    const result = await h.store.copyFrame(SELECTION)

    expect(result).toEqual({
      kind: 'refused',
      sourceMediaId: SELECTION.sourceMediaId,
      reason: 'source-missing',
    })
    expect(h.frameRows()).toBe(0)
    expect(h.written.size).toBe(0)
  })

  it('LOGS the dropped selection — a branch that drops work is never silent', async () => {
    const logger = makeSilentLogger()
    const warn = vi.spyOn(logger, 'warn')
    const store = new RetrainFrameStore({
      frameLedger: wireRetrainFrameLedger({ records: (await makeAnalyticsRecords()).records }),
      storage: { write: async () => {}, read: async () => Buffer.alloc(0), delete: async () => {} },
      logger,
      now: () => 0,
      readSource: async () => null,
    })

    await store.copyFrame(SELECTION)

    expect(warn).toHaveBeenCalledTimes(1)
    const [message, payload] = warn.mock.calls[0]!
    expect(message).toContain('source media no longer exists')
    // Per-camera diagnosis is the only question ever asked of this line.
    expect(payload).toMatchObject({ tags: { deviceId: 101 } })
  })

  it('refuses a source that is not a decodable JPEG rather than storing a blank frame', async () => {
    h.setSource(SELECTION.sourceMediaId, Buffer.from('not a jpeg at all'))

    const result = await h.store.copyFrame(SELECTION)

    expect(result).toMatchObject({ kind: 'refused', reason: 'unreadable-image' })
    expect(h.frameRows()).toBe(0)
  })

  it('gives two different sources of one track two different copies', async () => {
    h.setSource(501, jpegOf(1920, 1080))
    h.setSource(502, jpegOf(1280, 720))

    await h.store.copyFrame(SELECTION)
    await h.store.copyFrame({ ...SELECTION, sourceMediaId: 502 })

    const frames = await h.store.listByTrack('track-a')
    expect(frames).toHaveLength(2)
    expect(new Set(frames.map((f) => f.frameId)).size).toBe(2)
  })

  it('routes retraining writes through the migration gate', async () => {
    const gate = new MediaWriteGate()
    await gate.pause()
    const store = new RetrainFrameStore({
      frameLedger: h.frameLedger,
      storage: {
        write: async () => undefined,
        read: async () => Buffer.alloc(0),
        delete: async () => undefined,
      },
      logger: makeSilentLogger(),
      now: () => 0,
      readSource: async () => jpegOf(32, 32),
      writeGate: gate,
    })

    await expect(store.copyFrame(SELECTION)).resolves.toMatchObject({
      kind: 'refused',
      reason: 'write-failed',
    })
    expect(h.frameRows()).toBe(0)
  })

  it('drains an admitted retraining write before pausing later selections', async () => {
    const gate = new MediaWriteGate()
    let releaseWrite: (() => void) | null = null
    let writeStarted: (() => void) | null = null
    const writeStartedPromise = new Promise<void>((resolve) => {
      writeStarted = resolve
    })
    const store = new RetrainFrameStore({
      frameLedger: h.frameLedger,
      storage: {
        write: async () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve
            writeStarted?.()
          }),
        read: async () => Buffer.alloc(0),
        delete: async () => undefined,
      },
      logger: makeSilentLogger(),
      now: () => 0,
      readSource: async () => jpegOf(32, 32),
      writeGate: gate,
    })

    const first = store.copyFrame(SELECTION)
    await writeStartedPromise
    const paused = gate.pause()
    await expect(store.copyFrame({ ...SELECTION, sourceMediaId: 502 })).resolves.toMatchObject({
      kind: 'refused',
      reason: 'write-failed',
    })
    callDeferredRelease(releaseWrite)
    await expect(first).resolves.toMatchObject({ kind: 'copied', reused: false })
    await paused
  })
})

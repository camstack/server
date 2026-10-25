/**
 * What a retrain copy records about itself, beyond its pixels.
 *
 * - `capturedAt`: when the CAMERA saw the frame — the source media row's
 *   timestamp. `copiedAt` is when the operator clicked, which says nothing
 *   about the light or the day a time-blocked split must group by.
 * - `chromaSpread`: measured once from the bytes at copy time, so the export
 *   can tell an IR frame without decoding anything (D785).
 * - `complete`: the operator's "every subject in this frame is boxed". A
 *   detector evaluated on a frame with an unboxed person counts that person as
 *   a false positive, so evaluation must be able to keep only complete frames.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { type FakeRecords, kindRows, makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeFakeStorageProvider, makeSilentLogger } from '../../__tests__/test-helpers.js'
import { wireRetrainFrameLedger } from '../../store/event-ledger-wiring.js'
import { RetrainFrameStore } from '../retrain-frame-store.js'

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

const SELECTION = {
  deviceId: 101,
  trackId: 'track-a',
  sourceMediaId: 501,
  sourceKind: 'keyFrame',
  capturedAt: 1_699_000_000_000,
} as const

describe('retrain copy metadata', () => {
  let world: FakeRecords
  let measured: number | Error

  const makeStore = (): RetrainFrameStore =>
    new RetrainFrameStore({
      frameLedger: wireRetrainFrameLedger({ records: world.records }),
      storage: makeFakeStorageProvider(),
      logger: makeSilentLogger(),
      now: () => 1_700_000_000_000,
      readSource: async () => jpegOf(1920, 1080),
      measureChroma: async () => {
        if (measured instanceof Error) throw measured
        return measured
      },
    })

  beforeEach(async () => {
    world = await makeAnalyticsRecords()
    measured = 3.5
  })

  it('records when the camera captured the frame, and its measured chroma', async () => {
    const result = await makeStore().copyFrame(SELECTION)
    if (result.kind !== 'copied') throw new Error('copy refused')

    expect(result.frame.capturedAt).toBe(SELECTION.capturedAt)
    expect(result.frame.copiedAt).toBe(1_700_000_000_000)
    expect(result.frame.chromaSpread).toBe(3.5)
    expect(result.frame.complete).toBe(false)
    const reread = await makeStore().get(result.frame.frameId)
    expect(reread?.capturedAt).toBe(SELECTION.capturedAt)
    expect(reread?.chromaSpread).toBe(3.5)
    expect(reread?.complete).toBe(false)
  })

  it('a chroma measurement that fails never refuses the copy — the value is absent, not zero', async () => {
    measured = new Error('sharp exploded')

    const result = await makeStore().copyFrame(SELECTION)

    expect(result.kind).toBe('copied')
    if (result.kind !== 'copied') return
    // Zero would read as "flat frame, IR" — the opposite of unknown.
    expect(result.frame.chromaSpread).toBeUndefined()
  })

  it('the operator marks a frame complete, and can take it back', async () => {
    const store = makeStore()
    const result = await store.copyFrame(SELECTION)
    if (result.kind !== 'copied') throw new Error('copy refused')

    const marked = await store.setComplete(result.frame.frameId, true)
    expect(marked?.complete).toBe(true)
    expect((await store.get(result.frame.frameId))?.complete).toBe(true)

    const unmarked = await store.setComplete(result.frame.frameId, false)
    expect(unmarked?.complete).toBe(false)
  })

  it('marking a frame that does not exist answers null and writes nothing', async () => {
    expect(await makeStore().setComplete('retrain:none:0', true)).toBeNull()
    expect(kindRows(world, 'retrain-frames')).toHaveLength(0)
  })
})

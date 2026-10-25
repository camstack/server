/**
 * D658 — a refused object embedding is COUNTED, not logged per track.
 *
 * On 2026-09-27 a runner stamped SigLIP2 on MobileCLIP vectors for twenty
 * minutes and `ObjectEmbeddingStore` refused every one, with one WARN per track:
 * 178 identical lines, and no line that said "nothing has been stored since
 * 09:38". The refusal is right; the flood is the defect. One line at the onset,
 * then one per interval per (camera, model, reason), with the count.
 */
import { describe, expect, it } from 'vitest'
import { makeFakeVectorStore, makeLogRecorder } from '../../__tests__/test-helpers.js'
import { TEST_SIGLIP_INDEX, testClipRegistry } from '../../__tests__/fixtures/clip-test-registry.js'
import { ObjectEmbeddingStore } from '../object-embedding-store.js'

const MC_DIM = 4
const SIG_DIM = 6
const INTERVAL_MS = 60_000

function makeStore() {
  const vectors = makeFakeVectorStore()
  const logs = makeLogRecorder()
  const clock = { now: 1_000_000 }
  const store = new ObjectEmbeddingStore({
    vectorStore: vectors.client,
    logger: logs.logger,
    clipModels: testClipRegistry(MC_DIM, { siglipDim: SIG_DIM }),
    refusalReportIntervalMs: INTERVAL_MS,
    now: () => clock.now,
  })
  const refusalLines = () =>
    logs.entries.filter(
      (e) => e.level === 'warn' && e.message.startsWith('object embeddings refused'),
    )
  return { store, vectors, logs, clock, refusalLines }
}

const unit = (dim: number): number[] => Array.from({ length: dim }, (_, i) => (i === 0 ? 1 : 0))

const write = (
  trackId: string,
  deviceId: number,
  modelId: string,
  embedding: readonly number[],
) => ({
  trackId,
  deviceId,
  timestamp: 1_000,
  className: 'person',
  embedding,
  modelId,
  confidence: 0.9,
})

/** The incident's shape: a SigLIP2 stamp on a MobileCLIP-length vector. */
const mislabelled = (trackId: string, deviceId = 101) =>
  write(trackId, deviceId, 'siglip2-b16-224', unit(MC_DIM))

describe('dimension refusals are rate-limited per (camera, model)', () => {
  it('fifty refused tracks on one camera write ONE line at the onset, not fifty', async () => {
    const { store, vectors, refusalLines } = makeStore()
    for (let i = 0; i < 50; i++) {
      expect(await store.upsertIfBetter(mislabelled(`t${i}`))).toBe('failed')
    }
    expect(vectors.rows.get(TEST_SIGLIP_INDEX)?.size ?? 0).toBe(0)
    const lines = refusalLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]!.extras?.tags).toEqual({ deviceId: 101 })
    expect(lines[0]!.extras?.meta).toMatchObject({
      reason: 'dimension-mismatch',
      modelId: 'siglip2-b16-224',
      refused: 1,
      dim: MC_DIM,
      expected: SIG_DIM,
      closing: 'first',
    })
  })

  it('the next line after the interval carries the count of everything refused since', async () => {
    const { store, clock, refusalLines } = makeStore()
    for (let i = 0; i < 50; i++) await store.upsertIfBetter(mislabelled(`t${i}`))
    clock.now += INTERVAL_MS
    await store.upsertIfBetter(mislabelled('t50'))
    const lines = refusalLines()
    expect(lines).toHaveLength(2)
    // The 49 held since the onset line; the 51st opens the next window.
    expect(lines[1]!.extras?.meta).toMatchObject({ refused: 49, closing: 'interval' })
    // Nothing is lost: every refusal is in exactly one line's count.
    store.flushRefusals()
    const total = refusalLines().reduce((n, l) => n + Number(l.extras?.meta?.['refused'] ?? 0), 0)
    expect(total).toBe(51)
  })

  it('two cameras are two lines; the same camera on another model is another line', async () => {
    const { store, refusalLines } = makeStore()
    await store.upsertIfBetter(mislabelled('a', 101))
    await store.upsertIfBetter(mislabelled('b', 102))
    await store.upsertIfBetter(write('c', 101, 'mobileclip-s1', unit(SIG_DIM)))
    await store.upsertIfBetter(mislabelled('d', 101))
    expect(refusalLines().map((l) => [l.extras?.tags, l.extras?.meta?.['modelId']])).toEqual([
      [{ deviceId: 101 }, 'siglip2-b16-224'],
      [{ deviceId: 102 }, 'siglip2-b16-224'],
      [{ deviceId: 101 }, 'mobileclip-s1'],
    ])
  })

  it('a tail is never swallowed: the next write past the interval reports it, whatever camera wrote', async () => {
    const { store, clock, refusalLines } = makeStore()
    for (let i = 0; i < 5; i++) await store.upsertIfBetter(mislabelled(`t${i}`))
    // The runner is fixed: refusals stop, good vectors arrive on ANOTHER camera.
    clock.now += INTERVAL_MS
    expect(await store.upsertIfBetter(write('ok', 999, 'mobileclip-s1', unit(MC_DIM)))).toBe(
      'persisted',
    )
    const lines = refusalLines()
    expect(lines).toHaveLength(2)
    expect(lines[1]!.extras?.tags).toEqual({ deviceId: 101 })
    expect(lines[1]!.extras?.meta).toMatchObject({ refused: 4, closing: 'interval' })
  })

  it('flush reports what is still pending', async () => {
    const { store, refusalLines } = makeStore()
    for (let i = 0; i < 3; i++) await store.upsertIfBetter(mislabelled(`t${i}`))
    store.flushRefusals()
    expect(refusalLines().map((l) => l.extras?.meta?.['refused'])).toEqual([1, 2])
  })

  it('a model with no CLIP metadata is counted the same way', async () => {
    const { store, refusalLines } = makeStore()
    for (let i = 0; i < 10; i++) {
      expect(await store.upsertIfBetter(write(`t${i}`, 101, 'arcface-r100', unit(MC_DIM)))).toBe(
        'failed',
      )
    }
    expect(refusalLines()).toHaveLength(1)
    expect(refusalLines()[0]!.extras?.meta).toMatchObject({ reason: 'no-clip-metadata' })
  })
})

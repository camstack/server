/**
 * The bundle a promoted tape downloads as (spec §3.3): one gzip JSON the CLI
 * reads with `node:zlib`. The stream honours backpressure through `pipeline`
 * and CUTS a peer that never drains — every exit logged with the camera
 * (D447).
 *
 * Disarm: remove `res.destroy(…)` from the stall watchdog — the stalled-peer
 * test must fail (it times out instead of resolving `peer-stalled`).
 */
import { Writable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { sampleEnd, sampleFrame, sampleHeader } from './tape-fixtures.js'
import { bundleChunks, type BundleParts, parseBundle, streamBundle } from '../bundle.js'

const PARTS: BundleParts = {
  manifest: {
    tapeId: 'promo-0001',
    deviceId: 101,
    scenario: '101-door-groups',
    lighting: 'day',
    durationMs: 200,
    frames: 2,
    skips: 0,
    gaps: 0,
    reviewed: true,
    recordedDate: '2026-09-29',
  },
  gt: { version: 1, reviewed: true, relations: [], purities: [], external: [] },
  tape: {
    header: sampleHeader(),
    body: [sampleFrame(0), sampleFrame(200)],
    end: sampleEnd({ durationMs: 200 }),
  },
}

describe('bundle', () => {
  it('round-trips through gzip', () => {
    const gz = gzipSync([...bundleChunks(PARTS)].join(''))
    expect(parseBundle(gz)).toEqual(PARTS)
  })

  it('streams to a slow but live peer and says complete', async () => {
    const chunks: Buffer[] = []
    const res = new Writable({
      highWaterMark: 16,
      write(chunk: Buffer, _enc, cb) {
        chunks.push(chunk)
        setImmediate(cb)
      },
    })
    const { logger, entries } = makeLogRecorder()
    const exit = await streamBundle(res, PARTS, {
      logger,
      drainTimeoutMs: 1_000,
      checkEveryMs: 10,
      now: () => Date.now(),
    })
    expect(exit).toBe('complete')
    expect(parseBundle(Buffer.concat(chunks))).toEqual(PARTS)
    expect(entries.find((e) => e.message === 'tape export finished')?.extras?.tags).toEqual({
      deviceId: 101,
    })
  })

  it('cuts a peer that never drains', async () => {
    const res = new Writable({
      highWaterMark: 1,
      write(_chunk, _enc, _cb) {
        // never calls back: the peer stopped reading
      },
    })
    const { logger, entries } = makeLogRecorder()
    const exit = await streamBundle(res, PARTS, {
      logger,
      drainTimeoutMs: 50,
      checkEveryMs: 10,
      now: () => Date.now(),
    })
    expect(exit).toBe('peer-stalled')
    expect(entries.find((e) => e.message === 'tape export finished')?.extras?.meta).toMatchObject({
      exit: 'peer-stalled',
    })
  }, 2_000)

  // Fix round 1 (M4): a recognised peer-disconnect code names the PEER;
  // anything else names OUR OWN failure. The two used to be conflated.
  it('calls a recognised peer disconnect "peer-closed", with its cause', async () => {
    const res = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      },
    })
    const { logger, entries } = makeLogRecorder()
    const exit = await streamBundle(res, PARTS, {
      logger,
      drainTimeoutMs: 1_000,
      checkEveryMs: 10,
      now: () => Date.now(),
    })
    expect(exit).toBe('peer-closed')
    expect(entries.find((e) => e.message === 'tape export finished')?.extras?.meta).toMatchObject({
      exit: 'peer-closed',
      error: 'write EPIPE',
    })
  })

  it('names an unrecognised failure "failed", with its cause — never "peer-closed"', async () => {
    const res = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('disk exploded'))
      },
    })
    const { logger, entries } = makeLogRecorder()
    const exit = await streamBundle(res, PARTS, {
      logger,
      drainTimeoutMs: 1_000,
      checkEveryMs: 10,
      now: () => Date.now(),
    })
    expect(exit).toBe('failed')
    expect(entries.find((e) => e.message === 'tape export finished')?.extras?.meta).toMatchObject({
      exit: 'failed',
      error: 'disk exploded',
    })
  })
})

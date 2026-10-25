/**
 * Writer discipline (spec §3.3): appends never block the frame path. While the
 * sink is backed up, records queue for up to 5 s of RECORD time; past that they
 * are dropped, and the drop becomes a `gap` record plus a `tracking tape gap`
 * line tagged with the camera — a lossy segment says it is lossy.
 *
 * Disarm: remove the `t - this.queueStartT > BACKPRESSURE_MAX_MS` branch
 * (queue forever) — the gap test must fail.
 *
 * Fix round 1 additions (task-8-review.md):
 *  - HIGH: `close()` must never let a `sink.finish()` rejection propagate
 *    uncaught. It catches, logs `tracking tape segment close failed` tagged
 *    with the camera, and returns `'close-failed'` rather than throwing.
 *    Disarm: remove the `try`/`catch` around `sink.finish()` (let it throw) —
 *    the failing-sink test must fail (the `await w.close(...)` rejects).
 *  - MEDIUM: `openGzipStream` (what `openGzipFileSink` wraps) uses
 *    `pipeline()` from `node:stream/promises` instead of `gzip.pipe(out)`, so
 *    an error on the destination stream tears the gzip stream down too (a
 *    documented `.pipe()` gotcha otherwise — the source keeps running,
 *    unbounded, with nowhere to drain). Exercised directly against
 *    `openGzipStream()` with a `PassThrough` destination — the SAME function
 *    `openGzipFileSink` calls — so the cross-destroy is proven without
 *    depending on a real disk fault, and the test is not vacuous with
 *    respect to the shared production code path.
 *    Disarm: revert `openGzipStream` to `gzip.pipe(out)` with the old
 *    dual-`once('error', reject)` `closed` promise — the cross-destroy test
 *    must fail (`gzip.destroyed` stays `false`).
 *  - LOW: every exit is now logged, tagged — `close()` on success logs
 *    `tracking tape segment sink closed` at info, and `append()` logs
 *    `tracking tape segment full` at info the first time the cap is crossed.
 *  - (D681 follow-up) Disarm: empty `flushToDisk` — "flushes pending gzip
 *    output without closing the segment" fails (destination stays empty).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../../__tests__/test-helpers.js'
import { sampleFrame, sampleHeader } from '../../__tests__/tape-fixtures.js'
import { decodeTapeText, encodeTapeLine, readTapeFile } from '../../tape-codec.js'
import {
  openGzipFileSink,
  openGzipStream,
  type TapeSink,
  TapeSegmentWriter,
} from '../segment-writer.js'

interface ControlledSink extends TapeSink {
  readonly lines: string[]
  blockAfter: number
  drain(): void
}

function controlledSink(): ControlledSink {
  const lines: string[] = []
  let listener: (() => void) | null = null
  const sink: ControlledSink = {
    lines,
    blockAfter: Number.POSITIVE_INFINITY,
    write(line) {
      lines.push(line)
      return lines.length < sink.blockAfter
    },
    onceDrain(l) {
      listener = l
    },
    async flush() {},
    async finish() {},
    drain() {
      sink.blockAfter = Number.POSITIVE_INFINITY
      const l = listener
      listener = null
      l?.()
    },
  }
  return sink
}

describe('TapeSegmentWriter', () => {
  it('turns more than 5 s of backpressure into a gap record and a tagged log line', async () => {
    const sink = controlledSink()
    const { logger, entries } = makeLogRecorder()
    const w = new TapeSegmentWriter({ sink, deviceId: 102, segmentOriginMs: 1, logger })
    w.append(sampleHeader(), 0)
    sink.blockAfter = 2 // the next write reports backpressure
    expect(w.append(sampleFrame(100), 100)).toBe('written')
    // blocked from here: queued up to 5 s after the first queued record
    expect(w.append(sampleFrame(200), 200)).toBe('queued')
    expect(w.append(sampleFrame(5_200), 5_200)).toBe('queued')
    expect(w.append(sampleFrame(5_300), 5_300)).toBe('dropped')
    expect(w.append(sampleFrame(6_000), 6_000)).toBe('dropped')

    sink.drain()
    const outcome = await w.close('segment-end', 6_000)

    expect(outcome).toBe('closed')
    const tape = decodeTapeText(sink.lines.join(''))
    expect(tape.body.map((r) => (r.kind === 'frame' ? r.t : r.kind))).toEqual([
      100,
      200,
      5_200,
      'gap',
    ])
    expect(tape.body[3]).toEqual({ kind: 'gap', fromT: 5_300, toT: 6_000, reason: 'backpressure' })
    expect(tape.end).toMatchObject({ reason: 'segment-end', frames: 3, gaps: 1 })
    const gap = entries.find((e) => e.message === 'tracking tape gap')
    expect(gap?.extras?.tags).toEqual({ deviceId: 102 })
    expect(gap?.extras?.meta).toMatchObject({ fromT: 5_300, toT: 6_000 })
    const closedLine = entries.find((e) => e.message === 'tracking tape segment sink closed')
    expect(closedLine?.level).toBe('info')
    expect(closedLine?.extras?.tags).toEqual({ deviceId: 102 })
    expect(closedLine?.extras?.meta).toMatchObject({ reason: 'segment-end' })
  })

  it('reports full once the raw size cap is reached, logs it once, and still writes the record that crossed it', () => {
    const sink = controlledSink()
    const { logger, entries } = makeLogRecorder()
    const headerBytes = Buffer.byteLength(encodeTapeLine(sampleHeader()))
    const frameBytes = Buffer.byteLength(encodeTapeLine(sampleFrame(0)))
    const w = new TapeSegmentWriter({
      sink,
      deviceId: 101,
      segmentOriginMs: 1,
      logger,
      maxRawBytes: headerBytes + 2 * frameBytes,
    })
    expect(w.append(sampleHeader(), 0)).toBe('written')
    expect(w.append(sampleFrame(0), 0)).toBe('written')
    const outcomes = [w.append(sampleFrame(1), 1), w.append(sampleFrame(2), 2)]
    expect(outcomes).toContain('full')
    expect(w.isFull).toBe(true)
    expect(sink.lines).toHaveLength(1 + 1 + outcomes.length)
    const fullLines = entries.filter((e) => e.message === 'tracking tape segment full')
    expect(fullLines).toHaveLength(1)
    expect(fullLines[0]?.level).toBe('info')
    expect(fullLines[0]?.extras?.tags).toEqual({ deviceId: 101 })
  })

  it('reports close-failed and logs the reason, tagged, when the sink cannot finish', async () => {
    const sink = controlledSink()
    sink.finish = async () => {
      throw new Error('ENOSPC')
    }
    const { logger, entries } = makeLogRecorder()
    const w = new TapeSegmentWriter({ sink, deviceId: 108, segmentOriginMs: 1, logger })
    w.append(sampleHeader(), 0)
    const outcome = await w.close('segment-end', 0)
    expect(outcome).toBe('close-failed')
    const failure = entries.find((e) => e.message === 'tracking tape segment close failed')
    expect(failure?.level).toBe('warn')
    expect(failure?.extras?.tags).toEqual({ deviceId: 108 })
    expect(failure?.extras?.meta).toMatchObject({ reason: 'segment-end', error: 'ENOSPC' })
    expect(entries.some((e) => e.message === 'tracking tape segment sink closed')).toBe(false)
  })

  describe('gzip file sink', () => {
    let dir = ''
    afterEach(async () => {
      if (dir !== '') await rm(dir, { recursive: true, force: true })
    })

    it('writes a gzip JSONL file the codec reads back', async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'segment-'))
      const file = path.join(dir, 'nested', '1.jsonl.gz')
      const sink = await openGzipFileSink(file)
      const { logger, entries } = makeLogRecorder()
      const w = new TapeSegmentWriter({ sink, deviceId: 101, segmentOriginMs: 1, logger })
      w.append(sampleHeader(), 0)
      w.append(sampleFrame(0), 0)
      const outcome = await w.close('switched-off', 0)
      expect(outcome).toBe('closed')
      const tape = await readTapeFile(file, { logger })
      expect(tape.body).toHaveLength(1)
      expect(tape.end?.reason).toBe('switched-off')
      const closedLine = entries.find((e) => e.message === 'tracking tape segment sink closed')
      expect(closedLine?.extras?.tags).toEqual({ deviceId: 101 })
    })

    it('flushes pending gzip output without closing the segment (D681 follow-up)', async () => {
      const chunks: Buffer[] = []
      const out = new PassThrough()
      out.on('data', (c: Buffer) => {
        chunks.push(c)
      })
      const sink = openGzipStream(out)
      const { logger } = makeLogRecorder()
      const w = new TapeSegmentWriter({ sink, deviceId: 101, segmentOriginMs: 1, logger })
      w.append(sampleHeader(), 0)
      w.append(sampleFrame(0), 0)
      expect(Buffer.concat(chunks).length).toBe(0)
      await w.flushToDisk()
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0)
      const outcome = await w.close('switched-off', 0)
      expect(outcome).toBe('closed')
    })

    it('tears down the gzip stream and reports the failure when the destination write stream errors mid-segment', async () => {
      const out = new PassThrough()
      // The exact function `openGzipFileSink` calls with a real file stream —
      // using it here (not a hand-rolled `pipeline()` in the spec) is what
      // makes the disarm below load-bearing against production code.
      const sink = openGzipStream(out)
      const { logger, entries } = makeLogRecorder()
      const w = new TapeSegmentWriter({ sink, deviceId: 619, segmentOriginMs: 1, logger })

      expect(w.append(sampleHeader(), 0)).toBe('written')
      out.destroy(new Error('disk full'))
      // Let `pipeline()` observe the destination's error and tear the gzip
      // stream down too — proven behaviourally below, never by peeking at a
      // stream internal: a write that would otherwise keep buffering forever
      // now reports backpressure instead.
      await new Promise<void>((resolve) => setImmediate(resolve))

      // This append's OWN write is the one that fails, so — same convention
      // as the backpressure test above, where the write that trips
      // backpressure is still reported as an attempt, not a queue — it
      // still reports `'written'`, but it leaves the writer blocked.
      expect(w.append(sampleFrame(0), 0)).toBe('written')
      // The gzip stream is gone: writes no longer silently buffer past it —
      // this next append queues, bounded by the same 5 s window, rather than
      // accepting records into a pipe with nowhere left to drain.
      expect(w.append(sampleFrame(1), 1)).toBe('queued')

      const outcome = await w.close('segment-end', 0)
      expect(outcome).toBe('close-failed')
      const failure = entries.find((e) => e.message === 'tracking tape segment close failed')
      expect(failure?.extras?.tags).toEqual({ deviceId: 619 })
      expect(failure?.extras?.meta).toMatchObject({ error: 'disk full' })
    })
  })
})

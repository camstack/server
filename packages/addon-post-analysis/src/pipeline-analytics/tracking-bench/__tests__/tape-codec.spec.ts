/**
 * `readTapeFile` (Task 15 review carry-over): it used to run `gunzipSync`
 * plus a synchronous JSONL parse on the pipeline-analytics event loop, and
 * `debug.tape.*` now lets an admin click reach it (`debug.tape.tracks`, tape
 * promotion). It decompresses through the `zlib` promise API instead —
 * behaviour stays the same, proved here against the file the sync primitives
 * would have decoded — and logs the file's raw size and the read's duration,
 * tagged with `deviceId` only when the caller has one.
 *
 * (Fix round 1, review LOW.) The log line is `debug` by default and only
 * `info` when the read is slow (over `READ_TAPE_LOG_SLOW_MS`) or the file is
 * large (over `READ_TAPE_LOG_LARGE_BYTES`) — a promotion that decodes many
 * segments should not flood `info` on every one of them.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import {
  DECODE_TAPE_TEXT_YIELD_EVERY,
  decodeTapeText,
  decodeTapeTextAsync,
  encodeTapeGzip,
  encodeTapeGzipAsync,
  READ_TAPE_LOG_LARGE_BYTES,
  READ_TAPE_LOG_SLOW_MS,
  readTapeFile,
  readTapeFileLogLevel,
  type Tape,
} from '../tape-codec.js'
import { sampleEnd, sampleFrame, sampleHeader } from './tape-fixtures.js'

async function writeSampleTapeFile(dir: string): Promise<{ file: string; tape: Tape; gz: Buffer }> {
  const tape: Tape = {
    header: sampleHeader(),
    body: [sampleFrame(0), sampleFrame(1_000)],
    end: sampleEnd(),
  }
  const gz = encodeTapeGzip(tape)
  const file = path.join(dir, 'segment.jsonl.gz')
  await writeFile(file, gz)
  return { file, tape, gz }
}

describe('readTapeFile', () => {
  let dir = ''
  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
  })

  it('returns exactly what the sync gunzip + parse would have (the async rewrite changes no behaviour)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tape-codec-'))
    const { file, tape, gz } = await writeSampleTapeFile(dir)
    const { logger } = makeLogRecorder()
    const expected = decodeTapeText(gunzipSync(gz).toString('utf8'))
    const actual = await readTapeFile(file, { logger })
    expect(actual).toEqual(expected)
    expect(actual).toEqual(tape)
  })

  it('logs at debug by default, with the file size and read duration, tagged with deviceId when the caller has one', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tape-codec-'))
    const { file, gz } = await writeSampleTapeFile(dir)
    const { logger, entries } = makeLogRecorder()
    await readTapeFile(file, { logger, deviceId: 101 })
    const line = entries.find((e) => e.message === 'tracking tape file read')
    expect(line?.level).toBe('debug')
    expect(line?.extras?.tags).toEqual({ deviceId: 101 })
    expect(line?.extras?.meta).toMatchObject({ file, rawBytes: gz.length })
    expect(typeof line?.extras?.meta?.['durationMs']).toBe('number')
  })

  it('logs with no device tag when the caller has none', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tape-codec-'))
    const { file } = await writeSampleTapeFile(dir)
    const { logger, entries } = makeLogRecorder()
    await readTapeFile(file, { logger })
    const line = entries.find((e) => e.message === 'tracking tape file read')
    expect(line?.extras?.tags).toBeUndefined()
  })

  it('escalates to info when the read is slow', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tape-codec-'))
    const { file } = await writeSampleTapeFile(dir)
    const { logger, entries } = makeLogRecorder()
    const clock = [0, READ_TAPE_LOG_SLOW_MS + 1]
    await readTapeFile(file, { logger, now: () => clock.shift() ?? 0 })
    const line = entries.find((e) => e.message === 'tracking tape file read')
    expect(line?.level).toBe('info')
    expect(line?.extras?.meta).toMatchObject({ durationMs: READ_TAPE_LOG_SLOW_MS + 1 })
  })
})

/** A tape with enough frame records to cross the yield threshold at least
 *  twice — big enough that a fully-synchronous decode would never let a
 *  macrotask scheduled ahead of it run before it finishes. */
function bigTape(frameCount: number): Tape {
  return {
    header: sampleHeader(),
    body: Array.from({ length: frameCount }, (_, i) => sampleFrame(i * 100)),
    end: sampleEnd({ durationMs: frameCount * 100 }),
  }
}

/** Schedules a marker on the NEXT macrotask (check-phase) tick, before it,
 *  and returns a reader for whether that tick has since run. `setImmediate`
 *  callbacks run FIFO, so if `work` yields the event loop at least once via
 *  its own `setImmediate` before settling, this marker — scheduled first —
 *  is guaranteed to have already fired by the time `work` resolves. If
 *  `work` never yields (one synchronous chunk, wrapped in a promise), its
 *  own microtask resolution beats this macrotask and the marker reads
 *  `false` right after `await`. */
function macrotaskMarker(): () => boolean {
  let fired = false
  setImmediate(() => {
    fired = true
  })
  return () => fired
}

describe('decodeTapeTextAsync (fix round, M2)', () => {
  it('parses identically to the synchronous decodeTapeText', async () => {
    const tape = bigTape(50)
    const text = [
      JSON.stringify(tape.header),
      ...tape.body.map((r) => JSON.stringify(r)),
      JSON.stringify(tape.end),
    ]
      .map((l) => `${l}\n`)
      .join('')
    const sync = decodeTapeText(text)
    const async_ = await decodeTapeTextAsync(text)
    expect(async_).toEqual(sync)
    expect(async_).toEqual(tape)
  })

  it('yields to the event loop instead of blocking it for one long synchronous chunk', async () => {
    const tape = bigTape(DECODE_TAPE_TEXT_YIELD_EVERY * 2 + 10)
    const text = [
      JSON.stringify(tape.header),
      ...tape.body.map((r) => JSON.stringify(r)),
      JSON.stringify(tape.end),
    ]
      .map((l) => `${l}\n`)
      .join('')
    const marker = macrotaskMarker()
    await decodeTapeTextAsync(text)
    expect(marker()).toBe(true)
  })
})

describe('encodeTapeGzipAsync (fix round, M2)', () => {
  it('gzips to the same bytes gunzip decodes back to, identical to the sync encode', async () => {
    const tape = bigTape(20)
    const syncBytes = encodeTapeGzip(tape)
    const asyncBytes = await encodeTapeGzipAsync(tape)
    expect(decodeTapeText(gunzipSync(asyncBytes).toString('utf8'))).toEqual(tape)
    expect(decodeTapeText(gunzipSync(asyncBytes).toString('utf8'))).toEqual(
      decodeTapeText(gunzipSync(syncBytes).toString('utf8')),
    )
  })
})

describe('readTapeFileLogLevel', () => {
  it('is debug at and under both thresholds', () => {
    expect(readTapeFileLogLevel(0, 0)).toBe('debug')
    expect(readTapeFileLogLevel(READ_TAPE_LOG_SLOW_MS, READ_TAPE_LOG_LARGE_BYTES)).toBe('debug')
  })

  it('is info over the slow threshold', () => {
    expect(readTapeFileLogLevel(READ_TAPE_LOG_SLOW_MS + 1, 0)).toBe('info')
  })

  it('is info over the large threshold', () => {
    expect(readTapeFileLogLevel(0, READ_TAPE_LOG_LARGE_BYTES + 1)).toBe('info')
  })
})

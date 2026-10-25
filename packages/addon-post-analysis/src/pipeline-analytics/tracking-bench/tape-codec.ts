/**
 * JSON Lines ⇄ `Tape`. Pure over text; the only I/O is `readTapeFile`, which
 * gunzips a whole file (a segment is ≤ 32 MB raw, a promoted tape ≤ 30 min).
 *
 * (Task 15 review carry-over.) `readTapeFile` used to run `gunzipSync` — the
 * whole decompress on the pipeline-analytics event loop — and `debug.tape.*`
 * now lets an admin click reach it directly (`debug.tape.tracks`, tape
 * promotion). It decompresses through the `zlib` PROMISE API instead, off the
 * main thread, and logs the file size and how long the read took, tagged with
 * `deviceId` when the caller has one — so a slow decode is visible rather
 * than a silent stall, the same discipline as D447's synchronous-thread note.
 *
 * (Fix round 1, review LOW.) Every read logging at `info` is noisy on a
 * promotion that decodes many segments. The line is `debug` by default and
 * only promoted to `info` when the read itself is worth an operator's
 * attention: slower than {@link READ_TAPE_LOG_SLOW_MS} or bigger on disk than
 * {@link READ_TAPE_LOG_LARGE_BYTES}.
 */
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { gunzip, gzip, gzipSync } from 'node:zlib'
import type { IScopedLogger } from '@camstack/types'
import { z } from 'zod'
import {
  parseTapeRecord,
  type TapeBodyRecord,
  type TapeEnd,
  type TapeHeader,
  type TapeRecord,
} from './tape-schema.js'

export interface Tape {
  readonly header: TapeHeader
  readonly body: readonly TapeBodyRecord[]
  /** `null` while a segment is still being written. */
  readonly end: TapeEnd | null
}

export class TapeDecodeError extends Error {
  constructor(
    readonly line: number,
    detail: string,
  ) {
    super(`tracking tape line ${String(line)}: ${detail}`)
    this.name = 'TapeDecodeError'
  }
}

const VersionPeekSchema = z.object({ version: z.number().int() })

export function encodeTapeLine(record: TapeRecord): string {
  return `${JSON.stringify(record)}\n`
}

/** Parse the first line into a header, or throw. Shared by the sync decode
 *  and its yielding twin (M2) so the two can never validate differently. */
function decodeTapeHeaderLine(first: string | undefined): { header: TapeHeader; version: number } {
  if (first === undefined) throw new TapeDecodeError(1, 'empty tape')
  const rawHeader: unknown = JSON.parse(first)
  const peek = VersionPeekSchema.safeParse(rawHeader)
  if (!peek.success) throw new TapeDecodeError(1, 'the first line carries no version')
  const header = parseTapeRecord(rawHeader, peek.data.version)
  if (header.kind !== 'header') throw new TapeDecodeError(1, 'the first line is not a header')
  return { header, version: peek.data.version }
}

/** Parse one body line — throws if a record follows a recorded `end`, or a
 *  second header shows up. Shared for the same reason as the header parse. */
function decodeTapeBodyLine(
  line: string,
  version: number,
  lineNo: number,
): Exclude<TapeRecord, TapeHeader> {
  const record = parseTapeRecord(JSON.parse(line), version)
  if (record.kind === 'header') throw new TapeDecodeError(lineNo, 'a second header')
  return record
}

export function decodeTapeText(text: string): Tape {
  const lines = text.split('\n').filter((l) => l.length > 0)
  const { header, version } = decodeTapeHeaderLine(lines[0])
  const body: TapeBodyRecord[] = []
  let end: TapeEnd | null = null
  for (let i = 1; i < lines.length; i += 1) {
    if (end !== null) throw new TapeDecodeError(i + 1, 'a record follows the end')
    const record = decodeTapeBodyLine(lines[i] ?? '', version, i + 1)
    if (record.kind === 'end') end = record
    else body.push(record)
  }
  return { header, body, end }
}

/** A single macrotask tick — lets frame processing (and anything else queued
 *  on the analytics event loop) run between chunks of a big synchronous
 *  decode or cut (fix round, M2). Exported so `cutWindow` yields the same way
 *  rather than growing its own copy of the same three lines. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/** Records between yields in {@link decodeTapeTextAsync}. Chosen so a chunk
 *  stays well under the ~20-50 ms budget at the ~15 µs/record measured cost
 *  (500 records ≈ 7.5 ms). */
export const DECODE_TAPE_TEXT_YIELD_EVERY = 500

/**
 * The runtime-path twin of {@link decodeTapeText} (fix round, M2): identical
 * validation, but yields to the event loop every
 * {@link DECODE_TAPE_TEXT_YIELD_EVERY} records so decoding a big promoted
 * segment (measured 552 ms synchronous at the 32 MiB raw cap) never blocks
 * the analytics event loop in one long chunk. Used only by `readTapeFile` —
 * every direct caller that wants a plain, synchronous parse (tests, the
 * bundle reader, the CLI) keeps using `decodeTapeText`.
 */
export async function decodeTapeTextAsync(text: string): Promise<Tape> {
  const lines = text.split('\n').filter((l) => l.length > 0)
  const { header, version } = decodeTapeHeaderLine(lines[0])
  const body: TapeBodyRecord[] = []
  let end: TapeEnd | null = null
  for (let i = 1; i < lines.length; i += 1) {
    if (end !== null) throw new TapeDecodeError(i + 1, 'a record follows the end')
    const record = decodeTapeBodyLine(lines[i] ?? '', version, i + 1)
    if (record.kind === 'end') end = record
    else body.push(record)
    if (i % DECODE_TAPE_TEXT_YIELD_EVERY === 0) await yieldToEventLoop()
  }
  return { header, body, end }
}

function tapeRecords(tape: Tape): TapeRecord[] {
  return [tape.header, ...tape.body, ...(tape.end === null ? [] : [tape.end])]
}

/** Synchronous gzip — kept for the CLI and for tests that want a plain,
 *  synchronous encode (fix round, M2). The runtime promotion path uses
 *  {@link encodeTapeGzipAsync} instead. */
export function encodeTapeGzip(tape: Tape): Buffer {
  return gzipSync(
    tapeRecords(tape)
      .map((r) => encodeTapeLine(r))
      .join(''),
  )
}

const gzipAsync = promisify(gzip)

/**
 * The runtime-path twin of {@link encodeTapeGzip} (fix round, M2): `gzipSync`
 * over a whole promoted window ran on the analytics event loop on every
 * promotion. This runs gzip on libuv's threadpool instead, off the event
 * loop, like `readTapeFile`'s gunzip already does.
 */
export async function encodeTapeGzipAsync(tape: Tape): Promise<Buffer> {
  return gzipAsync(
    tapeRecords(tape)
      .map((r) => encodeTapeLine(r))
      .join(''),
  )
}

const gunzipAsync = promisify(gunzip)

/** A read slower than this is worth an `info` line, not just `debug`. */
export const READ_TAPE_LOG_SLOW_MS = 500
/** A file bigger than this on disk is worth an `info` line, not just `debug`. */
export const READ_TAPE_LOG_LARGE_BYTES = 8 * 1024 * 1024

export interface ReadTapeFileDeps {
  readonly logger: IScopedLogger
  /** Tagged on the read's log line when the caller already knows it. */
  readonly deviceId?: number
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number
}

/** `info` only when the read is slow or the file is large — see the module comment. */
export function readTapeFileLogLevel(durationMs: number, rawBytes: number): 'debug' | 'info' {
  return durationMs > READ_TAPE_LOG_SLOW_MS || rawBytes > READ_TAPE_LOG_LARGE_BYTES
    ? 'info'
    : 'debug'
}

export async function readTapeFile(file: string, deps: ReadTapeFileDeps): Promise<Tape> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const raw = await readFile(file)
  const text = (await gunzipAsync(raw)).toString('utf8')
  const tape = await decodeTapeTextAsync(text)
  const durationMs = now() - startedAt
  const level = readTapeFileLogLevel(durationMs, raw.length)
  deps.logger[level]('tracking tape file read', {
    ...(deps.deviceId === undefined ? {} : { tags: { deviceId: deps.deviceId } }),
    meta: { file, rawBytes: raw.length, durationMs },
  })
  return tape
}

/**
 * The re-index pass, and the two things about it that only the real binary
 * could teach.
 */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'

import type { AmcrestCgiClient } from '../../amcrest-cgi-client.js'
import { ClipArtifactStore } from '../clip-artifact-store.js'
import {
  buildClipFaststartArgs,
  type ClipFileOutcome,
  parseFfmpegDurationMs,
  prepareClipFile,
} from '../clip-file.js'

/** A logger fake — the documented type boundary a test double needs. */
function makeSilentLogger(): IScopedLogger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  } as unknown as IScopedLogger
  return logger
}

describe('buildClipFaststartArgs', () => {
  const args = buildClipFaststartArgs('/tmp/in.raw', '/tmp/out.mp4.123.part')

  it('names the muxer, because the output has a `.part` extension', () => {
    // MEASURED against ffmpeg 7.1: without `-f mp4` it exits 234 with
    // `Invalid argument / Error opening output file` and writes nothing. A
    // test that only read the argument list back would never have seen it —
    // the live run did.
    const at = args.indexOf('-f')
    expect(at).toBeGreaterThan(-1)
    expect(args[at + 1]).toBe('mp4')
    expect(args.at(-1)).toBe('/tmp/out.mp4.123.part')
  })

  it('copies rather than re-encodes, and puts `moov` first', () => {
    expect(args).toContain('-c')
    expect(args[args.indexOf('-c') + 1]).toBe('copy')
    expect(args[args.indexOf('-movflags') + 1]).toBe('+faststart')
  })

  it('keeps ffmpeg talkative enough to report the duration it opened', () => {
    // `-loglevel info` is load-bearing: the `Duration:` line is the only
    // MEASUREMENT of how long the media really runs, and the catalog row
    // cannot stand in for it.
    expect(args[args.indexOf('-loglevel') + 1]).toBe('info')
  })
})

describe('parseFfmpegDurationMs', () => {
  it('reads the container duration off the real line shape', () => {
    expect(
      parseFfmpegDurationMs('  Duration: 00:01:08.43, start: 0.000000, bitrate: 6574 kb/s'),
    ).toBe(68_430)
    expect(parseFfmpegDurationMs('  Duration: 00:00:42.75, start: 0.000000')).toBe(42_750)
  })

  it('answers null rather than zero when ffmpeg said nothing', () => {
    // A container that reports no length has not reported one; zero says the
    // file is empty (D393).
    expect(parseFfmpegDurationMs('')).toBeNull()
    expect(parseFfmpegDurationMs('Duration: N/A, start: 0.000000')).toBeNull()
    expect(parseFfmpegDurationMs('  Duration: 00:00:00.00, start: 0')).toBeNull()
  })
})

/**
 * D617 — WHOSE failure a re-index is.
 *
 * The operator asked for a 106 MB clip, waited 151 s and got zero bytes, and
 * read it as "above ~100 MB it does not deliver at all". It is neither a size
 * limit nor a transfer fault. Measured on 3836, 2026-09-23, clip
 * `1790168287-1790168435` (105 971 106 bytes, 148 s): TWO independent pulls
 * each delivered the full declared length and each broke at the SAME offset —
 * 1 801 275, after `ftyp`, `free` and 68 `mdat` boxes — into a 33 733-byte run
 * of `0xFF` ending exactly on the 1 792 KiB erase-block boundary. `ffprobe`:
 * `moov atom not found`. An 88 900 431-byte clip from the same card pulled the
 * same way parses to its last box, and a bare `curl` from inside the hub
 * container pulled the 106 MB one in 94 s, complete to the declared byte.
 *
 * So the camera's own copy is damaged, the transfer did its job, and
 * `fetch-failed` sent the operator to look at a network that was fine.
 */
describe('a re-index that fails after a byte-exact fetch', () => {
  const RAW = Buffer.concat([Buffer.from('\x00\x00\x00\x20ftypisom'), Buffer.alloc(200, 0xff)])

  async function run(options: {
    readonly declareLength: boolean
    readonly exit: number
  }): Promise<ClipFileOutcome> {
    const dir = await mkdtemp(join(tmpdir(), 'amc-clip-'))
    const store = new ClipArtifactStore({ root: dir })
    const child = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter
      kill: () => void
    }
    child.stderr = new EventEmitter()
    child.kill = () => {}
    const outcome = prepareClipFile(
      {
        deviceId: 3836,
        row: {
          clipKey: '1790168287-1790168435',
          startMs: 1_790_168_287_000,
          endMs: 1_790_168_435_000,
          windowMs: 148_000,
          sizeBytes: RAW.byteLength,
          filePath: '/mnt/sd/2026-09-23/001/dav/14/14.58.07-15.00.35[M][0@0][0].mp4',
          events: ['VideoMotion'],
          flags: ['Event'],
          channel: 0,
        },
      },
      {
        resolveFfmpeg: async () => '/deps/ffmpeg-pinned',
        logger: makeSilentLogger(),
        store,
        client: {
          openRecordedFile: async () => ({
            status: 200,
            contentLength: options.declareLength ? RAW.byteLength : null,
            body: new Blob([RAW]).stream(),
          }),
        } as unknown as AmcrestCgiClient,
        spawnMux: () => {
          setTimeout(() => {
            child.stderr.emit('data', Buffer.from('moov atom not found'))
            child.emit('close', options.exit)
          }, 0)
          return child as unknown as ChildProcess
        },
      },
    )
    return await outcome
  }

  it('names the CAMERA, because every byte it declared arrived', async () => {
    const outcome = await run({ declareLength: true, exit: 183 })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.code).toBe('camera-refused')
    expect(outcome.detail).toMatch(/damaged/)
    expect(outcome.detail).toMatch(/re-fetching it will return the same bytes/)
  })

  it('stays `fetch-failed` when the camera declared no length to check against', async () => {
    // With no `content-length` a short body and a complete one are identical,
    // so the bytes could be ours and the camera must not be blamed.
    const outcome = await run({ declareLength: false, exit: 183 })
    expect(outcome.kind).toBe('refused')
    if (outcome.kind !== 'refused') return
    expect(outcome.code).toBe('fetch-failed')
  })
})

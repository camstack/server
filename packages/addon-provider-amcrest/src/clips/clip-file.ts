/**
 * One clip as a FINISHED file — the player's URL and the export's bytes.
 *
 * Two steps, both measured:
 *
 * 1. **`GET /cgi-bin/RPC_Loadfile<FilePath>`** — 200, a `content-length`
 *    byte-exact against the catalog row's `Length`, 2.87–3.5 MB/s, and a
 *    genuine self-contained ISO MP4 (`ftyp isom`, 2 581 `mdat`, one `moov`)
 *    carrying `h264` Main 2560x1440 beside `aac` LC 8000 Hz mono.
 * 2. **One `-c copy -movflags +faststart` pass**, because the `moov` the camera
 *    hands over is at offset 56 210 094 of 56 242 806 — the LAST 32 712 bytes
 *    — and a `<video>` element that has to show a duration should not have to
 *    discover that with a range dance. The pass is a copy, so it costs no
 *    re-encode, and it is also what MEASURES the duration (D393: the row's
 *    span is the wall clock and the media runs ~7.5 % shorter, so the row can
 *    never stand in for the measurement).
 *
 * ## Three refusals this path must name, and the camera names none of them
 *
 * - **A path that does not exist closes the socket with zero bytes and no HTTP
 *   status.** A real path answers 200 on the same endpoint, so the bare close
 *   specifically means "not found". It reaches us as a transport error and
 *   leaves as `camera-refused` — never as an empty file, and never as an
 *   absence (D611).
 * - **`Range` is ignored** — 200 with the whole body, no `content-range`, on
 *   every form measured. So there is no resumable read: a pull that failed
 *   half way starts again, and the bound is checked as the bytes arrive.
 * - **A 200 with no body** is a camera that accepted the work and produced
 *   nothing. That is the same branch as one that dropped it (D391) and it is
 *   named, not answered as an empty file.
 *
 * ## One fetch path, not two
 *
 * `getClipPlayback` and `offerClipBytes` both land here, so there is exactly
 * one place that pulls a recording, one bound and one remux — the second
 * authority D558 refuses to create. The file is cached in the per-device
 * scratch, so the player's URL and the export's bytes cost one fetch between
 * them.
 */
import type { ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { rm, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { resolvePinnedFfmpegSpawner } from '@camstack/types/node'

import type { AmcrestCgiClient } from '../amcrest-cgi-client.js'
import type { ClipArtifactStore } from './clip-artifact-store.js'
import type { AmcrestClipRow } from './clip-search.js'

/**
 * A ceiling on the raw bytes one fetch may accumulate.
 *
 * `VIDEOCLIPS_MAX_OFFER_BYTES` is 500 MiB and bounds what leaves over the byte
 * transport; this bounds what is PULLED, and it is a little above it so that
 * the transport's refusal is the one the operator reads. Every clip this
 * camera can structurally produce — one motion episode cut at the 5-minute
 * `PacketLength` cap, at the peak achieved 6.64 Mbit/s — is 238 MiB, so this
 * bites only on a firmware that stops obeying its own cap.
 */
export const CLIP_FILE_MAX_FETCH_BYTES = 512 * 1024 * 1024

/** How long one remux may run before it is killed. A `-c copy` pass over
 *  56 MB is seconds; a minute is a bound on a hang, not a budget. */
export const CLIP_FILE_REMUX_TIMEOUT_MS = 60_000

export type ClipFileFailure = 'camera-refused' | 'fetch-failed' | 'too-large-to-transfer'

export type ClipFileOutcome =
  | {
      readonly kind: 'ok'
      readonly path: string
      readonly bytes: number
      /** MEASURED off the container on this pass, or `null`. Never the row's
       *  window, which runs about 7.5 % long (D393). */
      readonly durationMs: number | null
    }
  | { readonly kind: 'refused'; readonly code: ClipFileFailure; readonly detail: string }

export interface PrepareClipFileInput {
  readonly deviceId: number
  readonly row: AmcrestClipRow
}

export interface ClipFileDeps {
  readonly logger: IScopedLogger
  readonly store: ClipArtifactStore
  readonly client: AmcrestCgiClient
  /** The node's pinned ffmpeg (D540), asked at the point of use so a later
   *  successful resolution is picked up. A rejection is a named refusal —
   *  never a PATH `ffmpeg`. */
  readonly resolveFfmpeg: PinnedFfmpegResolver
  readonly spawnMux?: (args: readonly string[]) => ChildProcess
  readonly maxFetchBytes?: number
}

/**
 * ffmpeg's own line for the container it opened —
 * `Duration: 00:01:08.43, start: …`. MEASURED, off the file we are about to
 * serve, which is the only thing that can say how long it really runs.
 */
export function parseFfmpegDurationMs(stderr: string): number | null {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2})\.(\d{1,3})/.exec(stderr)
  if (match === null) return null
  const [, h, m, s, frac] = match
  if (h === undefined || m === undefined || s === undefined || frac === undefined) return null
  const ms = Number(frac.padEnd(3, '0'))
  const total = ((Number(h) * 60 + Number(m)) * 60 + Number(s)) * 1000 + ms
  // Never zero: a container that reports no length has not reported one.
  return total > 0 ? total : null
}

/** The `-c copy -movflags +faststart` pass, spelled once. */
export function buildClipFaststartArgs(source: string, target: string): readonly string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'info',
    '-y',
    '-i',
    source,
    // A COPY. Re-encoding a recording we are only re-indexing can lose and
    // cannot gain, and it would turn a 2-second pass into a minute of CPU.
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    // The output is a `.part` file, and ffmpeg infers the muxer from the
    // EXTENSION. Without this it answers `Invalid argument` and opens nothing
    // — measured against the real binary, and invisible to a test that only
    // reads the argument list back.
    '-f',
    'mp4',
    target,
  ]
}

interface FetchOutcome {
  readonly kind: 'ok' | 'refused'
  readonly bytes: number
  /**
   * Whether the camera DECLARED a length and delivered exactly it.
   *
   * Load-bearing, and it is what lets a failed re-index be attributed. `false`
   * means the camera declared nothing, so a short body and a complete one look
   * identical and the bytes could be ours. `true` means the transfer is
   * accounted for to the byte and anything wrong with what arrived was wrong
   * on the card.
   */
  readonly lengthVerified?: boolean
  readonly code?: ClipFileFailure
  readonly detail?: string
}

async function fetchRecording(
  input: PrepareClipFileInput,
  deps: ClipFileDeps,
  target: string,
  maxFetchBytes: number,
): Promise<FetchOutcome> {
  let download: Awaited<ReturnType<AmcrestCgiClient['openRecordedFile']>>
  try {
    download = await deps.client.openRecordedFile(input.row.filePath)
  } catch (err: unknown) {
    // A path the camera does not hold closes the socket with zero bytes and
    // no status. NAMED, never folded into "this clip has no bytes".
    return {
      kind: 'refused',
      bytes: 0,
      code: 'camera-refused',
      detail:
        `the camera closed the connection for "${input.row.filePath}" without answering ` +
        `(${err instanceof Error ? err.message : String(err)}) — on this firmware that is how ` +
        'a recording it no longer holds is refused',
    }
  }
  if (download.status !== 200) {
    return {
      kind: 'refused',
      bytes: 0,
      code: 'camera-refused',
      detail: `the camera answered HTTP ${String(download.status)} for "${input.row.filePath}"`,
    }
  }
  if (download.contentLength !== null && download.contentLength > maxFetchBytes) {
    return {
      kind: 'refused',
      bytes: 0,
      code: 'too-large-to-transfer',
      detail:
        `the camera declares "${input.row.filePath}" as ${String(download.contentLength)} bytes, ` +
        `over the ${String(maxFetchBytes)}-byte fetch ceiling`,
    }
  }
  const body = download.body
  if (body === null) {
    // Accepted the work and produced nothing. The same branch as one that
    // dropped it (D391).
    return {
      kind: 'refused',
      bytes: 0,
      code: 'fetch-failed',
      detail: `the camera answered 200 for "${input.row.filePath}" and sent no body`,
    }
  }

  let bytes = 0
  let overflowed = false
  const source = Readable.fromWeb(body)
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.byteLength
    if (bytes > maxFetchBytes && !overflowed) {
      overflowed = true
      source.destroy(new Error(`fetch ceiling of ${String(maxFetchBytes)} bytes passed`))
    }
  })
  try {
    await pipeline(source, createWriteStream(target))
  } catch (err: unknown) {
    if (overflowed) {
      return {
        kind: 'refused',
        bytes,
        code: 'too-large-to-transfer',
        detail:
          `"${input.row.filePath}" passed the ${String(maxFetchBytes)}-byte fetch ceiling ` +
          'before the camera finished it',
      }
    }
    return {
      kind: 'refused',
      bytes,
      code: 'fetch-failed',
      detail:
        `the transfer of "${input.row.filePath}" ended after ${String(bytes)} bytes: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (bytes === 0) {
    return {
      kind: 'refused',
      bytes: 0,
      code: 'fetch-failed',
      detail: `the camera answered 200 for "${input.row.filePath}" and delivered no bytes`,
    }
  }
  if (download.contentLength !== null && bytes !== download.contentLength) {
    // Half a video is worse than an honest refusal. `Range` is ignored on this
    // endpoint, so there is nothing to resume — the next ask re-pulls.
    return {
      kind: 'refused',
      bytes,
      code: 'fetch-failed',
      detail:
        `the camera declared ${String(download.contentLength)} bytes for ` +
        `"${input.row.filePath}" and delivered ${String(bytes)}`,
    }
  }
  return { kind: 'ok', bytes, lengthVerified: download.contentLength !== null }
}

/**
 * Fetch a whole recording and re-index it, or answer the cached file.
 *
 * Never throws for a gated branch: a refusal carries its code and its prose so
 * the caller can turn it into the cap's own vocabulary.
 */
export async function prepareClipFile(
  input: PrepareClipFileInput,
  deps: ClipFileDeps,
): Promise<ClipFileOutcome> {
  const tags = { deviceId: input.deviceId }
  const meta = { clipKey: input.row.clipKey }
  const cached = await deps.store.pathIfPresent(input.deviceId, input.row.clipKey)
  if (cached !== null) {
    const info = await stat(cached)
    deps.logger.debug('videoclips: served a clip file from the scratch', {
      tags,
      meta: { ...meta, bytes: info.size },
    })
    // `null` because THIS pass measured nothing. The cached file's duration
    // was measured when it was made; re-asserting it from memory would be a
    // claim nothing on this pass checked.
    return { kind: 'ok', path: cached, bytes: info.size, durationMs: null }
  }

  // The cheap question before the fetch: without the pinned binary there is
  // no re-index, so nothing is downloaded for it.
  const mux = await resolvePinnedFfmpegSpawner(deps.spawnMux, deps.resolveFfmpeg, {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  if (mux.kind === 'refused') {
    deps.logger.error('videoclips: clip re-index refused — no pinned ffmpeg on this node (D540)', {
      tags,
      meta: { ...meta, detail: mux.detail },
    })
    return { kind: 'refused', code: 'fetch-failed', detail: mux.detail }
  }
  const spawnMux = mux.spawn

  const maxFetchBytes = deps.maxFetchBytes ?? CLIP_FILE_MAX_FETCH_BYTES
  const startedAt = Date.now()
  const raw = `${await deps.store.reserve(input.deviceId, input.row.clipKey)}.raw`
  const temp = await deps.store.reserve(input.deviceId, input.row.clipKey)
  try {
    const fetched = await fetchRecording(input, deps, raw, maxFetchBytes)
    if (fetched.kind === 'refused') {
      deps.logger.warn('videoclips: a clip fetch was refused', {
        tags,
        meta: { ...meta, branch: fetched.code ?? 'fetch-failed', bytes: fetched.bytes },
      })
      return {
        kind: 'refused',
        code: fetched.code ?? 'fetch-failed',
        detail: fetched.detail ?? 'the fetch failed',
      }
    }
    const fetchedAt = Date.now()

    const args = buildClipFaststartArgs(raw, temp)
    const child = spawnMux(args)
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000)
    })
    const killer = setTimeout(() => {
      child.kill('SIGKILL')
    }, CLIP_FILE_REMUX_TIMEOUT_MS)
    const exit = await new Promise<number | null>((resolve) => {
      child.on('close', (code) => {
        resolve(code)
      })
      child.on('error', () => {
        resolve(-1)
      })
    })
    clearTimeout(killer)
    if (exit !== 0) {
      // WHOSE failure this is, decided structurally rather than by reading
      // ffmpeg's English. The fetch has already proved the camera declared a
      // length and delivered exactly it, so nothing was lost in transit and
      // there is nothing to retry: what arrived is what the card holds, and
      // what the card holds is not a readable container.
      //
      // Measured on 3836, 2026-09-23, clip `1790168287-1790168435`
      // (105 971 106 bytes, 148 s): two independent pulls each delivered the
      // full declared length and each broke at the SAME offset — 1 801 275,
      // after `ftyp`, `free` and 68 `mdat` boxes — into a 33 733-byte run of
      // `0xFF` ending exactly on the 1 792 KiB erase-block boundary. An
      // 88 900 431-byte clip from the same card pulled the same way parses to
      // its last box. So this is one damaged recording, not a size limit, and
      // calling it `fetch-failed` sent the operator to look at a network that
      // did its job.
      const damaged = fetched.lengthVerified === true
      deps.logger.warn('videoclips: a clip re-index failed', {
        tags,
        meta: {
          ...meta,
          branch: damaged ? 'unreadable-container' : 'fetch-failed',
          exit,
          fetchedBytes: fetched.bytes,
          lengthVerified: fetched.lengthVerified === true,
          stderr: stderr.trim().slice(-300),
        },
      })
      return {
        kind: 'refused',
        code: damaged ? 'camera-refused' : 'fetch-failed',
        detail: damaged
          ? `the camera delivered all ${String(fetched.bytes)} bytes it declared for ` +
            `"${input.row.filePath}" and they are not a readable container — its own copy of ` +
            `this recording is damaged, and re-fetching it will return the same bytes ` +
            `(ffmpeg exited ${String(exit)}: ${stderr.trim().slice(-200)})`
          : `ffmpeg exited ${String(exit)}: ${stderr.trim().slice(-300)}`,
      }
    }

    const durationMs = parseFfmpegDurationMs(stderr)
    const path = await deps.store.publish(input.deviceId, input.row.clipKey, temp)
    const info = await stat(path)
    deps.logger.info('videoclips: prepared an Amcrest clip file', {
      tags,
      meta: {
        ...meta,
        fetchedBytes: fetched.bytes,
        listedBytes: input.row.sizeBytes,
        bytes: info.size,
        // MEASURED against the WINDOW the row declares, and reported rather
        // than folded: the container is expected to be the shorter of the two.
        durationMs,
        rowWindowMs: input.row.windowMs,
        fetchMs: fetchedAt - startedAt,
        remuxMs: Date.now() - fetchedAt,
      },
    })
    return { kind: 'ok', path, bytes: info.size, durationMs }
  } finally {
    await rm(raw, { force: true })
    await rm(temp, { force: true })
  }
}

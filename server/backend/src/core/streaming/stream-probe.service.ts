import { execFile } from 'child_process'

import { LoggingService } from '../logging/logging.service'
import { TtlCache } from './ttl-cache'
import type { StreamMetadata } from '@camstack/types'
import type { IScopedLogger, PinnedFfmpegResolver } from '@camstack/types'
import { errMsg } from '@camstack/types'
import {
  buildStreamProbeArgs,
  parseFfmpegStreamInfo,
  probeFoundAStream,
} from './ffmpeg-stream-info'

/** What the probe needs of the logging service — a named logger. */
export type ProbeLoggerSource = Pick<LoggingService, 'createLogger'>

const CACHE_TTL_MS = 3_600_000 // 1 hour
const PROBE_TIMEOUT_MS = 5_000
/**
 * Ceiling on cached probes.
 *
 * The cache is keyed by stream URL, and a URL is not a bounded quantity: every
 * credential rotation, every edited field, every per-camera probe of a value
 * that was later changed mints a new key. 512 is far above any real camera
 * roster (the live cluster runs 27), so a working deployment never evicts;
 * the ceiling exists so the key space cannot be walked into the OOM.
 */
const CACHE_MAX_ENTRIES = 512

/** A probe URL — and ffmpeg's echo of it — carries the camera's credentials;
 *  the log never does. */
function redactUrl(text: string): string {
  return text.replace(/\/\/[^@/\s]*@/g, '//***@')
}

export class StreamProbeService {
  private readonly logger: IScopedLogger
  /**
   * Probe results, bounded by BOTH a swept TTL and an entry ceiling.
   *
   * It used to be a plain `Map` whose age was consulted only when the same URL
   * was probed again — so an entry nobody asked about a second time was never
   * found expired and never removed. See {@link TtlCache}.
   */
  private readonly cache = new TtlCache<StreamMetadata>({
    ttlMs: CACHE_TTL_MS,
    maxEntries: CACHE_MAX_ENTRIES,
  })

  constructor(
    loggingService: ProbeLoggerSource,
    /** The node's pinned ffmpeg (D540). Rejects rather than naming PATH. */
    private readonly resolveFfmpeg: PinnedFfmpegResolver,
  ) {
    this.logger = loggingService.createLogger('StreamProbeService')
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Probe a stream URL and return its metadata (cached for 1 hour). */
  async probe(url: string, options?: { force?: boolean }): Promise<StreamMetadata> {
    const force = options?.force ?? false

    if (!force) {
      const cached = this.cache.get(url)
      if (cached) return cached
    }

    const metadata = await this.runProbe(url)
    // Only an ANSWER is cached. An empty result is a probe that failed (no
    // binary, a timeout, a refused dial), and caching it for an hour made one
    // bad moment the answer for an hour.
    if (probeFoundAStream(metadata)) this.cache.set(url, metadata)
    return metadata
  }

  /**
   * Generic field probe: given a field key and value, decides how to probe.
   * Stream fields (stream_*) → the pinned ffmpeg's input report, other URLs →
   * HTTP HEAD check.
   */
  async probeField(
    key: string,
    value: unknown,
  ): Promise<{ status: 'ok' | 'error'; labels?: string[]; error?: string }> {
    const url = String(value ?? '').trim()
    if (!url) {
      return { status: 'error', error: 'No URL provided' }
    }

    // Stream fields: ask the pinned ffmpeg what the input carries
    if (key.startsWith('stream')) {
      const meta = await this.probe(url, { force: true })
      const labels: string[] = []
      if (meta.width && meta.height) labels.push(`${meta.width}\u00d7${meta.height}`)
      if (meta.codec) {
        const codecDisplay: Record<string, string> = { h265: 'H.265', h264: 'H.264', hevc: 'H.265' }
        labels.push(codecDisplay[meta.codec] ?? meta.codec.toUpperCase())
      }
      if (meta.fps) labels.push(`${Math.round(meta.fps)}fps`)
      if (meta.audio?.codec) {
        const audioCodec = meta.audio.codec.toUpperCase()
        const audioBits: string[] = [audioCodec]
        if (meta.audio.sampleRate) audioBits.push(`${Math.round(meta.audio.sampleRate / 1000)}kHz`)
        if (meta.audio.channels === 1) audioBits.push('mono')
        else if (meta.audio.channels === 2) audioBits.push('stereo')
        else if (meta.audio.channels) audioBits.push(`${meta.audio.channels}ch`)
        labels.push(`audio: ${audioBits.join(' ')}`)
      }
      if (labels.length === 0) {
        return { status: 'error', error: 'No video streams found at URL' }
      }
      return { status: 'ok', labels }
    }

    // Other URL fields (snapshot, etc.): GET with early abort to check reachability + content-type
    try {
      const controller = new AbortController()
      const timeout = AbortSignal.timeout(5000)
      timeout.addEventListener('abort', () => controller.abort(timeout.reason))
      const response = await fetch(url, { method: 'GET', signal: controller.signal })
      if (!response.ok) {
        controller.abort()
        return { status: 'error', error: `HTTP ${response.status} ${response.statusText}` }
      }
      const contentType = response.headers.get('content-type') ?? ''
      controller.abort() // Don't download the full body
      const labels: string[] = ['Reachable']
      if (contentType.startsWith('image/')) {
        labels.push(contentType.replace('image/', '').toUpperCase())
      }
      return { status: 'ok', labels }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // We aborted intentionally after reading headers — that's success
        return { status: 'ok', labels: ['Reachable'] }
      }
      const msg = errMsg(err)
      return { status: 'error', error: `Unreachable: ${msg}` }
    }
  }

  /** Clear cached metadata for a single URL or all URLs. */
  clearCache(url?: string): void {
    if (url) {
      this.cache.delete(url)
    } else {
      this.cache.clear()
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async runProbe(url: string): Promise<StreamMetadata> {
    // The node's PINNED ffmpeg (D540). This was `ffprobe` spawned by name —
    // the host's binary, off PATH, which the pinned build does not even ship.
    let ffmpeg: string
    try {
      ffmpeg = await this.resolveFfmpeg()
    } catch (err) {
      this.logger.error('stream probe refused — no pinned ffmpeg on this node (D540)', {
        meta: { url: redactUrl(url), error: errMsg(err) },
      })
      return {}
    }
    // `-i` with no output: ffmpeg reports every input stream on stderr, then
    // exits non-zero for want of an output. That exit is the expected one, so
    // the report is read whatever the code; an empty report is the failure.
    const stderr = await new Promise<string>((resolve) => {
      execFile(
        ffmpeg,
        buildStreamProbeArgs(url),
        { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' },
        (_err, _stdout, errText) => resolve(errText),
      )
    })
    const metadata = parseFfmpegStreamInfo(stderr)
    if (!probeFoundAStream(metadata)) {
      this.logger.error('stream probe found no stream', {
        meta: { url: redactUrl(url), stderr: redactUrl(stderr.trim().slice(-500)) },
      })
    }
    return metadata
  }
}

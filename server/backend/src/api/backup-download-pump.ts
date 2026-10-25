/**
 * backup-download-pump — a backup archive is streamed at the pace the client
 * READS it, and a client that stops reading is cut, never buffered until
 * hub-main dies.
 *
 * ## What happened
 *
 * `/api/backup/download/:locationId/:archiveId` read an archive from the
 * storage cap in 8 MiB chunks and called `reply.raw.write(chunk)` in a loop
 * that never looked at the return value and never waited for `drain`. A Node
 * writable accepts every write; what the socket cannot send it QUEUES, in
 * hub-main's heap, until the peer reads it. On a fast disk the whole archive
 * is read in seconds, so for a client on a slow link — a phone over the
 * Cloudflare tunnel, a browser tab in the background — the queue is the
 * archive: 464 MB across 9 169 files on this hub, per download, per client,
 * released only when the socket closes. And not one line said so.
 *
 * ## The policy, and why this one
 *
 * It is the WebSocket guard's (`ws-slow-consumer-guard.ts`, D444) and the
 * restreamer's (`rtsp-session.ts`): backpressure measures LIVENESS, not
 * identity. Nobody is cut for being momentarily behind — a client draining an
 * 8 MiB chunk over a 2 Mbit link takes half a minute per chunk and is coming
 * back — and a client that cannot take a single socket buffer in
 * {@link BACKUP_DOWNLOAD_DRAIN_GRACE_MS} is not behind, it is gone.
 *
 * The form differs from the subscription guard in one way that matters: the
 * respect for `drain` does the bounding on its own. A download is a long,
 * legitimate flow, not a subscription, so the loop simply does not READ the
 * next chunk until the socket has taken the previous one — the most the
 * response can hold is one chunk plus the socket buffer, whatever the client's
 * speed. The grace exists only for the peer that stops reading altogether:
 * a half-open TCP connection can sit in that state for the kernel's whole
 * retransmit budget (minutes), holding the chunk, the storage cap's download
 * handle and the request, and `drain` never comes.
 *
 * ## What is said
 *
 * `pumpDownload` returns what happened in numbers — bytes, waits, the longest
 * wait, how long a cut client was held — and the route turns that into ONE
 * line per download: `info` for a completed or client-abandoned transfer,
 * `warn` for a cut client or a failed source. The route previously logged
 * nothing on success and `console.error` on failure.
 */

/** Bytes read from the storage cap per round trip; one chunk is the most the response holds. */
export const BACKUP_DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/**
 * How long a `write` may stay unacknowledged by `drain` before the client is
 * cut. A `ServerResponse` signals `drain` once the socket has taken its
 * buffer (16 KiB by default): a client that cannot take 16 KiB in a minute is
 * under 0.3 KB/s — not a slow link, an absent reader.
 */
export const BACKUP_DOWNLOAD_DRAIN_GRACE_MS = 60_000

/** The minimum of `http.ServerResponse` the pump writes to. Structural so it is testable without a socket. */
export interface DownloadSink {
  readonly destroyed: boolean
  /** Bytes queued in the writable, unsent. What a cut client was holding. */
  readonly writableLength: number
  write(chunk: Uint8Array): boolean
  end(): void
  destroy(error?: Error): void
  on(event: 'drain' | 'close', listener: () => void): unknown
  off(event: 'drain' | 'close', listener: () => void): unknown
}

/** One chunked read off the storage cap: `readChunk({ downloadId, offset, length })`. */
export type ChunkReader = (offset: number, length: number) => Promise<Uint8Array>

export interface PumpDownloadOptions {
  readonly sizeBytes: number
  readonly read: ChunkReader
  readonly sink: DownloadSink
  readonly chunkBytes?: number
  readonly graceMs?: number
  /** Injected by the spec; production reads the wall clock. */
  readonly now?: () => number
}

interface PumpCounters {
  readonly bytesWritten: number
  /** How many writes the socket could not take at once. */
  readonly drainWaits: number
  /** The longest the loop waited for one `drain`. */
  readonly drainWaitMaxMs: number
  readonly durationMs: number
}

export type PumpResult =
  | (PumpCounters & { readonly status: 'completed' })
  /** The peer closed the connection mid-transfer. Nothing more was read. */
  | (PumpCounters & { readonly status: 'peer-gone' })
  /** The peer stopped reading; the response was destroyed after the grace. */
  | (PumpCounters & {
      readonly status: 'drain-timeout'
      readonly heldForMs: number
      readonly queuedBytes: number
    })
  /** The storage cap failed or returned an empty chunk; the response was destroyed with the error. */
  | (PumpCounters & { readonly status: 'source-failed'; readonly error: string })

type DrainOutcome = 'drained' | 'closed' | 'timeout'

function waitForDrain(sink: DownloadSink, graceMs: number): Promise<DrainOutcome> {
  return new Promise<DrainOutcome>((resolve) => {
    const settle = (outcome: DrainOutcome): void => {
      sink.off('drain', onDrain)
      sink.off('close', onClose)
      clearTimeout(timer)
      resolve(outcome)
    }
    const onDrain = (): void => settle('drained')
    const onClose = (): void => settle('closed')
    const timer = setTimeout(() => settle('timeout'), graceMs)
    sink.on('drain', onDrain)
    sink.on('close', onClose)
  })
}

function errorOf(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/**
 * Stream `sizeBytes` from `read` into `sink`, one chunk at a time, reading the
 * next only once the socket has taken the previous. Never throws: every exit
 * is a {@link PumpResult} the caller can log.
 */
export async function pumpDownload(options: PumpDownloadOptions): Promise<PumpResult> {
  const { sizeBytes, read, sink } = options
  const chunkBytes = options.chunkBytes ?? BACKUP_DOWNLOAD_CHUNK_BYTES
  const graceMs = options.graceMs ?? BACKUP_DOWNLOAD_DRAIN_GRACE_MS
  const now = options.now ?? ((): number => Date.now())

  const startedAt = now()
  let offset = 0
  let drainWaits = 0
  let drainWaitMaxMs = 0
  const counters = (): PumpCounters => ({
    bytesWritten: offset,
    drainWaits,
    drainWaitMaxMs,
    durationMs: now() - startedAt,
  })

  while (offset < sizeBytes) {
    if (sink.destroyed) return { status: 'peer-gone', ...counters() }
    const length = Math.min(chunkBytes, sizeBytes - offset)
    let chunk: Uint8Array
    try {
      chunk = await read(offset, length)
    } catch (err: unknown) {
      const error = errorOf(err)
      sink.destroy(error)
      return { status: 'source-failed', error: error.message, ...counters() }
    }
    if (chunk.byteLength === 0) {
      // A short read before the end is a truncated archive, never "done":
      // `end()` here would hand the client a file that fails to extract.
      const error = new Error(`backup download: empty chunk at offset ${offset}/${sizeBytes}`)
      sink.destroy(error)
      return { status: 'source-failed', error: error.message, ...counters() }
    }
    // The peer may have gone while the storage cap was answering.
    if (sink.destroyed) return { status: 'peer-gone', ...counters() }

    const accepted = sink.write(chunk)
    offset += chunk.byteLength
    if (accepted) continue

    const waitStartedAt = now()
    const outcome = await waitForDrain(sink, graceMs)
    const waitedMs = now() - waitStartedAt
    drainWaits += 1
    if (waitedMs > drainWaitMaxMs) drainWaitMaxMs = waitedMs
    if (outcome === 'closed') return { status: 'peer-gone', ...counters() }
    if (outcome === 'timeout') {
      const queuedBytes = sink.writableLength
      sink.destroy(
        new Error(
          `backup download: client stopped reading — ${queuedBytes} bytes queued for ${waitedMs} ms`,
        ),
      )
      return { status: 'drain-timeout', heldForMs: waitedMs, queuedBytes, ...counters() }
    }
  }
  sink.end()
  return { status: 'completed', ...counters() }
}

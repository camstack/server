/**
 * The body behind `pipelineAnalytics.offerRetrainArchive`: the annotated
 * archive written into the HTTP response of a `ctx.peerBytes` ticket (D613).
 *
 * A training provider cannot expose an upload URL pipeline-analytics could
 * push to, so the archive is OFFERED instead: the provider dials the ticket
 * and streams the body straight into its cloud. The disciplines are D447's —
 * write() resolves only when the socket took the chunk, a peer that stops
 * reading fails the writer after a stall, and a peer that goes away fails it
 * at once — so a slow home uplink never buffers the dataset in memory.
 */
import type { IncomingMessage } from 'node:http'
import type { PeerBytesHandlerResponse } from '@camstack/types'
import type { RetrainArchiveSink } from './retrain-archive-writer.js'

/** A reader silent this long is gone; the body is cut. */
const RETRAIN_OFFER_STALL_MS = 60_000

export function responseArchiveSink(
  res: PeerBytesHandlerResponse,
  stallMs: number = RETRAIN_OFFER_STALL_MS,
): RetrainArchiveSink {
  let closed = false
  res.once('close', () => {
    closed = true
  })
  return {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        if (closed || res.destroyed) {
          reject(new Error('retrain archive reader went away'))
          return
        }
        if (res.write(chunk)) {
          resolve()
          return
        }
        const onDrain = (): void => {
          cleanup()
          resolve()
        }
        const onClose = (): void => {
          cleanup()
          reject(new Error('retrain archive reader went away'))
        }
        const timer = setTimeout(() => {
          cleanup()
          res.destroy(new Error('retrain archive reader stalled'))
          reject(new Error(`retrain archive reader stalled for ${stallMs} ms`))
        }, stallMs)
        const cleanup = (): void => {
          clearTimeout(timer)
          res.off('drain', onDrain)
          res.off('close', onClose)
        }
        res.once('drain', onDrain)
        res.once('close', onClose)
      }),
  }
}

/**
 * Serve one archive: headers, the writer's chunks, the end. A writer that
 * throws destroys the response (the reader sees a truncated body, never a
 * clean end) and the error propagates to the caller's log.
 */
export async function serveRetrainArchive(
  _req: IncomingMessage,
  res: PeerBytesHandlerResponse,
  writeArchive: (sink: RetrainArchiveSink) => Promise<void>,
): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-tar' })
  try {
    await writeArchive(responseArchiveSink(res))
    await new Promise<void>((resolve) => res.end(resolve))
  } catch (err: unknown) {
    res.destroy(err instanceof Error ? err : new Error(String(err)))
    throw err
  }
}

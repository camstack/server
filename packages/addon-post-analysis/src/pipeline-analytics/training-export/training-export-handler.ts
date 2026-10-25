/**
 * Training-export data-plane handler — streams the dataset tar over the addon
 * HTTP data plane.
 *
 * Public URL (via the hub reverse-proxy):
 *   /addon/<addonId>/training-export?deviceIds=101,102
 *
 * It is a data-plane route and not a tRPC method because the cap channel is
 * unary and must not carry bytes: a multi-gigabyte archive base64'd through an
 * RPC envelope would be held whole in memory twice, on a hub this repo has
 * already OOM'd once. Here the handler owns the real `ServerResponse`, so
 * backpressure and client-disconnect are Node's problem, not ours.
 *
 * Admin-only (level declared in `../data-plane-access.ts`). Marking a track is a viewer-level act (D81) because it is
 * curation; walking off with every stored frame the fleet has kept is not. The
 * export is a bulk read of the entire media corpus for the marked set, and that
 * is the same authority `deleteTracks` and `getEventStoreFootprint` sit behind.
 *
 * Deliberately NO `Accept-Ranges`. The archive is generated on the fly and has
 * no seekable backing file — advertising ranges would invite a client to issue
 * a range request the server would have to satisfy by regenerating and
 * discarding a prefix, and a resumed download would silently receive a
 * DIFFERENT archive if a mark changed in between.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler, IScopedLogger } from '@camstack/types'
import type { TrainingExportPlan } from './dataset-plan.js'
import { streamDataset, type ArchiveSink, type BlobReader } from './training-export-stream.js'

export const TRAINING_EXPORT_PREFIX = 'training-export'

export interface TrainingExportHandlerDeps {
  /** Build the plan for a selection — index reads only. */
  readonly buildPlan: (deviceIds: readonly number[]) => Promise<TrainingExportPlan>
  readonly readBlob: BlobReader
  readonly logger: IScopedLogger
  readonly now: () => number
}

/**
 * Parse `?deviceIds=101,102` into a device list. An absent or unparseable value
 * yields `[]`, which the caller reads as "every device with marked tracks" —
 * stated here rather than left to the reader because the empty array is doing
 * two jobs and only one of them is obvious.
 */
export function parseDeviceIds(url: string): readonly number[] {
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  const raw = new URLSearchParams(query).get('deviceIds')
  if (raw === null || raw.trim() === '') return []
  const out: number[] = []
  for (const part of raw.split(',')) {
    const n = Number.parseInt(part.trim(), 10)
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** Archive filename. Sanitised the same way the backup download is — a header
 *  value carrying a CR or a quote is a response-splitting bug, not a filename. */
export function archiveFilename(nowMs: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-')
  return `camstack-training-${stamp}.tar`.replace(/[\r\n"]/g, '')
}

/** Adapt a `ServerResponse` to the sink, honouring backpressure. */
function responseSink(res: ServerResponse): ArchiveSink {
  return {
    write: (chunk) =>
      new Promise<void>((resolve, reject) => {
        // `write` returning false means the kernel buffer is full. Waiting for
        // 'drain' is what keeps peak memory at one JPEG instead of the whole
        // archive queued inside Node.
        const ok = res.write(chunk, (err) => {
          if (err) reject(err)
          else if (ok) resolve()
        })
        if (!ok) res.once('drain', resolve)
      }),
    end: () =>
      new Promise<void>((resolve) => {
        res.end(resolve)
      }),
  }
}

export function createTrainingExportHandler(deps: TrainingExportHandlerDeps): DataPlaneHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    const deviceIds = parseDeviceIds(req.url ?? '')
    let plan: TrainingExportPlan
    try {
      plan = await deps.buildPlan(deviceIds)
    } catch (err) {
      deps.logger.warn('training export plan failed', { meta: { error: String(err) } })
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('training export plan failed')
      return
    }

    res.writeHead(200, {
      'content-type': 'application/x-tar',
      'content-disposition': `attachment; filename="${archiveFilename(deps.now())}"`,
      'cache-control': 'no-store',
      // The archive reflects the marks at the moment of the request; a proxy
      // that reused it would hand back a stale dataset.
      'x-camstack-export-tracks': String(plan.trackCount),
      'x-camstack-export-files': String(plan.fileCount),
    })

    if (method === 'HEAD') {
      // The cheap question over HTTP: a client can learn the shape of the
      // export from the headers without moving a byte of it.
      res.end()
      return
    }

    let clientGone = false
    res.once('close', () => {
      clientGone = res.writableEnded === false
    })

    try {
      await streamDataset({
        plan,
        sink: responseSink(res),
        readBlob: deps.readBlob,
        logger: deps.logger,
        now: deps.now,
        pace: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        aborted: () => clientGone,
      })
    } catch (err) {
      // Headers are already flushed, so there is no status left to send — the
      // only honest signal is a destroyed connection, which makes the partial
      // tar unreadable rather than passing it off as complete.
      deps.logger.warn('training export stream failed mid-archive', {
        meta: { error: String(err), tracks: plan.trackCount },
      })
      res.destroy()
    }
  }
}

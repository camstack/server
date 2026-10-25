/**
 * The HTTP sink behind `pipelineAnalytics.writeRetrainArchive`: ONE request
 * whose body is the archive, written chunk by chunk with backpressure honoured
 * (D447) — the archive is never assembled in memory or on disk.
 *
 * The target is admin-supplied (the training orchestrator hands over a
 * provider's presigned URL or its upload route). Its headers may carry a
 * credential, so they are sent and never logged.
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { RetrainArchiveTarget } from '@camstack/types'
import type { RetrainArchiveSink } from './retrain-archive-writer.js'

export interface RetrainUpload {
  readonly sink: RetrainArchiveSink
  /** End the body and wait for the answer. Rejects on a non-2xx status. */
  readonly finish: () => Promise<number>
  /** Tear the request down (the archive failed half way). */
  readonly abort: (reason: string) => void
}

export function openRetrainUploadSink(target: RetrainArchiveTarget): RetrainUpload {
  const url = new URL(target.url)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const req: ClientRequest = send(url, {
    method: target.method,
    headers: { 'content-type': 'application/x-tar', ...target.headers },
  })
  let failure: Error | null = null
  const answer = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', resolve)
    req.on('error', (err) => {
      failure = err
      reject(err)
    })
  })
  // Keep an unhandled rejection from escaping before `finish` awaits it.
  answer.catch(() => undefined)
  return {
    sink: {
      write: (chunk) =>
        new Promise<void>((resolve, reject) => {
          if (failure !== null) {
            reject(failure)
            return
          }
          const ok = req.write(chunk, (err) => {
            if (err) reject(err)
          })
          if (ok) resolve()
          else req.once('drain', resolve)
        }),
    },
    finish: async () => {
      req.end()
      const res = await answer
      res.resume()
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        throw new Error(`retrain upload refused by the target: HTTP ${status}`)
      }
      return status
    },
    abort: (reason) => {
      req.destroy(new Error(reason))
    },
  }
}

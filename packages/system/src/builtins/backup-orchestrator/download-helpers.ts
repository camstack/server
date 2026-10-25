/**
 * Chunked-download helper for the backup orchestrator (Task 12 of
 * the storage-unification refactor).
 *
 * Streams an archive from a destination `StorageLocation` into a
 * local filesystem path via the consumer-facing `storage` cap. Pulled
 * out of `backup-orchestrator.addon.ts` so it can be unit-tested with
 * an in-memory fake `AddonApi['storage']` slice — the addon is hard
 * to bootstrap in vitest because of the BaseAddon ceremony.
 *
 * Cleanup contract:
 *  - Successful run leaves the cache file in place + calls
 *    `endDownload`.
 *  - Mid-stream failure destroys the writeStream, removes the
 *    partial cache file, and best-effort calls `endDownload` so the
 *    storage provider's session bookkeeping doesn't leak.
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import type { IScopedLogger } from '@camstack/types'
import type { ChunkedDownloadApi } from './manifest-store.js'

export interface DownloadArchiveInput {
  readonly api: ChunkedDownloadApi
  readonly locationId: string
  readonly filename: string
  readonly cachePath: string
  /** Per-chunk byte budget. Matches the upload helper's 8 MiB. */
  readonly chunkBytes: number
  readonly logger: IScopedLogger
}

export async function downloadArchiveToCache(input: DownloadArchiveInput): Promise<void> {
  const { downloadId, sizeBytes } = await input.api.beginDownload.mutate({
    location: input.locationId,
    relativePath: input.filename,
  })
  const writeStream = fs.createWriteStream(input.cachePath)
  let offset = 0
  try {
    while (offset < sizeBytes) {
      const remaining = sizeBytes - offset
      const length = Math.min(input.chunkBytes, remaining)
      const chunk = await input.api.readChunk.query({
        downloadId,
        offset,
        length,
      })
      if (chunk.byteLength === 0) {
        // Remote reported `sizeBytes` but stopped delivering — treat
        // as a truncated source rather than spinning forever.
        throw new Error(
          `backup restore: empty chunk at offset ${offset}/${sizeBytes} from "${input.locationId}/${input.filename}"`,
        )
      }
      writeStream.write(chunk)
      offset += chunk.byteLength
    }
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null | undefined) => {
        if (err) reject(err)
        else resolve()
      })
    })
    try {
      await input.api.endDownload.mutate({ downloadId })
    } catch (err) {
      // endDownload is bookkeeping; tolerate failure so an already-
      // finished download still produces a usable cache file.
      input.logger.warn('backup restore: endDownload failed (ignoring)', {
        meta: { downloadId, error: err instanceof Error ? err.message : String(err) },
      })
    }
  } catch (err) {
    // Wait for the writeStream to fully close BEFORE deleting the
    // partial cache file — otherwise pending OS-level buffered writes
    // can race the rm and re-create the file. We swallow the
    // close-side error (the throw below carries the meaningful one).
    await new Promise<void>((resolve) => {
      writeStream.once('close', () => resolve())
      writeStream.destroy()
    })
    try {
      await fsp.rm(input.cachePath, { force: true })
    } catch {
      /* best-effort */
    }
    try {
      await input.api.endDownload.mutate({ downloadId })
    } catch {
      /* ignore */
    }
    throw err
  }
}

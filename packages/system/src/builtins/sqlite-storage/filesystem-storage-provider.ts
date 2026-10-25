/**
 * Filesystem `storage-provider` (Task 7).
 *
 * Implements the `storage-provider` collection cap. Replaces the legacy
 * sync `IStorageProvider` shape — every method now takes the live
 * `StorageLocation` inline (no per-provider location state) and works
 * off `location.config.basePath`.
 *
 * Adds chunked upload (`.partial` rename trick) + chunked download
 * sessions for moving multi-GB archives without buffering the whole
 * archive in memory. Sessions auto-expire after 5 minutes idle.
 *
 * The legacy `FilesystemStorageProvider` in `@camstack/types/node` is
 * deliberately untouched — it still backs the sync `ctx.kernel.storage`
 * helper that addons like `pipeline-analytics` use to derive paths
 * synchronously. That sync API will be retired in a later refactor;
 * Task 7 is scoped to the cap surface only.
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  IStorageProviderImpl,
  StorageLocation,
  StorageProviderInfoSchema,
} from '@camstack/types'
import type { z } from 'zod'

type StorageProviderInfo = z.infer<typeof StorageProviderInfoSchema>

/** Idle TTL for upload + download sessions. */
const SESSION_IDLE_TTL_MS = 5 * 60 * 1000

interface UploadSession {
  readonly stream: fs.WriteStream
  readonly target: string
  readonly partial: string
  bytesWritten: number
  timer: NodeJS.Timeout
}

interface DownloadSession {
  readonly fd: FileHandle
  readonly sizeBytes: number
  timer: NodeJS.Timeout
}

/**
 * Resolve `location.config.basePath` into a string. Throws an actionable
 * error when the field is missing or wrong-typed — every primitive
 * funnels through here, so a missing field surfaces as a single clear
 * message instead of a downstream `path.join` TypeError.
 */
function getBasePath(location: StorageLocation): string {
  const cfg = location.config as Record<string, unknown>
  const basePath = cfg['basePath']
  if (typeof basePath !== 'string' || basePath.length === 0) {
    throw new Error(`filesystem-storage: location "${location.id}" missing string config.basePath`)
  }
  return basePath
}

/**
 * Resolve a relative path against the location's base, rejecting any
 * traversal that escapes the base directory. Mirrors the
 * `addon-asset` endpoint security check in `main.ts`: normalize both
 * the base + the joined target, then enforce `target.startsWith(base + sep)`
 * (with the `+ sep` guard so `/data` doesn't accidentally allow
 * `/datasecret`).
 */
function safeResolve(base: string, relativePath: string): string {
  const normalizedBase = path.resolve(base)
  const target = path.resolve(normalizedBase, relativePath)
  if (target !== normalizedBase && !target.startsWith(normalizedBase + path.sep)) {
    throw new Error(
      `filesystem-storage: relativePath "${relativePath}" escapes basePath "${normalizedBase}"`,
    )
  }
  return target
}

export class FilesystemStorageProvider implements IStorageProviderImpl {
  static readonly providerId = 'filesystem-storage'
  static readonly displayName = 'Filesystem'

  private readonly uploads = new Map<string, UploadSession>()
  private readonly downloads = new Map<string, DownloadSession>()

  // ── Self-description ────────────────────────────────────────────────

  async getProviderInfo(): Promise<StorageProviderInfo> {
    return {
      providerId: FilesystemStorageProvider.providerId,
      displayName: FilesystemStorageProvider.displayName,
      // Local filesystem has a finite volume → it participates in disk-space
      // management; 10% free is the default eviction threshold (operators can
      // override per-location via `config.minFreePercent`).
      shouldSaveDiskSpace: true,
      minFreePercent: 10,
      // Filesystem is node-local: each location binds to one node's disk.
      nodeLocal: true,
      // Minimal schema — the only required field is `basePath`. Casted
      // through `unknown` because the cap surface declares
      // `configSchema: z.unknown()` (the admin UI casts back at the
      // consumption site to `ConfigUISchemaWithValues`).
      configSchema: {
        sections: [
          {
            id: 'filesystem-storage',
            title: 'Filesystem',
            titleKey: 'server:providerInfo.s_filesystem-storage.title',
            fields: [
              {
                type: 'text',
                key: 'basePath',
                label: 'Base path',
                labelKey: 'server:providerInfo.s_filesystem-storage.basePath.label',
                description: 'Absolute directory path where files are stored.',
                descriptionKey: 'server:providerInfo.s_filesystem-storage.basePath.description',
                required: true,
              },
            ],
          },
        ],
      },
    }
  }

  async testLocation({ config }: { readonly config: Record<string, unknown> }): Promise<{
    readonly ok: boolean
    readonly error?: string
  }> {
    const basePath = config['basePath']
    if (typeof basePath !== 'string' || basePath.length === 0) {
      return { ok: false, error: 'config.basePath must be a non-empty string' }
    }
    try {
      const stat = await fs.promises.stat(basePath).catch(() => null)
      if (stat) {
        if (!stat.isDirectory()) {
          return { ok: false, error: `Path "${basePath}" exists but is not a directory` }
        }
        // Confirm we can write to it.
        await fs.promises.access(basePath, fs.constants.W_OK)
        return { ok: true }
      }
      // Doesn't exist — try to create it.
      await fs.promises.mkdir(basePath, { recursive: true })
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  // ── Small-file primitives ───────────────────────────────────────────

  async resolve({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<string> {
    return safeResolve(getBasePath(location), relativePath)
  }

  async write({
    location,
    relativePath,
    data,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
    readonly data: Uint8Array
  }): Promise<void> {
    const filePath = safeResolve(getBasePath(location), relativePath)
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, data)
  }

  async read({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<Uint8Array<ArrayBuffer>> {
    const filePath = safeResolve(getBasePath(location), relativePath)
    const buf = await fs.promises.readFile(filePath)
    // The cap surface narrows `Uint8Array` to `Uint8Array<ArrayBuffer>`
    // (Node's `Buffer` types as `Uint8Array<ArrayBufferLike>` which can
    // also wrap a `SharedArrayBuffer`). Copy through a fresh
    // `ArrayBuffer` so the structural narrowing succeeds. The copy is
    // cheap relative to the disk read; for chunked transfers callers
    // should use `beginDownload`/`readChunk` which already allocates
    // its own ArrayBuffer-backed Buffer.
    const out = new Uint8Array(new ArrayBuffer(buf.byteLength))
    out.set(buf)
    return out
  }

  async exists({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<boolean> {
    const filePath = safeResolve(getBasePath(location), relativePath)
    try {
      await fs.promises.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async list({
    location,
    prefix,
  }: {
    readonly location: StorageLocation
    readonly prefix?: string
  }): Promise<readonly string[]> {
    const base = getBasePath(location)
    const dir = prefix ? safeResolve(base, prefix) : path.resolve(base)
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      // Return RELATIVE-to-location filenames so consumers can pass
      // them straight back to `read({ location, relativePath })`.
      return entries.map((e) => (prefix ? `${prefix}/${e.name}` : e.name))
    } catch {
      return []
    }
  }

  async delete({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<void> {
    const filePath = safeResolve(getBasePath(location), relativePath)
    await fs.promises.rm(filePath, { force: true })
  }

  async getAvailableSpace({
    location,
  }: {
    readonly location: StorageLocation
  }): Promise<number | null> {
    const base = path.resolve(getBasePath(location))
    // Walk up to the nearest existing ancestor when the directory
    // hasn't been created yet (lazy-mkdir contract from the legacy
    // provider) so statfs can still report mount-point free space.
    try {
      let target = base
      while (!fs.existsSync(target)) {
        const parent = path.dirname(target)
        if (!parent || parent === target) return null
        target = parent
      }
      const stats = await fs.promises.statfs(target)
      return stats.bavail * stats.bsize
    } catch {
      return null
    }
  }

  // ── Chunked upload ──────────────────────────────────────────────────

  async beginUpload({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
    readonly sizeBytes?: number
  }): Promise<{ readonly uploadId: string }> {
    const target = safeResolve(getBasePath(location), relativePath)
    const partial = `${target}.partial`
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    // Wipe a stale `.partial` from a previous aborted run so the
    // append-zero offset stays correct.
    await fs.promises.unlink(partial).catch(() => {})
    const stream = fs.createWriteStream(partial)
    const uploadId = randomUUID()
    const session: UploadSession = {
      stream,
      target,
      partial,
      bytesWritten: 0,
      timer: setTimeout(() => {
        void this.abortUpload({ uploadId }).catch(() => {})
      }, SESSION_IDLE_TTL_MS),
    }
    this.uploads.set(uploadId, session)
    return { uploadId }
  }

  async writeChunk({
    uploadId,
    offset,
    data,
  }: {
    readonly uploadId: string
    readonly offset: number
    readonly data: Uint8Array
  }): Promise<void> {
    const session = this.uploads.get(uploadId)
    if (!session) {
      throw new Error(`filesystem-storage: upload session "${uploadId}" not found`)
    }
    if (offset !== session.bytesWritten) {
      throw new Error(
        `filesystem-storage: chunk offset mismatch (expected ${session.bytesWritten}, got ${offset})`,
      )
    }
    await new Promise<void>((resolve, reject) => {
      session.stream.write(data, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    // Replace session with updated bytesWritten + reset timer (immutable
    // update; old timer cleared).
    clearTimeout(session.timer)
    const nextBytesWritten = session.bytesWritten + data.length
    this.uploads.set(uploadId, {
      ...session,
      bytesWritten: nextBytesWritten,
      timer: setTimeout(() => {
        void this.abortUpload({ uploadId }).catch(() => {})
      }, SESSION_IDLE_TTL_MS),
    })
  }

  async finalizeUpload({ uploadId }: { readonly uploadId: string }): Promise<void> {
    const session = this.uploads.get(uploadId)
    if (!session) {
      throw new Error(`filesystem-storage: upload session "${uploadId}" not found`)
    }
    await new Promise<void>((resolve, reject) => {
      session.stream.end(() => resolve())
      session.stream.on('error', reject)
    })
    await fs.promises.rename(session.partial, session.target)
    clearTimeout(session.timer)
    this.uploads.delete(uploadId)
  }

  async abortUpload({ uploadId }: { readonly uploadId: string }): Promise<void> {
    const session = this.uploads.get(uploadId)
    if (!session) return // Already cleaned up — idempotent.
    try {
      session.stream.destroy()
    } catch {
      // Best-effort.
    }
    await fs.promises.unlink(session.partial).catch(() => {})
    clearTimeout(session.timer)
    this.uploads.delete(uploadId)
  }

  // ── Chunked download ────────────────────────────────────────────────

  async beginDownload({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<{ readonly downloadId: string; readonly sizeBytes: number }> {
    const target = safeResolve(getBasePath(location), relativePath)
    const stat = await fs.promises.stat(target)
    const fd = await fs.promises.open(target, 'r')
    const downloadId = randomUUID()
    const session: DownloadSession = {
      fd,
      sizeBytes: stat.size,
      timer: setTimeout(() => {
        void this.endDownload({ downloadId }).catch(() => {})
      }, SESSION_IDLE_TTL_MS),
    }
    this.downloads.set(downloadId, session)
    return { downloadId, sizeBytes: stat.size }
  }

  async readChunk({
    downloadId,
    offset,
    length,
  }: {
    readonly downloadId: string
    readonly offset: number
    readonly length: number
  }): Promise<Uint8Array<ArrayBuffer>> {
    const session = this.downloads.get(downloadId)
    if (!session) {
      throw new Error(`filesystem-storage: download session "${downloadId}" not found`)
    }
    // Allocate over an explicit `ArrayBuffer` so the narrowing required
    // by the cap surface (`Uint8Array<ArrayBuffer>`) succeeds — `Buffer`
    // types as `Uint8Array<ArrayBufferLike>` which TS won't widen
    // through the structural check.
    const out = new Uint8Array(new ArrayBuffer(length))
    const { bytesRead } = await session.fd.read(out, 0, length, offset)
    // Reset TTL on activity.
    clearTimeout(session.timer)
    this.downloads.set(downloadId, {
      ...session,
      timer: setTimeout(() => {
        void this.endDownload({ downloadId }).catch(() => {})
      }, SESSION_IDLE_TTL_MS),
    })
    return out.subarray(0, bytesRead)
  }

  async endDownload({ downloadId }: { readonly downloadId: string }): Promise<void> {
    const session = this.downloads.get(downloadId)
    if (!session) return
    try {
      await session.fd.close()
    } catch {
      // Best-effort.
    }
    clearTimeout(session.timer)
    this.downloads.delete(downloadId)
  }

  /**
   * Abort all outstanding sessions. Called on addon shutdown so timers
   * don't leak across hot-reload cycles.
   */
  async dispose(): Promise<void> {
    const uploadIds = [...this.uploads.keys()]
    const downloadIds = [...this.downloads.keys()]
    await Promise.all(uploadIds.map((uploadId) => this.abortUpload({ uploadId })))
    await Promise.all(downloadIds.map((downloadId) => this.endDownload({ downloadId })))
  }
}

export default FilesystemStorageProvider

/**
 * WebDAV `storage-provider` cap implementation.
 *
 * Backs Nextcloud, OwnCloud, generic WebDAV servers.
 *
 *   - small-file primitives: `getFileContents` / `putFileContents` /
 *     `deleteFile` / `exists` / `getDirectoryContents`.
 *   - chunked upload: a `PassThrough` stream is fed into
 *     `putFileContents()` (which accepts `Stream.Readable`); operator
 *     calls `writeChunk` to push bytes; `finalizeUpload` ends the
 *     stream and awaits the put. The target path is always written as
 *     `${target}.partial`, then `moveFile` renames it on commit.
 *   - chunked download: `createReadStream({ range })` per chunk —
 *     stateless on the server side; sessions only hold the remote path
 *     + size + idle TTL.
 *
 * Path-traversal guard via `safeJoinRemotePath` mirrors the SFTP
 * implementation.
 */
import { PassThrough } from 'node:stream'
import {
  AuthType,
  createClient as createWebdavClient,
  type WebDAVClient,
  type WebDAVClientOptions,
  type FileStat,
} from 'webdav'
import {
  type IScopedLogger,
  type IStorageProviderImpl,
  type StorageLocation,
} from '@camstack/types'
import {
  createSessionId,
  getRequiredBasePath,
  rearmIdleAbort,
  safeJoinRemotePath,
  scheduleIdleAbort,
} from '../../shared.js'
import { WEBDAV_CONFIG_SCHEMA, type WebDavConfig } from './webdav-config-schema.js'

const PROVIDER_ID = 'webdav-storage'
const DISPLAY_NAME = 'WebDAV'

interface UploadSession {
  readonly client: WebDAVClient
  readonly partial: string
  readonly target: string
  readonly stream: PassThrough
  readonly putPromise: Promise<void>
  bytesWritten: number
  failed: boolean
  timer: NodeJS.Timeout
}

interface DownloadSession {
  readonly client: WebDAVClient
  readonly target: string
  readonly sizeBytes: number
  timer: NodeJS.Timeout
}

function configFromRecord(raw: Record<string, unknown>): WebDavConfig {
  const url = typeof raw['url'] === 'string' ? raw['url'] : ''
  const basePath = typeof raw['basePath'] === 'string' ? raw['basePath'] : ''
  const authMethod = raw['authMethod']
  const out: WebDavConfig = {
    url,
    basePath,
    ...(authMethod === 'basic' || authMethod === 'digest' || authMethod === 'token'
      ? { authMethod }
      : {}),
    ...(typeof raw['username'] === 'string' ? { username: raw['username'] } : {}),
    ...(typeof raw['password'] === 'string' ? { password: raw['password'] } : {}),
    ...(typeof raw['token'] === 'string' ? { token: raw['token'] } : {}),
  }
  return out
}

function configFromLocation(location: StorageLocation): WebDavConfig {
  const cfg = configFromRecord(location.config as Record<string, unknown>)
  if (cfg.url.length === 0) {
    throw new Error(`webdav-storage: location "${location.id}" missing config.url`)
  }
  return { ...cfg, basePath: getRequiredBasePath(location) }
}

function buildClientOptions(cfg: WebDavConfig): WebDAVClientOptions {
  const authMethod = cfg.authMethod ?? 'basic'
  if (authMethod === 'token') {
    if (!cfg.token)
      throw new Error('webdav-storage: bearer token is required when authMethod is "token"')
    return {
      authType: AuthType.Token,
      // The webdav lib expects an OAuth-style object — `access_token` is
      // the standard field; `token_type` defaults to "Bearer".
      token: { access_token: cfg.token, token_type: 'Bearer' },
    }
  }
  return {
    authType: authMethod === 'digest' ? AuthType.Digest : AuthType.Password,
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
  }
}

/** Constructor seam — `createClient` factory swap for tests. */
export type WebdavClientFactory = (url: string, options?: WebDAVClientOptions) => WebDAVClient

export class WebDavStorageProvider implements IStorageProviderImpl {
  static readonly providerId = PROVIDER_ID
  static readonly displayName = DISPLAY_NAME

  private readonly logger: IScopedLogger
  private readonly factory: WebdavClientFactory
  private readonly clients = new Map<string, WebDAVClient>()
  private readonly uploads = new Map<string, UploadSession>()
  private readonly downloads = new Map<string, DownloadSession>()

  constructor(logger: IScopedLogger, factory: WebdavClientFactory = createWebdavClient) {
    this.logger = logger
    this.factory = factory
  }

  // ── Self-description ────────────────────────────────────────────────

  async getProviderInfo() {
    return {
      providerId: PROVIDER_ID,
      displayName: DISPLAY_NAME,
      configSchema: WEBDAV_CONFIG_SCHEMA,
      // Reachable from any node (remote/object store), not a node-local volume.
      nodeLocal: false,
      // No local free-space concept (remote/object store) → no disk-pressure
      // eviction; the recorder skips the guard for locations on this provider.
      shouldSaveDiskSpace: false as const,
      minFreePercent: null,
    }
  }

  async testLocation({ config }: { readonly config: Record<string, unknown> }): Promise<{
    readonly ok: boolean
    readonly error?: string
  }> {
    let cfg: WebDavConfig
    try {
      cfg = configFromRecord(config)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    if (cfg.url.length === 0) return { ok: false, error: 'config.url is required' }
    if (cfg.basePath.length === 0) return { ok: false, error: 'config.basePath is required' }

    try {
      const client = this.factory(cfg.url, buildClientOptions(cfg))
      // `exists` walks the full URL — `false` is acceptable (we only
      // need to confirm we can talk to the server).
      await client.exists(cfg.basePath)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ── Client pool ─────────────────────────────────────────────────────

  private clientKey(cfg: WebDavConfig): string {
    return `${cfg.url}|${cfg.username ?? ''}`
  }

  private getClient(cfg: WebDavConfig): WebDAVClient {
    const key = this.clientKey(cfg)
    const existing = this.clients.get(key)
    if (existing) return existing
    const client = this.factory(cfg.url, buildClientOptions(cfg))
    this.clients.set(key, client)
    return client
  }

  // ── Small-file primitives ───────────────────────────────────────────

  async resolve({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<string> {
    const cfg = configFromLocation(location)
    return safeJoinRemotePath(cfg.basePath, relativePath)
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
    const cfg = configFromLocation(location)
    const target = safeJoinRemotePath(cfg.basePath, relativePath)
    const client = this.getClient(cfg)
    await ensureRemoteDir(client, parentOf(target))
    await client.putFileContents(target, Buffer.from(data), { overwrite: true })
  }

  async read({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<Uint8Array<ArrayBuffer>> {
    const cfg = configFromLocation(location)
    const target = safeJoinRemotePath(cfg.basePath, relativePath)
    const client = this.getClient(cfg)
    const result = await client.getFileContents(target, { format: 'binary' })
    const bytes = bufferLikeToBuffer(result)
    const out = new Uint8Array(new ArrayBuffer(bytes.length))
    out.set(bytes)
    return out
  }

  async exists({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<boolean> {
    const cfg = configFromLocation(location)
    const target = safeJoinRemotePath(cfg.basePath, relativePath)
    const client = this.getClient(cfg)
    try {
      return await client.exists(target)
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
    const cfg = configFromLocation(location)
    const dir = prefix ? safeJoinRemotePath(cfg.basePath, prefix) : cfg.basePath
    const client = this.getClient(cfg)
    try {
      const entries = (await client.getDirectoryContents(dir)) as FileStat[]
      return entries.map((e) => (prefix ? `${prefix}/${e.basename}` : e.basename))
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
    const cfg = configFromLocation(location)
    const target = safeJoinRemotePath(cfg.basePath, relativePath)
    const client = this.getClient(cfg)
    await client.deleteFile(target).catch(() => {
      /* idempotent */
    })
  }

  async getAvailableSpace({
    location,
  }: {
    readonly location: StorageLocation
  }): Promise<number | null> {
    const cfg = configFromLocation(location)
    const client = this.getClient(cfg)
    try {
      const quota = await client.getQuota()
      if (!quota || quota === null) return null
      // `available` may be 'unknown' / 'unlimited' / number.
      if (typeof quota === 'object' && 'available' in quota) {
        const avail = quota.available
        if (typeof avail === 'number') return avail
      }
      return null
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
    const cfg = configFromLocation(location)
    const target = safeJoinRemotePath(cfg.basePath, relativePath)
    const partial = `${target}.partial`
    const client = this.getClient(cfg)
    await ensureRemoteDir(client, parentOf(target))

    const stream = new PassThrough()
    const putPromise = client
      .putFileContents(partial, stream, { overwrite: true })
      .then(() => undefined)
      .catch((err: unknown) => {
        const session = this.uploads.get(uploadId)
        if (session) session.failed = true
        this.logger.warn('WebDAV upload failed', {
          meta: { error: err instanceof Error ? err.message : String(err), target },
        })
      })

    const uploadId = createSessionId()
    const session: UploadSession = {
      client,
      partial,
      target,
      stream,
      putPromise,
      bytesWritten: 0,
      failed: false,
      timer: scheduleIdleAbort(() => {
        void this.abortUpload({ uploadId }).catch(() => {})
      }),
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
      throw new Error(`webdav-storage: upload session "${uploadId}" not found`)
    }
    if (offset !== session.bytesWritten) {
      throw new Error(
        `webdav-storage: chunk offset mismatch (expected ${session.bytesWritten}, got ${offset})`,
      )
    }
    if (session.failed) {
      throw new Error(`webdav-storage: upload session "${uploadId}" already failed`)
    }
    await new Promise<void>((resolve, reject) => {
      session.stream.write(Buffer.from(data), (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    const next: UploadSession = {
      ...session,
      bytesWritten: session.bytesWritten + data.length,
      timer: rearmIdleAbort(session.timer, () => {
        void this.abortUpload({ uploadId }).catch(() => {})
      }),
    }
    this.uploads.set(uploadId, next)
  }

  async finalizeUpload({ uploadId }: { readonly uploadId: string }): Promise<void> {
    const session = this.uploads.get(uploadId)
    if (!session) {
      throw new Error(`webdav-storage: upload session "${uploadId}" not found`)
    }
    session.stream.end()
    await session.putPromise
    if (session.failed) {
      this.uploads.delete(uploadId)
      throw new Error(`webdav-storage: upload "${session.target}" failed during commit`)
    }
    // Atomic publish: rename `.partial` → final target.
    await session.client.moveFile(session.partial, session.target)
    clearTimeout(session.timer)
    this.uploads.delete(uploadId)
  }

  async abortUpload({ uploadId }: { readonly uploadId: string }): Promise<void> {
    const session = this.uploads.get(uploadId)
    if (!session) return
    try {
      session.stream.destroy()
    } catch {
      /* best-effort */
    }
    // Best-effort: drop the partial file (may not exist if the put
    // never made the first byte).
    await session.client.deleteFile(session.partial).catch(() => {})
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
    const cfg = configFromLocation(location)
    const target = safeJoinRemotePath(cfg.basePath, relativePath)
    const client = this.getClient(cfg)
    const stat = (await client.stat(target)) as FileStat
    const sizeBytes = Number(stat.size)
    const downloadId = createSessionId()
    const session: DownloadSession = {
      client,
      target,
      sizeBytes,
      timer: scheduleIdleAbort(() => {
        void this.endDownload({ downloadId }).catch(() => {})
      }),
    }
    this.downloads.set(downloadId, session)
    return { downloadId, sizeBytes }
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
      throw new Error(`webdav-storage: download session "${downloadId}" not found`)
    }
    const end = Math.min(offset + length, session.sizeBytes) - 1
    const stream = session.client.createReadStream(session.target, {
      range: { start: offset, end },
    })
    const chunks: Buffer[] = []
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer | string) => {
        chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
      })
      stream.on('end', () => resolve())
      stream.on('error', reject)
    })
    const concat = Buffer.concat(chunks)
    const out = new Uint8Array(new ArrayBuffer(concat.length))
    out.set(concat)
    const next: DownloadSession = {
      ...session,
      timer: rearmIdleAbort(session.timer, () => {
        void this.endDownload({ downloadId }).catch(() => {})
      }),
    }
    this.downloads.set(downloadId, next)
    return out
  }

  async endDownload({ downloadId }: { readonly downloadId: string }): Promise<void> {
    const session = this.downloads.get(downloadId)
    if (!session) return
    clearTimeout(session.timer)
    this.downloads.delete(downloadId)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    const uploadIds = [...this.uploads.keys()]
    const downloadIds = [...this.downloads.keys()]
    await Promise.all(uploadIds.map((uploadId) => this.abortUpload({ uploadId })))
    await Promise.all(downloadIds.map((downloadId) => this.endDownload({ downloadId })))
    // The webdav client doesn't expose an explicit close; we just drop
    // the references and let the underlying fetch sockets time out.
    this.clients.clear()
  }
}

function parentOf(remotePath: string): string {
  const idx = remotePath.lastIndexOf('/')
  if (idx <= 0) return '/'
  return remotePath.slice(0, idx)
}

async function ensureRemoteDir(client: WebDAVClient, dir: string): Promise<void> {
  if (dir === '' || dir === '/') return
  // `createDirectory` with `recursive: true` is supported by the webdav
  // package — but only some servers honour it. Walk parents bottom-up
  // for portability, swallowing 405 / 409 (already exists).
  const segments = dir.split('/').filter(Boolean)
  let acc = ''
  for (const seg of segments) {
    acc = `${acc}/${seg}`
    try {
      await client.createDirectory(acc)
    } catch {
      // 405 (Method Not Allowed) on existing collections is normal;
      // anything else surfaces later when the put fails.
    }
  }
}

function bufferLikeToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value)
  // Detail-rich response wrapper: `.data` is the BufferLike.
  if (value && typeof value === 'object' && 'data' in value) {
    return bufferLikeToBuffer((value as { data: unknown }).data)
  }
  return Buffer.alloc(0)
}

export default WebDavStorageProvider

/**
 * SFTP `storage-provider` cap implementation.
 *
 * Mirrors the contract of the canonical
 * `@camstack/system` `FilesystemStorageProvider`:
 *   - small-file primitives (resolve/write/read/exists/list/delete/getAvailableSpace)
 *   - chunked upload (.partial → atomic rename) + chunked download
 *   - 5-minute idle TTL on every session
 *
 * Connection pool: one `ssh2.Client` per `(host, port, username)` triple,
 * keyed by a stable string. The underlying `ssh2.Client` keeps the SSH
 * channel alive between calls; we only hand out one `SFTPWrapper` per
 * session. Connections are torn down on `dispose()` (called from the
 * addon's `onShutdown`).
 */
import { Client, type ConnectConfig, type SFTPWrapper, type FileEntry } from 'ssh2'
import * as path from 'node:path'
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
import { SFTP_CONFIG_SCHEMA, type SftpConfig } from './sftp-config-schema.js'

const PROVIDER_ID = 'sftp-storage'
const DISPLAY_NAME = 'SFTP'

/** Pooled SSH connection. */
interface PooledClient {
  readonly client: Client
  readonly sftp: SFTPWrapper
}

/** Open upload session — `.partial` rename trick mirrors filesystem-provider. */
interface UploadSession {
  readonly poolKey: string
  readonly partial: string
  readonly target: string
  readonly handle: Buffer
  readonly sftp: SFTPWrapper
  bytesWritten: number
  timer: NodeJS.Timeout
}

/** Open download session. */
interface DownloadSession {
  readonly poolKey: string
  readonly handle: Buffer
  readonly sftp: SFTPWrapper
  readonly sizeBytes: number
  timer: NodeJS.Timeout
}

/**
 * Convert callback-style ssh2 calls into typed promises. Centralised so
 * every primitive uses the same error normalization.
 */
function asPromise<T>(
  invoke: (cb: (err: Error | null | undefined, value?: T) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((err, value) => {
      if (err) reject(err)
      else resolve(value as T)
    })
  })
}

function asVoidPromise(
  invoke: (cb: (err: Error | null | undefined) => void) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    invoke((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

function buildConnectConfig(cfg: SftpConfig): ConnectConfig {
  const base: ConnectConfig = {
    host: cfg.host,
    port: cfg.port ?? 22,
    username: cfg.username,
    readyTimeout: 15_000,
  }
  if (cfg.authMethod === 'privateKey') {
    if (!cfg.privateKey || cfg.privateKey.length === 0) {
      throw new Error('sftp-storage: privateKey is required when authMethod is "privateKey"')
    }
    return {
      ...base,
      privateKey: cfg.privateKey,
      ...(cfg.privateKeyPassphrase ? { passphrase: cfg.privateKeyPassphrase } : {}),
    }
  }
  // Default: password.
  if (!cfg.password || cfg.password.length === 0) {
    throw new Error('sftp-storage: password is required when authMethod is "password"')
  }
  return { ...base, password: cfg.password }
}

function configFromLocation(location: StorageLocation): SftpConfig {
  const cfg = location.config as Record<string, unknown>
  const host = cfg['host']
  const username = cfg['username']
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error(`sftp-storage: location "${location.id}" missing config.host`)
  }
  if (typeof username !== 'string' || username.length === 0) {
    throw new Error(`sftp-storage: location "${location.id}" missing config.username`)
  }
  const out: SftpConfig = {
    host,
    username,
    basePath: getRequiredBasePath(location),
    ...(typeof cfg['port'] === 'number' ? { port: cfg['port'] } : {}),
    ...(cfg['authMethod'] === 'password' || cfg['authMethod'] === 'privateKey'
      ? { authMethod: cfg['authMethod'] }
      : {}),
    ...(typeof cfg['password'] === 'string' ? { password: cfg['password'] } : {}),
    ...(typeof cfg['privateKey'] === 'string' ? { privateKey: cfg['privateKey'] } : {}),
    ...(typeof cfg['privateKeyPassphrase'] === 'string'
      ? { privateKeyPassphrase: cfg['privateKeyPassphrase'] }
      : {}),
    ...(typeof cfg['hostKeyFingerprint'] === 'string'
      ? { hostKeyFingerprint: cfg['hostKeyFingerprint'] }
      : {}),
  }
  return out
}

function configFromRecord(raw: Record<string, unknown>): SftpConfig {
  const host = typeof raw['host'] === 'string' ? raw['host'] : ''
  const username = typeof raw['username'] === 'string' ? raw['username'] : ''
  const basePath = typeof raw['basePath'] === 'string' ? raw['basePath'] : ''
  const out: SftpConfig = {
    host,
    username,
    basePath,
    ...(typeof raw['port'] === 'number' ? { port: raw['port'] } : {}),
    ...(raw['authMethod'] === 'password' || raw['authMethod'] === 'privateKey'
      ? { authMethod: raw['authMethod'] }
      : {}),
    ...(typeof raw['password'] === 'string' ? { password: raw['password'] } : {}),
    ...(typeof raw['privateKey'] === 'string' ? { privateKey: raw['privateKey'] } : {}),
    ...(typeof raw['privateKeyPassphrase'] === 'string'
      ? { privateKeyPassphrase: raw['privateKeyPassphrase'] }
      : {}),
    ...(typeof raw['hostKeyFingerprint'] === 'string'
      ? { hostKeyFingerprint: raw['hostKeyFingerprint'] }
      : {}),
  }
  return out
}

function poolKeyFor(cfg: SftpConfig): string {
  return `${cfg.username}@${cfg.host}:${cfg.port ?? 22}`
}

/**
 * Constructor for an `ssh2.Client`. Indirected through a property so
 * tests can inject a stub without monkey-patching the module.
 */
type ClientCtor = new () => Client

export class SftpStorageProvider implements IStorageProviderImpl {
  static readonly providerId = PROVIDER_ID
  static readonly displayName = DISPLAY_NAME

  private readonly logger: IScopedLogger
  private readonly clientCtor: ClientCtor
  private readonly pool = new Map<string, PooledClient>()
  private readonly uploads = new Map<string, UploadSession>()
  private readonly downloads = new Map<string, DownloadSession>()

  constructor(logger: IScopedLogger, clientCtor: ClientCtor = Client) {
    this.logger = logger
    this.clientCtor = clientCtor
  }

  // ── Self-description ────────────────────────────────────────────────

  async getProviderInfo() {
    return {
      providerId: PROVIDER_ID,
      displayName: DISPLAY_NAME,
      configSchema: SFTP_CONFIG_SCHEMA,
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
    let cfg: SftpConfig
    try {
      cfg = configFromRecord(config)
      if (cfg.host.length === 0) return { ok: false, error: 'config.host is required' }
      if (cfg.username.length === 0) return { ok: false, error: 'config.username is required' }
      if (cfg.basePath.length === 0) return { ok: false, error: 'config.basePath is required' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    // Open an isolated client (NOT pooled) so a failed probe doesn't
    // poison the long-running pool keyed by the same triple.
    const client = new this.clientCtor()
    try {
      await this.connectClient(client, cfg)
      const sftp = await asPromise<SFTPWrapper>((cb) => client.sftp(cb))
      try {
        // Simple stat — 404 is fine, anything else surfaces as error.
        await asPromise<unknown>((cb) => sftp.stat(cfg.basePath, cb)).catch(() => null)
      } finally {
        sftp.end()
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      try {
        client.end()
      } catch {
        /* best-effort */
      }
    }
  }

  // ── Connection pooling ──────────────────────────────────────────────

  private connectClient(client: Client, cfg: SftpConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      client.once('ready', () => settle())
      client.once('error', (err) => settle(err instanceof Error ? err : new Error(String(err))))
      try {
        client.connect(buildConnectConfig(cfg))
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  private async getPooled(location: StorageLocation): Promise<PooledClient> {
    const cfg = configFromLocation(location)
    const key = poolKeyFor(cfg)
    const existing = this.pool.get(key)
    if (existing) return existing

    const client = new this.clientCtor()
    await this.connectClient(client, cfg)
    const sftp = await asPromise<SFTPWrapper>((cb) => client.sftp(cb))
    // Detect drops so we evict from the pool — the next call will
    // re-connect transparently.
    const evict = (): void => {
      if (this.pool.get(key)?.client === client) this.pool.delete(key)
    }
    client.on('end', evict)
    client.on('close', evict)
    const pooled: PooledClient = { client, sftp }
    this.pool.set(key, pooled)
    this.logger.info('SFTP connection established', { meta: { key } })
    return pooled
  }

  private async withSftp<T>(
    location: StorageLocation,
    fn: (sftp: SFTPWrapper, cfg: SftpConfig) => Promise<T>,
  ): Promise<T> {
    const cfg = configFromLocation(location)
    const pooled = await this.getPooled(location)
    return fn(pooled.sftp, cfg)
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
    return this.withSftp(location, async (sftp) => {
      await this.ensureRemoteDir(sftp, posixDirname(target))
      const handle = await asPromise<Buffer>((cb) => sftp.open(target, 'w', cb))
      try {
        await asPromise<number>((cb) =>
          sftp.write(handle, Buffer.from(data), 0, data.length, 0, cb),
        )
      } finally {
        await asVoidPromise((cb) => sftp.close(handle, cb)).catch(() => {})
      }
    })
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
    return this.withSftp(location, async (sftp) => {
      const stat = await asPromise<{ size: number }>((cb) =>
        sftp.stat(target, (err, attrs) =>
          cb(err ?? null, attrs ? { size: Number(attrs.size ?? 0) } : { size: 0 }),
        ),
      )
      const handle = await asPromise<Buffer>((cb) => sftp.open(target, 'r', cb))
      try {
        const out = new Uint8Array(new ArrayBuffer(stat.size))
        if (stat.size > 0) {
          const buf = Buffer.from(out.buffer)
          await asPromise<number>((cb) =>
            sftp.read(handle, buf, 0, stat.size, 0, (err, bytesRead) => cb(err ?? null, bytesRead)),
          )
        }
        return out
      } finally {
        await asVoidPromise((cb) => sftp.close(handle, cb)).catch(() => {})
      }
    })
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
    return this.withSftp(location, async (sftp) => {
      try {
        await asPromise<unknown>((cb) => sftp.stat(target, cb))
        return true
      } catch {
        return false
      }
    })
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
    return this.withSftp(location, async (sftp) => {
      try {
        const entries = await asPromise<FileEntry[]>((cb) =>
          sftp.readdir(dir, (err, list) => cb(err ?? null, list)),
        )
        return entries.map((e) => (prefix ? `${prefix}/${e.filename}` : e.filename))
      } catch {
        return []
      }
    })
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
    return this.withSftp(location, async (sftp) => {
      await asVoidPromise((cb) => sftp.unlink(target, cb)).catch(() => {})
    })
  }

  async getAvailableSpace(_input: { readonly location: StorageLocation }): Promise<number | null> {
    // SFTP has no portable `statvfs` — the OpenSSH `statvfs@openssh.com`
    // extension exists but isn't supported by `ssh2`'s typed surface.
    // Returning `null` matches the contract for "unknown".
    return null
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
    const pooled = await this.getPooled(location)
    const sftp = pooled.sftp
    await this.ensureRemoteDir(sftp, posixDirname(target))
    // Wipe a stale `.partial` from a previous aborted run so the
    // append-zero offset stays correct.
    await asVoidPromise((cb) => sftp.unlink(partial, cb)).catch(() => {})
    const handle = await asPromise<Buffer>((cb) => sftp.open(partial, 'w', cb))
    const uploadId = createSessionId()
    const session: UploadSession = {
      poolKey: poolKeyFor(cfg),
      partial,
      target,
      handle,
      sftp,
      bytesWritten: 0,
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
      throw new Error(`sftp-storage: upload session "${uploadId}" not found`)
    }
    if (offset !== session.bytesWritten) {
      throw new Error(
        `sftp-storage: chunk offset mismatch (expected ${session.bytesWritten}, got ${offset})`,
      )
    }
    await asPromise<number>((cb) =>
      session.sftp.write(session.handle, Buffer.from(data), 0, data.length, offset, cb),
    )
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
      throw new Error(`sftp-storage: upload session "${uploadId}" not found`)
    }
    await asVoidPromise((cb) => session.sftp.close(session.handle, cb))
    // Best-effort: remove pre-existing target so the rename succeeds on
    // backends that don't allow rename-over.
    await asVoidPromise((cb) => session.sftp.unlink(session.target, cb)).catch(() => {})
    await asVoidPromise((cb) => session.sftp.rename(session.partial, session.target, cb))
    clearTimeout(session.timer)
    this.uploads.delete(uploadId)
  }

  async abortUpload({ uploadId }: { readonly uploadId: string }): Promise<void> {
    const session = this.uploads.get(uploadId)
    if (!session) return
    await asVoidPromise((cb) => session.sftp.close(session.handle, cb)).catch(() => {})
    await asVoidPromise((cb) => session.sftp.unlink(session.partial, cb)).catch(() => {})
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
    const pooled = await this.getPooled(location)
    const sftp = pooled.sftp
    const stat = await asPromise<{ size: number }>((cb) =>
      sftp.stat(target, (err, attrs) =>
        cb(err ?? null, attrs ? { size: Number(attrs.size ?? 0) } : { size: 0 }),
      ),
    )
    const handle = await asPromise<Buffer>((cb) => sftp.open(target, 'r', cb))
    const downloadId = createSessionId()
    const session: DownloadSession = {
      poolKey: poolKeyFor(cfg),
      sftp,
      handle,
      sizeBytes: stat.size,
      timer: scheduleIdleAbort(() => {
        void this.endDownload({ downloadId }).catch(() => {})
      }),
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
      throw new Error(`sftp-storage: download session "${downloadId}" not found`)
    }
    const out = new Uint8Array(new ArrayBuffer(length))
    const buf = Buffer.from(out.buffer)
    const bytesRead = await asPromise<number>((cb) =>
      session.sftp.read(session.handle, buf, 0, length, offset, (err, n) => cb(err ?? null, n)),
    )
    const next: DownloadSession = {
      ...session,
      timer: rearmIdleAbort(session.timer, () => {
        void this.endDownload({ downloadId }).catch(() => {})
      }),
    }
    this.downloads.set(downloadId, next)
    return out.subarray(0, bytesRead) as Uint8Array<ArrayBuffer>
  }

  async endDownload({ downloadId }: { readonly downloadId: string }): Promise<void> {
    const session = this.downloads.get(downloadId)
    if (!session) return
    await asVoidPromise((cb) => session.sftp.close(session.handle, cb)).catch(() => {})
    clearTimeout(session.timer)
    this.downloads.delete(downloadId)
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Tear down every pooled connection + outstanding session. */
  async dispose(): Promise<void> {
    const uploadIds = [...this.uploads.keys()]
    const downloadIds = [...this.downloads.keys()]
    await Promise.all(uploadIds.map((uploadId) => this.abortUpload({ uploadId })))
    await Promise.all(downloadIds.map((downloadId) => this.endDownload({ downloadId })))
    for (const pooled of this.pool.values()) {
      try {
        pooled.client.end()
      } catch {
        /* best-effort */
      }
    }
    this.pool.clear()
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private async ensureRemoteDir(sftp: SFTPWrapper, dir: string): Promise<void> {
    if (dir === '' || dir === '/' || dir === '.') return
    // Walk parents top-down so `mkdir` works even when none of them
    // exist yet (most SFTP servers refuse `mkdir foo/bar/baz` when `foo`
    // is missing).
    const segments = dir.split('/').filter(Boolean)
    const isAbsolute = dir.startsWith('/')
    let acc = isAbsolute ? '' : '.'
    for (const seg of segments) {
      acc = acc === '' ? `/${seg}` : acc === '.' ? seg : `${acc}/${seg}`
      try {
        await asVoidPromise((cb) => sftp.mkdir(acc, cb))
      } catch {
        // Existing directory or no-permission — best-effort. The
        // subsequent `open()` will surface a real error if the path
        // truly isn't reachable.
      }
    }
  }
}

function posixDirname(p: string): string {
  const d = path.posix.dirname(p)
  return d === '.' ? '' : d
}

export default SftpStorageProvider

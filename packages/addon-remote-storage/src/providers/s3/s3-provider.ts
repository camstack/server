/**
 * S3 (+ S3-compatible) `storage-provider` cap implementation.
 *
 * Uses `@aws-sdk/lib-storage`'s `Upload` class for chunked uploads — it
 * handles the multipart-upload state machine internally (initiate /
 * upload-part / complete-multipart). We feed it a `PassThrough` stream
 * so individual `writeChunk` calls translate into stream writes; the
 * SDK chunks them into 5MB+ multipart parts under the hood.
 *
 * Chunked download uses `GetObjectCommand` with HTTP `Range:` per chunk
 * — no persistent state on the server side; sessions exist only to
 * remember `(Bucket, Key, sizeBytes)` between chunks and to enforce
 * the 5-minute idle TTL.
 */
import { PassThrough } from 'node:stream'
import {
  S3Client,
  HeadBucketCommand,
  HeadObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import {
  type IScopedLogger,
  type IStorageProviderImpl,
  type StorageLocation,
} from '@camstack/types'
import {
  createSessionId,
  getOptionalBasePath,
  rearmIdleAbort,
  scheduleIdleAbort,
} from '../../shared.js'
import { S3_CONFIG_SCHEMA, type S3Config } from './s3-config-schema.js'

const PROVIDER_ID = 's3-storage'
const DISPLAY_NAME = 'S3 (or S3-compatible)'

interface UploadSession {
  readonly client: S3Client
  readonly bucket: string
  readonly key: string
  readonly stream: PassThrough
  readonly upload: Upload
  /** Resolves when the SDK reports the multipart upload completed. */
  readonly donePromise: Promise<void>
  bytesWritten: number
  failed: boolean
  timer: NodeJS.Timeout
}

interface DownloadSession {
  readonly client: S3Client
  readonly bucket: string
  readonly key: string
  readonly sizeBytes: number
  timer: NodeJS.Timeout
}

function configFromRecord(raw: Record<string, unknown>): S3Config {
  const region = typeof raw['region'] === 'string' ? raw['region'] : 'us-east-1'
  const bucket = typeof raw['bucket'] === 'string' ? raw['bucket'] : ''
  const accessKeyId = typeof raw['accessKeyId'] === 'string' ? raw['accessKeyId'] : ''
  const secretAccessKey = typeof raw['secretAccessKey'] === 'string' ? raw['secretAccessKey'] : ''
  const out: S3Config = {
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    ...(typeof raw['endpoint'] === 'string' && raw['endpoint'].length > 0
      ? { endpoint: raw['endpoint'] }
      : {}),
    ...(typeof raw['forcePathStyle'] === 'boolean'
      ? { forcePathStyle: raw['forcePathStyle'] }
      : {}),
    ...(typeof raw['basePath'] === 'string' ? { basePath: raw['basePath'] } : {}),
  }
  return out
}

function configFromLocation(location: StorageLocation): S3Config {
  const cfg = configFromRecord(location.config as Record<string, unknown>)
  if (cfg.bucket.length === 0) {
    throw new Error(`s3-storage: location "${location.id}" missing config.bucket`)
  }
  if (cfg.accessKeyId.length === 0 || cfg.secretAccessKey.length === 0) {
    throw new Error(`s3-storage: location "${location.id}" missing access credentials`)
  }
  return { ...cfg, basePath: getOptionalBasePath(location) }
}

function buildS3ClientConfig(cfg: S3Config): S3ClientConfig {
  const out: S3ClientConfig = {
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(cfg.forcePathStyle ? { forcePathStyle: true } : {}),
  }
  return out
}

function joinKey(prefix: string | undefined, relativePath: string): string {
  // S3 keys are flat, but operators expect `prefix/relative` semantics.
  // Strip any leading `/` so an absolute-looking input is treated as
  // relative-to-prefix.
  const rel = relativePath.replace(/^\/+/, '')
  // Reject explicit `..` traversal — S3 itself wouldn't notice, but
  // our `safeJoinRemotePath` helper would; for S3 we duplicate the
  // semantic check inline (no path-resolution layer underneath).
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new Error(`s3-storage: relativePath "${relativePath}" attempts traversal`)
  }
  if (!prefix || prefix.length === 0) return rel
  const trimmed = prefix.replace(/\/+$/, '')
  return `${trimmed}/${rel}`
}

/** Constructor seam so tests can inject a stub client. */
type S3ClientCtor = new (config: S3ClientConfig) => S3Client

export class S3StorageProvider implements IStorageProviderImpl {
  static readonly providerId = PROVIDER_ID
  static readonly displayName = DISPLAY_NAME

  private readonly logger: IScopedLogger
  private readonly clientCtor: S3ClientCtor
  private readonly clients = new Map<string, S3Client>()
  private readonly uploads = new Map<string, UploadSession>()
  private readonly downloads = new Map<string, DownloadSession>()

  constructor(logger: IScopedLogger, clientCtor: S3ClientCtor = S3Client) {
    this.logger = logger
    this.clientCtor = clientCtor
  }

  // ── Self-description ────────────────────────────────────────────────

  async getProviderInfo() {
    return {
      providerId: PROVIDER_ID,
      displayName: DISPLAY_NAME,
      configSchema: S3_CONFIG_SCHEMA,
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
    const cfg = configFromRecord(config)
    if (cfg.bucket.length === 0) return { ok: false, error: 'config.bucket is required' }
    if (cfg.accessKeyId.length === 0) return { ok: false, error: 'config.accessKeyId is required' }
    if (cfg.secretAccessKey.length === 0)
      return { ok: false, error: 'config.secretAccessKey is required' }
    const client = new this.clientCtor(buildS3ClientConfig(cfg))
    try {
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      try {
        client.destroy()
      } catch {
        /* best-effort */
      }
    }
  }

  // ── Client pool ─────────────────────────────────────────────────────

  private clientKey(cfg: S3Config): string {
    return `${cfg.endpoint ?? 'aws'}|${cfg.region}|${cfg.accessKeyId}|${cfg.bucket}`
  }

  private getClient(cfg: S3Config): S3Client {
    const key = this.clientKey(cfg)
    const existing = this.clients.get(key)
    if (existing) return existing
    const client = new this.clientCtor(buildS3ClientConfig(cfg))
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
    return `s3://${cfg.bucket}/${joinKey(cfg.basePath, relativePath)}`
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
    const client = this.getClient(cfg)
    const Key = joinKey(cfg.basePath, relativePath)
    await client.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key,
        Body: Buffer.from(data),
      }),
    )
  }

  async read({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<Uint8Array<ArrayBuffer>> {
    const cfg = configFromLocation(location)
    const client = this.getClient(cfg)
    const Key = joinKey(cfg.basePath, relativePath)
    const result = await client.send(
      new GetObjectCommand({
        Bucket: cfg.bucket,
        Key,
      }),
    )
    const body = result.Body
    if (!body) {
      return new Uint8Array(new ArrayBuffer(0))
    }
    const bytes = await collectBytes(body)
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
    const client = this.getClient(cfg)
    const Key = joinKey(cfg.basePath, relativePath)
    try {
      await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key }))
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
    const cfg = configFromLocation(location)
    const client = this.getClient(cfg)
    const fullPrefix = prefix ? joinKey(cfg.basePath, prefix) : (cfg.basePath ?? '')
    const result = await client.send(
      new ListObjectsV2Command({
        Bucket: cfg.bucket,
        ...(fullPrefix.length > 0
          ? { Prefix: fullPrefix.endsWith('/') ? fullPrefix : `${fullPrefix}/` }
          : {}),
        Delimiter: '/',
      }),
    )
    const out: string[] = []
    const stripPrefixLen = (cfg.basePath ?? '').replace(/\/+$/, '').length + (cfg.basePath ? 1 : 0)
    for (const item of result.Contents ?? []) {
      if (!item.Key) continue
      // Return relative-to-location keys to match the
      // filesystem-storage-provider contract.
      const stripped = stripPrefixLen > 0 ? item.Key.slice(stripPrefixLen) : item.Key
      if (stripped.length > 0) out.push(stripped)
    }
    return out
  }

  async delete({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<void> {
    const cfg = configFromLocation(location)
    const client = this.getClient(cfg)
    const Key = joinKey(cfg.basePath, relativePath)
    await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key }))
  }

  async getAvailableSpace(_input: { readonly location: StorageLocation }): Promise<number | null> {
    // S3 has no "free space" concept (effectively unlimited; quotas are
    // billing-driven, not surfaced via the API).
    return null
  }

  // ── Chunked upload (multipart via lib-storage Upload) ───────────────

  async beginUpload({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
    readonly sizeBytes?: number
  }): Promise<{ readonly uploadId: string }> {
    const cfg = configFromLocation(location)
    const client = this.getClient(cfg)
    const key = joinKey(cfg.basePath, relativePath)
    const stream = new PassThrough()
    const upload = new Upload({
      client,
      params: {
        Bucket: cfg.bucket,
        Key: key,
        Body: stream,
      },
      // 5MB minimum allowed by S3; matches lib-storage's default.
      partSize: 5 * 1024 * 1024,
      queueSize: 4,
    })
    const uploadId = createSessionId()
    const donePromise = upload
      .done()
      .then(() => undefined)
      .catch((err: unknown) => {
        const session = this.uploads.get(uploadId)
        if (session) session.failed = true
        this.logger.warn('S3 upload failed', {
          meta: { error: err instanceof Error ? err.message : String(err), key },
        })
      })

    const session: UploadSession = {
      client,
      bucket: cfg.bucket,
      key,
      stream,
      upload,
      donePromise,
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
      throw new Error(`s3-storage: upload session "${uploadId}" not found`)
    }
    if (offset !== session.bytesWritten) {
      throw new Error(
        `s3-storage: chunk offset mismatch (expected ${session.bytesWritten}, got ${offset})`,
      )
    }
    if (session.failed) {
      throw new Error(`s3-storage: upload session "${uploadId}" already failed`)
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
      throw new Error(`s3-storage: upload session "${uploadId}" not found`)
    }
    session.stream.end()
    await session.donePromise
    if (session.failed) {
      this.uploads.delete(uploadId)
      throw new Error(`s3-storage: upload "${session.key}" failed during multipart commit`)
    }
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
    try {
      await session.upload.abort()
    } catch {
      /* best-effort — already-finished uploads can throw */
    }
    clearTimeout(session.timer)
    this.uploads.delete(uploadId)
  }

  // ── Chunked download (Range GETs) ───────────────────────────────────

  async beginDownload({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<{ readonly downloadId: string; readonly sizeBytes: number }> {
    const cfg = configFromLocation(location)
    const client = this.getClient(cfg)
    const key = joinKey(cfg.basePath, relativePath)
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
      }),
    )
    const sizeBytes = Number(head.ContentLength ?? 0)
    const downloadId = createSessionId()
    const session: DownloadSession = {
      client,
      bucket: cfg.bucket,
      key,
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
      throw new Error(`s3-storage: download session "${downloadId}" not found`)
    }
    const end = Math.min(offset + length, session.sizeBytes) - 1
    const result = await session.client.send(
      new GetObjectCommand({
        Bucket: session.bucket,
        Key: session.key,
        Range: `bytes=${offset}-${end}`,
      }),
    )
    const body = result.Body
    const bytes = body ? await collectBytes(body) : new Uint8Array(0)
    const out = new Uint8Array(new ArrayBuffer(bytes.length))
    out.set(bytes)
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
    for (const client of this.clients.values()) {
      try {
        client.destroy()
      } catch {
        /* best-effort */
      }
    }
    this.clients.clear()
  }
}

/**
 * Drain the SDK's polymorphic response body (Node.js Readable, Web
 * ReadableStream, or Blob) into a single Buffer-backed `Uint8Array`.
 * The SDK doesn't expose a typed helper, so we narrow at the call site.
 */
async function collectBytes(body: unknown): Promise<Uint8Array> {
  // Node.js Readable
  if (
    body &&
    typeof (body as { on?: unknown }).on === 'function' &&
    typeof (body as { read?: unknown }).read === 'function'
  ) {
    const chunks: Buffer[] = []
    const readable = body as NodeJS.ReadableStream
    return new Promise<Uint8Array>((resolve, reject) => {
      readable.on('data', (c: Buffer | string) => {
        chunks.push(typeof c === 'string' ? Buffer.from(c) : c)
      })
      readable.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))))
      readable.on('error', reject)
    })
  }
  // Web ReadableStream — has `getReader`.
  const maybeStream = body as {
    getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> }
  }
  if (maybeStream && typeof maybeStream.getReader === 'function') {
    const reader = maybeStream.getReader()
    const chunks: Uint8Array[] = []
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) chunks.push(value)
    }
    let total = 0
    for (const c of chunks) total += c.length
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }
  // Blob with arrayBuffer().
  const maybeBlob = body as { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (maybeBlob && typeof maybeBlob.arrayBuffer === 'function') {
    const ab = await maybeBlob.arrayBuffer()
    return new Uint8Array(ab)
  }
  // Plain Buffer / Uint8Array.
  if (body instanceof Uint8Array) return body
  return new Uint8Array(0)
}

export default S3StorageProvider

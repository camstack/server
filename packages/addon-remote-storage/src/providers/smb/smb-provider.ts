/**
 * SMB / CIFS `storage-provider` cap implementation — the fourth entry in
 * `@camstack/addon-remote-storage`.
 *
 * ── Scope, and why it is narrow ────────────────────────────────────────────
 * This provider serves `cap-mediated` storage kinds only, which today means
 * `backups`. That is not a limitation of SMB; it is the declared
 * service/location-kind constraint (D296). A kind whose owning service does
 * raw `node:fs` on the string `storage.resolve` hands back cannot be served by
 * ANY remote provider, and the orchestrator refuses the pairing at upsert time
 * rather than letting it fail at the first write — where, for recordings, it
 * would surface as a silent black window rather than an error.
 *
 * ── Why the I/O looks like this ────────────────────────────────────────────
 * `smbclient` is a file-at-a-time tool: `put`, `get`, `del`, `rename`. There
 * is no random-access write. So a chunked upload SPOOLS to a local temp file
 * and transfers once on `finalizeUpload`, and a chunked download fetches once
 * on `beginDownload` and serves ranges from the local copy. For the one
 * consumer this provider has — a nightly archive written by a single hub
 * singleton — that is the right trade: one transfer instead of N round trips,
 * and the transfer either completes or does not.
 *
 * ── Verify-on-finalize ─────────────────────────────────────────────────────
 * `finalizeUpload` stats the landed file and compares its size to the bytes
 * the session was given. `close()` returning is not a durability statement
 * over SMB — write-behind caching, oplocks and leases all sit between the
 * client and the server's platters — and the backup manifest carries no
 * checksum, so "the archive is there" is currently believed on the strength of
 * a call that returned. One round trip per nightly archive turns that into
 * "the server says the file is that many bytes", which is a materially
 * stronger claim and is the most this can assert without a `backup` cap
 * change.
 *
 * ── What every method does first ───────────────────────────────────────────
 * Checks that `smbclient` exists. A provider whose binary is missing must
 * REFUSE, loudly, and never resemble a provider whose share happens to be
 * empty: `empty` is what D293's delete guard needs to see before it will let
 * an operator destroy a location, and a full share behind a missing binary
 * must not clear that bar.
 */
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IScopedLogger, IStorageProviderImpl, StorageLocation } from '@camstack/types'
import { rearmIdleAbort, scheduleIdleAbort } from '../../shared.js'
import { SMB_CONFIG_SCHEMA, type SmbConfig } from './smb-config-schema.js'
import {
  defaultSmbClientFactory,
  probeSmbBinary,
  SmbBinaryUnavailableError,
  type SmbClientLike,
  type SmbClientOptions,
  type SmbItem,
} from './smb-client.js'
import {
  listMaskFor,
  normalizedBasePath,
  pathSegments,
  safeSmbRelativePath,
  shareIdentity,
  smbAddress,
} from './smb-paths.js'

const PROVIDER_ID = 'smb-storage'
const DISPLAY_NAME = 'SMB / CIFS'

/** Per-operation ceiling handed to smbclient (`-t`), in seconds. */
const SMB_TIMEOUT_SECONDS = 60

/** A spooling upload. */
interface UploadSession {
  readonly location: StorageLocation
  readonly relativePath: string
  readonly spoolPath: string
  bytesWritten: number
  timer: NodeJS.Timeout
}

/** A download served from a local copy of the remote file. */
interface DownloadSession {
  readonly spoolPath: string
  readonly sizeBytes: number
  timer: NodeJS.Timeout
}

/** Constructor injection for tests. */
export interface SmbStorageProviderDeps {
  readonly createClient?: (options: SmbClientOptions) => Promise<SmbClientLike>
  readonly hasBinary?: () => Promise<boolean>
  /** Directory used to spool uploads and downloads. Defaults to the OS temp dir. */
  readonly spoolDir?: string
}

function requireString(value: unknown, field: string, locationId: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`smb-storage: location "${locationId}" missing config.${field}`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a `SmbConfig` out of a config record. Names the FIELD, never the value. */
export function smbConfigFromRecord(
  config: Readonly<Record<string, unknown>>,
  locationId: string,
): SmbConfig {
  const host = requireString(config['host'], 'host', locationId)
  const share = requireString(config['share'], 'share', locationId)
  if (host.includes('/') || host.includes('\\')) {
    throw new Error(`smb-storage: config.host must be a bare hostname, without slashes`)
  }
  if (share.includes('/') || share.includes('\\')) {
    throw new Error(`smb-storage: config.share must be a bare share name, without slashes`)
  }
  const basePath = optionalString(config['basePath']) ?? ''
  return {
    host,
    share,
    basePath: normalizedBasePathPreservingCase(basePath),
    ...(optionalNumber(config['port']) !== undefined
      ? { port: optionalNumber(config['port']) }
      : {}),
    ...(optionalString(config['username']) !== undefined
      ? { username: optionalString(config['username']) }
      : {}),
    ...(optionalString(config['password']) !== undefined
      ? { password: optionalString(config['password']) }
      : {}),
    ...(optionalString(config['domain']) !== undefined
      ? { domain: optionalString(config['domain']) }
      : {}),
    ...(optionalString(config['maxProtocol']) !== undefined
      ? { maxProtocol: optionalString(config['maxProtocol']) }
      : {}),
  }
}

/** Trim slashes without lower-casing — the value is USED, not compared. */
function normalizedBasePathPreservingCase(basePath: string): string {
  return basePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/**
 * Map a raw smbclient failure onto a closed set of operator-facing reasons.
 *
 * The raw text is never forwarded. `samba-client` puts `--password` on the
 * argv, and although `maskCmd` replaces the message with captured output, that
 * output still names accounts and domains on an NTLM failure — and
 * `storage.testConfig` returns this string verbatim to the caller.
 */
export function mapSmbError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const text = raw.toUpperCase()
  if (text.includes('LOGON_FAILURE') || text.includes('ACCESS_DENIED')) {
    return 'authentication failed'
  }
  if (text.includes('BAD_NETWORK_NAME') || text.includes('NO_SUCH_SHARE')) {
    return 'share not found'
  }
  if (text.includes('OBJECT_NAME_NOT_FOUND') || text.includes('OBJECT_PATH_NOT_FOUND')) {
    return 'path not found on the share'
  }
  if (text.includes('CONNECTION_REFUSED') || text.includes('ECONNREFUSED')) {
    return 'connection refused'
  }
  if (text.includes('TIMED OUT') || text.includes('ETIMEDOUT') || text.includes('IO_TIMEOUT')) {
    return 'timed out'
  }
  if (
    text.includes('HOST_UNREACHABLE') ||
    text.includes('ENOTFOUND') ||
    text.includes('EHOSTUNREACH')
  ) {
    return 'server unreachable'
  }
  if (text.includes('DISK_FULL') || text.includes('NO_SPACE')) {
    return 'the share is full'
  }
  return 'the SMB operation failed — see the addon log for the server response'
}

export class SmbStorageProvider implements IStorageProviderImpl {
  static readonly providerId = PROVIDER_ID
  static readonly displayName = DISPLAY_NAME

  private readonly uploads = new Map<string, UploadSession>()
  private readonly downloads = new Map<string, DownloadSession>()
  private readonly createClient: (options: SmbClientOptions) => Promise<SmbClientLike>
  private readonly hasBinary: () => Promise<boolean>
  private readonly spoolRoot: string
  /**
   * Cached binary probe. Refreshed only from `false` → re-probe, so a node
   * that gains the binary (the runner's install landing late, an operator
   * fixing it by hand) recovers without a restart, while the healthy path
   * costs one probe for the life of the process.
   */
  private binaryPresent: boolean | null = null

  constructor(
    private readonly logger: IScopedLogger,
    deps: SmbStorageProviderDeps = {},
  ) {
    this.createClient = deps.createClient ?? defaultSmbClientFactory
    this.hasBinary = deps.hasBinary ?? probeSmbBinary
    this.spoolRoot = deps.spoolDir ?? os.tmpdir()
  }

  // ── Self-description ────────────────────────────────────────────────

  async getProviderInfo() {
    return {
      providerId: PROVIDER_ID,
      displayName: DISPLAY_NAME,
      configSchema: SMB_CONFIG_SCHEMA,
      // A share is reachable from every node — the location is not pinned to
      // one node's disk. This is also the flag the orchestrator reads to
      // refuse this provider for `local-path` storage kinds and to refuse
      // `storage.resolve` on its locations (D296), so declaring `true` to
      // obtain statfs-backed capacity would be a lie that disables a safety
      // constraint, not a convenience.
      nodeLocal: false,
      // The share's free space is not visible to CamStack: smbclient's `du`
      // output is not something to build a disk-pressure guard on. A provider
      // that promises a threshold it cannot measure is worse than one that
      // says it cannot — a full NAS surfaces as a write error, not as a
      // pre-emptive refusal.
      shouldSaveDiskSpace: false as const,
      minFreePercent: null,
    }
  }

  /**
   * Validate config + probe connectivity.
   *
   * Three rules, all of them about what this string may contain: it goes
   * straight back on the wire through `storage.testConfig`.
   *  1. Validation errors name the FIELD, never the value — and a username is
   *     half a credential, so it is not interpolated either.
   *  2. Library errors are MAPPED, never forwarded. The raw text is logged.
   *  3. The config object is never logged, at any level.
   */
  async testLocation({ config }: { readonly config: Record<string, unknown> }): Promise<{
    readonly ok: boolean
    readonly error?: string
  }> {
    if (!(await this.binaryAvailable())) {
      return { ok: false, error: new SmbBinaryUnavailableError().message }
    }

    let cfg: SmbConfig
    try {
      cfg = smbConfigFromRecord(config, '(new)')
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    try {
      const client = await this.clientFor(cfg)
      // A directory listing of the base is the cheapest call that proves all
      // three of: the server answered, the credentials were accepted, and the
      // share exists. A missing base directory is NOT a failure — it is
      // created on first write, exactly like the SFTP provider.
      await client.list('')
      return { ok: true }
    } catch (err) {
      this.logger.warn('smb-storage: testLocation failed', {
        meta: {
          host: cfg.host,
          share: cfg.share,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return { ok: false, error: mapSmbError(err) }
    }
  }

  /**
   * Would this candidate config land on a share an existing location already
   * owns? Two records on one directory each run their own retention sweep
   * against a manifest the other also rewrites, so the second one deletes
   * archives the first still lists — and the failure surfaces at RESTORE time,
   * on a file the manifest swears is there.
   *
   * The identity of "the same share" is provider knowledge:
   * `(host, share, basePath)` compared case-insensitively, which no generic
   * uniqueness rule over an opaque `config` record could know.
   *
   * **NOT WIRED YET — say so rather than let the docblock imply otherwise.**
   * Nothing calls this in production. The two surfaces that could are
   * `storage.testConfig` (which passes only `{ providerId, config }`, so it
   * cannot see siblings) and the orchestrator's `upsertLocation` (which can,
   * but reaching a provider-specific method from generic dispatch means either
   * a cast or a new method on the `storage-provider` cap — a cap change, and
   * therefore codegen and a framework release).
   *
   * It ships as a tested predicate because the hazard is real and the identity
   * rule is the part that is easy to get wrong; the plumbing is the cheap part
   * and belongs with the cap change that carries it. Until then, two locations
   * on one share are possible and nothing refuses them.
   */
  findDuplicateShare(
    candidate: Readonly<Record<string, unknown>>,
    candidateId: string,
    existing: readonly StorageLocation[],
  ): StorageLocation | null {
    let candidateIdentity: string
    try {
      candidateIdentity = shareIdentity(smbConfigFromRecord(candidate, candidateId))
    } catch {
      // An unparseable candidate is not a duplicate; the config validation
      // path reports it with a better message than this one could.
      return null
    }
    for (const other of existing) {
      if (other.id === candidateId) continue
      if (other.providerId !== PROVIDER_ID) continue
      try {
        if (shareIdentity(smbConfigFromRecord(other.config, other.id)) === candidateIdentity) {
          return other
        }
      } catch {
        continue
      }
    }
    return null
  }

  // ── Small-file primitives ───────────────────────────────────────────

  /**
   * REFUSES, always.
   *
   * `resolve` exists on the cap to answer "give me a path I can open with
   * node:fs", and there is no such path for a share this provider reaches over
   * the wire. Returning `//nas/backups/camstack` — the shape SFTP, S3 and
   * WebDAV return — is what makes the trap possible in the first place: the
   * caller `fs.readdir`s it and gets either nothing or an unrelated local
   * directory of the same name.
   *
   * The orchestrator already refuses this call before it arrives (D296). This
   * is the second lock, and it is the one that holds if the orchestrator is
   * ever bypassed — the provider itself never hands out a path that is not
   * one.
   */
  async resolve({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<string> {
    this.logger.warn('smb-storage: REFUSED resolve() — an SMB share has no local path', {
      meta: { id: location.id, relativePath },
    })
    throw new Error(
      `smb-storage: location "${location.id}" is a remote SMB share and has no path this node ` +
        `can open with node:fs. Use the storage cap's read/write or chunked upload/download ` +
        `instead of resolving a path.`,
    )
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
    const spool = await this.spoolFile()
    try {
      await fsp.writeFile(spool, data)
      await this.putFile(location, relativePath, spool, data.byteLength)
    } finally {
      await this.discardSpool(spool)
    }
  }

  async read({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<Uint8Array<ArrayBuffer>> {
    const spool = await this.spoolFile()
    try {
      await this.fetchFile(location, relativePath, spool)
      const buf = await fsp.readFile(spool)
      // Narrow `Uint8Array<ArrayBufferLike>` (Node's Buffer) to the
      // `Uint8Array<ArrayBuffer>` the cap declares, by copy.
      const out = new Uint8Array(new ArrayBuffer(buf.byteLength))
      out.set(buf)
      return out
    } finally {
      await this.discardSpool(spool)
    }
  }

  async exists({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<boolean> {
    const entry = await this.statRemote(location, relativePath)
    return entry !== null
  }

  async list({
    location,
    prefix,
  }: {
    readonly location: StorageLocation
    readonly prefix?: string
  }): Promise<readonly string[]> {
    const client = await this.clientForLocation(location)
    const dir = safeSmbRelativePath(prefix ?? '')
    try {
      const entries = await client.list(listMaskFor(dir))
      return entries
        .filter((e) => e.name !== '.' && e.name !== '..')
        .map((e) => (dir === '' ? e.name : `${dir}/${e.name}`))
    } catch (err) {
      // A missing directory lists as nothing. Any OTHER failure must surface:
      // a caller that reads an unreachable share as "no files" is how a
      // retention sweep concludes there is nothing to keep.
      if (isNotFound(err)) return []
      this.logger.warn('smb-storage: list failed', {
        meta: { id: location.id, prefix: dir, error: mapSmbError(err) },
      })
      throw err
    }
  }

  async delete({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<void> {
    const client = await this.clientForLocation(location)
    const target = safeSmbRelativePath(relativePath)
    try {
      await client.deleteFile(target)
    } catch (err) {
      if (isNotFound(err)) {
        this.logger.debug('smb-storage: delete of an already-absent file', {
          meta: { id: location.id, relativePath: target },
        })
        return
      }
      throw err
    }
  }

  /** Always `null` — see `getProviderInfo`. */
  async getAvailableSpace(_input: { readonly location: StorageLocation }): Promise<number | null> {
    return null
  }

  // ── Chunked upload (spool locally, transfer once) ───────────────────

  async beginUpload({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
    readonly sizeBytes?: number
  }): Promise<{ readonly uploadId: string }> {
    await this.assertBinary()
    const target = safeSmbRelativePath(relativePath)
    const uploadId = randomUUID()
    const spoolPath = await this.spoolFile()
    await fsp.writeFile(spoolPath, new Uint8Array(0))
    const session: UploadSession = {
      location,
      relativePath: target,
      spoolPath,
      bytesWritten: 0,
      timer: scheduleIdleAbort(() => {
        this.logger.warn('smb-storage: upload session idle — aborting', {
          meta: { id: location.id, relativePath: target, uploadId },
        })
        void this.abortUpload({ uploadId })
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
    if (!session) throw new Error(`smb-storage: unknown uploadId "${uploadId}"`)
    if (offset !== session.bytesWritten) {
      throw new Error(
        `smb-storage: out-of-order chunk for upload "${uploadId}" — expected offset ` +
          `${session.bytesWritten}, got ${offset}. This provider spools sequentially.`,
      )
    }
    const handle = await fsp.open(session.spoolPath, 'a')
    try {
      await handle.write(data)
    } finally {
      await handle.close()
    }
    session.bytesWritten += data.byteLength
    session.timer = rearmIdleAbort(session.timer, () => {
      this.logger.warn('smb-storage: upload session idle — aborting', {
        meta: { id: session.location.id, relativePath: session.relativePath, uploadId },
      })
      void this.abortUpload({ uploadId })
    })
  }

  /**
   * Transfer the spooled file, then VERIFY it landed at the right size.
   *
   * The sequence is `put` to `<name>.partial`, delete any existing target,
   * rename onto it, stat. Rename-over-existing is not universally permitted on
   * SMB, hence the delete — which means the finalize is NOT atomic: a crash
   * between the delete and the rename destroys the previous file without
   * landing the new one. For the one consumer this has (`backups`, whose
   * archive names are unique per run) the target never exists, so that window
   * is not entered in practice. It is written down because it WOULD be entered
   * by any consumer that overwrites a stable filename.
   */
  async finalizeUpload({ uploadId }: { readonly uploadId: string }): Promise<void> {
    const session = this.uploads.get(uploadId)
    if (!session) throw new Error(`smb-storage: unknown uploadId "${uploadId}"`)
    clearTimeout(session.timer)
    this.uploads.delete(uploadId)
    try {
      await this.putFile(
        session.location,
        session.relativePath,
        session.spoolPath,
        session.bytesWritten,
      )
    } finally {
      await this.discardSpool(session.spoolPath)
    }
  }

  async abortUpload({ uploadId }: { readonly uploadId: string }): Promise<void> {
    const session = this.uploads.get(uploadId)
    if (!session) return
    clearTimeout(session.timer)
    this.uploads.delete(uploadId)
    this.logger.info('smb-storage: upload aborted — nothing was written to the share', {
      meta: {
        id: session.location.id,
        relativePath: session.relativePath,
        bytesSpooled: session.bytesWritten,
      },
    })
    await this.discardSpool(session.spoolPath)
  }

  // ── Chunked download (fetch once, serve ranges locally) ─────────────

  async beginDownload({
    location,
    relativePath,
  }: {
    readonly location: StorageLocation
    readonly relativePath: string
  }): Promise<{ readonly downloadId: string; readonly sizeBytes: number }> {
    const spoolPath = await this.spoolFile()
    let sizeBytes: number
    try {
      await this.fetchFile(location, relativePath, spoolPath)
      const stat = await fsp.stat(spoolPath)
      sizeBytes = stat.size
    } catch (err) {
      await this.discardSpool(spoolPath)
      throw err
    }
    const downloadId = randomUUID()
    this.downloads.set(downloadId, {
      spoolPath,
      sizeBytes,
      timer: scheduleIdleAbort(() => {
        this.logger.warn('smb-storage: download session idle — closing', {
          meta: { id: location.id, relativePath, downloadId },
        })
        void this.endDownload({ downloadId })
      }),
    })
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
    if (!session) throw new Error(`smb-storage: unknown downloadId "${downloadId}"`)
    const handle = await fsp.open(session.spoolPath, 'r')
    try {
      const out = new Uint8Array(new ArrayBuffer(Math.max(0, length)))
      const { bytesRead } = await handle.read(out, 0, out.byteLength, offset)
      session.timer = rearmIdleAbort(session.timer, () => {
        void this.endDownload({ downloadId })
      })
      return bytesRead === out.byteLength ? out : out.slice(0, bytesRead)
    } finally {
      await handle.close()
    }
  }

  async endDownload({ downloadId }: { readonly downloadId: string }): Promise<void> {
    const session = this.downloads.get(downloadId)
    if (!session) return
    clearTimeout(session.timer)
    this.downloads.delete(downloadId)
    await this.discardSpool(session.spoolPath)
  }

  /** Drop every open session. Called from the addon's `onShutdown`. */
  async dispose(): Promise<void> {
    for (const uploadId of [...this.uploads.keys()]) await this.abortUpload({ uploadId })
    for (const downloadId of [...this.downloads.keys()]) await this.endDownload({ downloadId })
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async binaryAvailable(): Promise<boolean> {
    if (this.binaryPresent === true) return true
    this.binaryPresent = await this.hasBinary()
    return this.binaryPresent
  }

  private async assertBinary(): Promise<void> {
    if (await this.binaryAvailable()) return
    throw new SmbBinaryUnavailableError()
  }

  private async clientForLocation(location: StorageLocation): Promise<SmbClientLike> {
    await this.assertBinary()
    return this.clientFor(smbConfigFromRecord(location.config, location.id))
  }

  /**
   * A client scoped to `(host, share, basePath)`.
   *
   * Deliberately NOT pooled. `samba-client` holds no connection between calls
   * — every method spawns a fresh `smbclient` — so a pool would cache an
   * options object and nothing else, while giving the false impression that a
   * session survives. The cost of constructing one is an object literal.
   */
  private async clientFor(cfg: SmbConfig): Promise<SmbClientLike> {
    return this.createClient({
      address: smbAddress(cfg.host, cfg.share),
      timeout: SMB_TIMEOUT_SECONDS,
      maskCmd: true,
      ...(cfg.username !== undefined ? { username: cfg.username } : {}),
      ...(cfg.password !== undefined ? { password: cfg.password } : {}),
      ...(cfg.domain !== undefined ? { domain: cfg.domain } : {}),
      ...(cfg.port !== undefined ? { port: cfg.port } : {}),
      ...(cfg.maxProtocol !== undefined ? { maxProtocol: cfg.maxProtocol } : {}),
      ...(cfg.basePath !== '' ? { directory: cfg.basePath } : {}),
    })
  }

  /**
   * One entry of a remote listing, or `null` when the path does not exist.
   *
   * Goes through {@link listMaskFor} — a bare directory path is NOT a
   * listable argument for smbclient.
   */
  private async statRemote(
    location: StorageLocation,
    relativePath: string,
  ): Promise<SmbItem | null> {
    const client = await this.clientForLocation(location)
    const target = safeSmbRelativePath(relativePath)
    const dir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : ''
    const name = target.includes('/') ? target.slice(target.lastIndexOf('/') + 1) : target
    try {
      const entries = await client.list(listMaskFor(dir))
      return entries.find((e) => e.name.toLowerCase() === name.toLowerCase()) ?? null
    } catch (err) {
      if (isNotFound(err)) return null
      throw err
    }
  }

  /** `put` the local file, then rename onto the target and verify its size. */
  private async putFile(
    location: StorageLocation,
    relativePath: string,
    localPath: string,
    expectedBytes: number,
  ): Promise<void> {
    const client = await this.clientForLocation(location)
    const target = safeSmbRelativePath(relativePath)
    const partial = `${target}.partial`

    await this.ensureRemoteDirs(client, target)
    await client.sendFile(localPath, partial)

    try {
      await client.deleteFile(target)
    } catch (err) {
      if (!isNotFound(err)) throw err
    }
    await client.execute('rename', [partial, target], '')

    const landed = await this.statRemote(location, target)
    if (landed === null) {
      throw new Error(
        `smb-storage: "${target}" is not present on the share after the transfer completed`,
      )
    }
    if (landed.size !== expectedBytes) {
      this.logger.error('smb-storage: size mismatch after upload — the file did NOT land intact', {
        meta: {
          id: location.id,
          relativePath: target,
          expectedBytes,
          landedBytes: landed.size,
        },
      })
      throw new Error(
        `smb-storage: "${target}" landed at ${landed.size} bytes but ${expectedBytes} were sent. ` +
          `Treating the transfer as failed — a returned write is not a durability statement ` +
          `over SMB.`,
      )
    }
  }

  private async fetchFile(
    location: StorageLocation,
    relativePath: string,
    localPath: string,
  ): Promise<void> {
    const client = await this.clientForLocation(location)
    const target = safeSmbRelativePath(relativePath)
    await client.getFile(target, localPath)
  }

  /**
   * `mkdir -p` for the parent chain of a target path. smbclient's `mkdir` is
   * single-level and errors on an existing directory, so this walks the chain
   * and treats every failure as "it is already there" — the subsequent `put`
   * is what actually decides whether the directory exists.
   */
  private async ensureRemoteDirs(client: SmbClientLike, target: string): Promise<void> {
    const segments = pathSegments(target)
    if (segments.length <= 1) return
    let prefix = ''
    for (const segment of segments.slice(0, -1)) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`
      try {
        await client.mkdir(prefix)
      } catch {
        // Already exists, or cannot be created — `put` reports the real error.
      }
    }
  }

  private async spoolFile(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(this.spoolRoot, 'camstack-smb-'))
    return path.join(dir, 'spool.bin')
  }

  private async discardSpool(spoolPath: string): Promise<void> {
    try {
      await fsp.rm(path.dirname(spoolPath), { recursive: true, force: true })
    } catch (err) {
      this.logger.warn('smb-storage: could not remove a spool directory', {
        meta: { spoolPath, error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}

/** smbclient's two "it is not there" statuses. */
function isNotFound(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err)).toUpperCase()
  return (
    text.includes('NT_STATUS_OBJECT_NAME_NOT_FOUND') ||
    text.includes('NT_STATUS_NO_SUCH_FILE') ||
    text.includes('NT_STATUS_OBJECT_PATH_NOT_FOUND')
  )
}

export { normalizedBasePath, shareIdentity }

/**
 * Per-location backup manifest persistence (Task 10 of the storage-
 * unification refactor).
 *
 * Each `backups`-typed `StorageLocation` carries a single
 * `manifests.json` file at its root. The orchestrator reads/appends/
 * writes this file via the consumer-facing `storage` cap — there is
 * no on-disk path coupling, the storage provider (filesystem, SFTP,
 * S3, …) handles dispatch.
 *
 * Concurrency: the orchestrator serializes per-location reads/writes
 * through `withLocationLock` so a fan-out of N parallel destination
 * uploads can't interleave manifest mutations within the same
 * location. Across locations, mutations run in parallel.
 *
 * Wire shape mirrors the spec: each archive entry carries an inline
 * snapshot of the embedded `ArchiveManifest` so `getEntries` can
 * serve the contents preview without re-reading the tarball.
 */
import type { AddonApi, DataStoreDatabase } from '@camstack/types'
import {
  type ArchiveManifest,
  DEFAULT_BACKUP_DATABASES,
} from '../system-backup/system-backup.service.js'

/** File path (relative to the location root) where the index lives. */
export const MANIFESTS_FILENAME = 'manifests.json'

export interface ManifestArchiveEntry {
  readonly id: string
  /** Filename inside the location (e.g. `<id>.tar.gz`). */
  readonly filename: string
  readonly createdAt: number
  readonly sizeBytes: number
  readonly label?: string
  /**
   * Snapshot of the embedded `.camstack-backup-manifest.json`. For an
   * ENCRYPTED archive only its outline (locations, totals, no file list): the
   * destination holds this index in clear, and the file list stays inside the
   * ciphertext.
   */
  readonly manifest: ArchiveManifest
  /** Present when the archive is encrypted to a backup key. */
  readonly encryption?: ManifestArchiveEncryption
  /**
   * The databases the run ASKED to carry — its retention class: archives of one
   * cadence prune each other, never another cadence's (a weekly archive that
   * holds the events ledgers must not be evicted by seven nightly ones).
   * Absent on an entry written before several files were owned: `['settings']`.
   */
  readonly databases?: readonly DataStoreDatabase[]
  /**
   * Ids this build does not know, kept ONLY when no known id remains: such an
   * entry is its own retention class and is never counted or pruned by another
   * cadence (a newer build's database must not collapse to `settings`).
   */
  readonly unrecognisedDatabases?: readonly string[]
}

export interface ManifestArchiveEncryption {
  readonly scheme: string
  readonly keyId: string
}

export interface LocationBackupManifest {
  readonly version: 1
  readonly archives: readonly ManifestArchiveEntry[]
}

/** Subset of `AddonApi['storage']` the manifest store consumes. */
export type ManifestStorageApi = Pick<AddonApi['storage'], 'read' | 'write' | 'exists'>

/**
 * Subset of `AddonApi['storage']` consumed by the chunked-download
 * helper. Sourced from the same generated type so the contract stays
 * in lockstep with the live cap surface.
 */
export type ChunkedDownloadApi = Pick<
  AddonApi['storage'],
  'beginDownload' | 'readChunk' | 'endDownload'
>

/**
 * Read the per-location manifest. Returns an empty manifest on first
 * use (when `manifests.json` doesn't exist) or when the file is
 * unreadable / corrupt — operators see destination state degrade
 * gracefully rather than the orchestrator crashing.
 */
export async function readLocationManifest(
  api: ManifestStorageApi,
  locationId: string,
): Promise<LocationBackupManifest> {
  // `exists` may throw if the storage location config is broken — we
  // treat that the same as `false` and fall through to the empty
  // manifest. Operators see destination state degrade gracefully rather
  // than the orchestrator crashing on a bad backend config.
  const exists = await api.exists
    .query({ location: locationId, relativePath: MANIFESTS_FILENAME })
    .catch(() => false)
  if (!exists) return EMPTY_MANIFEST
  let bytes: Uint8Array
  try {
    bytes = await api.read.query({ location: locationId, relativePath: MANIFESTS_FILENAME })
  } catch {
    return EMPTY_MANIFEST
  }
  return parseManifestBytes(bytes)
}

export async function writeLocationManifest(
  api: ManifestStorageApi,
  locationId: string,
  manifest: LocationBackupManifest,
): Promise<void> {
  const json = JSON.stringify(manifest, null, 2)
  const bytes = new TextEncoder().encode(json)
  await api.write.mutate({
    location: locationId,
    relativePath: MANIFESTS_FILENAME,
    data: bytes,
  })
}

/**
 * Decode the raw bytes of `manifests.json`. Falls back to an empty
 * manifest on JSON-parse / shape-validation failure — same defensive
 * stance as the legacy `LocalBackupService.ensureManifestsLoaded`.
 */
export function parseManifestBytes(bytes: Uint8Array): LocationBackupManifest {
  try {
    const text = new TextDecoder().decode(bytes)
    if (text.trim().length === 0) return EMPTY_MANIFEST
    const parsed: unknown = JSON.parse(text)
    return normalizeManifest(parsed)
  } catch {
    return EMPTY_MANIFEST
  }
}

/**
 * Coerce an arbitrary parsed JSON shape into the canonical manifest
 * type. Bogus archive entries are silently dropped (a corrupt row
 * shouldn't lock the whole location out of operator visibility).
 */
function normalizeManifest(raw: unknown): LocationBackupManifest {
  if (typeof raw !== 'object' || raw == null) return EMPTY_MANIFEST
  const obj = raw as { version?: unknown; archives?: unknown }
  const archives: ManifestArchiveEntry[] = []
  if (Array.isArray(obj.archives)) {
    for (const a of obj.archives) {
      if (typeof a !== 'object' || a == null) continue
      const cand = a as Record<string, unknown>
      if (typeof cand['id'] !== 'string' || typeof cand['filename'] !== 'string') continue
      if (typeof cand['createdAt'] !== 'number' || typeof cand['sizeBytes'] !== 'number') continue
      const manifest = cand['manifest']
      if (typeof manifest !== 'object' || manifest == null) continue
      const entry: ManifestArchiveEntry = {
        id: String(cand['id']),
        filename: String(cand['filename']),
        createdAt: Number(cand['createdAt']),
        sizeBytes: Number(cand['sizeBytes']),
        ...(typeof cand['label'] === 'string' ? { label: cand['label'] } : {}),
        manifest: manifest as ArchiveManifest,
        ...encryptionOf(cand['encryption']),
        ...databasesOf(cand['databases']),
      }
      archives.push(entry)
    }
  }
  return { version: 1, archives }
}

const EMPTY_MANIFEST: LocationBackupManifest = { version: 1, archives: [] }

function databasesOf(raw: unknown): {
  databases?: DataStoreDatabase[]
  unrecognisedDatabases?: string[]
} {
  if (!Array.isArray(raw)) return {}
  const known: DataStoreDatabase[] = []
  const unknown: string[] = []
  for (const item of raw) {
    if (item === 'settings' || item === 'events' || item === 'history') known.push(item)
    else if (typeof item === 'string') unknown.push(item)
  }
  if (known.length > 0) return { databases: known }
  return unknown.length > 0 ? { unrecognisedDatabases: unknown } : {}
}

function encryptionOf(raw: unknown): { encryption?: ManifestArchiveEncryption } {
  if (typeof raw !== 'object' || raw === null) return {}
  const scheme: unknown = Reflect.get(raw, 'scheme')
  const keyId: unknown = Reflect.get(raw, 'keyId')
  if (typeof scheme !== 'string' || typeof keyId !== 'string') return {}
  return { encryption: { scheme, keyId } }
}

/**
 * What the destination's clear-text index may say about an encrypted archive:
 * the outline a restore needs (locations, sizes, the snapshot promise) — not
 * the list of files, which stays inside the ciphertext.
 */
export function outlineOfManifest(manifest: ArchiveManifest): ArchiveManifest {
  return {
    archiveVersion: manifest.archiveVersion,
    createdAt: manifest.createdAt,
    dataDir: manifest.dataDir,
    locations: [...manifest.locations],
    entries: [],
    totalBytes: manifest.totalBytes,
    totalFiles: manifest.totalFiles,
    ...(manifest.omittedDatabases !== undefined
      ? { omittedDatabases: [...manifest.omittedDatabases] }
      : {}),
  }
}

/**
 * Build a `ManifestArchiveEntry` from the raw inputs collected during
 * a successful upload. Pure transform — no I/O — kept here so the
 * triggerBackup path stays terse.
 */
export function buildArchiveEntry(input: {
  id: string
  filename: string
  createdAt: number
  sizeBytes: number
  label?: string
  manifest: ArchiveManifest
  encryption?: ManifestArchiveEncryption
  databases?: readonly DataStoreDatabase[]
}): ManifestArchiveEntry {
  return {
    id: input.id,
    filename: input.filename,
    createdAt: input.createdAt,
    sizeBytes: input.sizeBytes,
    ...(input.label !== undefined ? { label: input.label } : {}),
    manifest: input.encryption !== undefined ? outlineOfManifest(input.manifest) : input.manifest,
    ...(input.encryption !== undefined ? { encryption: input.encryption } : {}),
    ...(input.databases !== undefined ? { databases: [...input.databases] } : {}),
  }
}

/** The key under which archives of one cadence prune each other. */
export function retentionClassOf(
  entry: Pick<ManifestArchiveEntry, 'databases' | 'unrecognisedDatabases'>,
): string {
  if (entry.databases === undefined && entry.unrecognisedDatabases !== undefined) {
    return `?${[...entry.unrecognisedDatabases].toSorted().join('+')}`
  }
  return [...(entry.databases ?? DEFAULT_BACKUP_DATABASES)].toSorted().join('+')
}

/**
 * Pure retention split: given an archive list and the operator's
 * `retentionCount`, return `{ keep, drop }` where `keep` is the most-
 * recent N archives (newest first) and `drop` is the older overflow.
 *
 * `retentionCount <= 0` is treated as "no pruning" — defensive against
 * a config value that would otherwise wipe every archive on the next
 * write.
 *
 * `cadence` (see {@link retentionClassOf}) restricts the count to archives of
 * the run that was just written: nightly archives (settings) and weekly ones
 * (settings + events + history) are retained separately.
 */
export function applyRetention(
  archives: readonly ManifestArchiveEntry[],
  retentionCount: number,
  cadence?: string,
): {
  readonly keep: readonly ManifestArchiveEntry[]
  readonly drop: readonly ManifestArchiveEntry[]
} {
  if (retentionCount <= 0) return { keep: archives, drop: [] }
  const sorted = [...archives].toSorted((a, b) => b.createdAt - a.createdAt)
  // Only archives of the cadence being written compete for its slots; another
  // cadence's archives are neither counted nor dropped.
  const inCadence =
    cadence === undefined ? sorted : sorted.filter((a) => retentionClassOf(a) === cadence)
  if (inCadence.length <= retentionCount) {
    return { keep: sorted, drop: [] }
  }
  const drop = inCadence.slice(retentionCount)
  const dropped = new Set(drop)
  return { keep: sorted.filter((a) => !dropped.has(a)), drop }
}

/**
 * Per-location async mutex. The orchestrator owns one instance and
 * funnels every read-modify-write of `manifests.json` through it so
 * parallel destination uploads (within the same location) commit in
 * arrival order. Across locations the operations run in parallel —
 * each location keys its own promise chain.
 */
export class LocationManifestLock {
  private readonly chains = new Map<string, Promise<void>>()

  async run<T>(locationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(locationId) ?? Promise.resolve()
    let resolveNext!: () => void
    const next = new Promise<void>((res) => {
      resolveNext = res
    })
    // Ensure the chain entry is updated atomically before awaiting.
    this.chains.set(
      locationId,
      previous.then(() => next),
    )
    try {
      await previous
      return await fn()
    } finally {
      resolveNext()
      // Drop the chain entry once it settles to keep the map bounded.
      // We compare identity with `next` so a later run can reset the
      // tail without us clearing it from under them.
      const tail = this.chains.get(locationId)
      if (tail) {
        // Re-walk: if our `next` is the active tail, drop it; otherwise
        // leave the tail in place.
        Promise.resolve(tail)
          .then(() => {
            if (this.chains.get(locationId) === tail) {
              this.chains.delete(locationId)
            }
          })
          .catch(() => {
            /* best-effort cleanup */
          })
      }
    }
  }
}

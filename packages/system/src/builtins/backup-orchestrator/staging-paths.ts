/**
 * Staging-directory placement + boot-time sweep for the backup
 * orchestrator.
 *
 * Placement: the archive build/restore staging dir lives at
 * `<nodeDataDir>/backup-staging` — directly under the node data root,
 * OUTSIDE every location in `DEFAULT_BACKUP_LOCATIONS`, so a backup
 * can never contain a backup by construction (the tar only ever
 * includes listed locations). It is deliberately NOT
 * `<nodeDataDir>/backups`: with `CAMSTACK_BACKUP_ROOT` unset (the
 * Electron app, or a docker host without the env) the default
 * `backups` storage location seeds at exactly that path, and transient
 * build files must never mix into an archive destination. The path is
 * always under the node data root, which every deployment shape
 * already mounts (`/data` volume in the Unraid template and
 * docker-compose, `CAMSTACK_DATA=<userData>/data` in Electron) — no
 * template change required.
 *
 * Sweep: staging holds only transient files — an archive being built
 * (deleted in `triggerBackup`'s `finally`) or a downloaded restore
 * archive (consumed by the boot-time apply hook, which never deletes
 * it). A crash mid-fanout leaks the build archive; every completed
 * restore leaks its download. The orchestrator sweeps the dir on every
 * init, sparing only a file a pending-restore marker still points at.
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'

/** Basename of the staging dir under the node data root. */
export const STAGING_DIR_NAME = 'backup-staging'

/** Canonical staging dir for a node data root. */
export function resolveStagingDir(nodeDataDir: string): string {
  return path.join(nodeDataDir, STAGING_DIR_NAME)
}

export interface StagingSweepResult {
  /** Top-level staging entries removed. */
  readonly removedCount: number
  /** File bytes reclaimed (recursive for removed subdirectories). */
  readonly freedBytes: number
  /** Entries spared because `keepPaths` named them. */
  readonly keptCount: number
}

export interface DirectoryFootprint {
  readonly present: boolean
  readonly totalBytes: number
  readonly fileCount: number
}

/**
 * Delete every top-level entry of `stagingDir` except those whose
 * resolved path appears in `keepPaths`. Per-entry failures are logged
 * and skipped — a locked file must not abort the sweep. A missing
 * staging dir is a clean no-op.
 */
export async function sweepStagingDir(input: {
  stagingDir: string
  keepPaths: readonly string[]
  logger: IScopedLogger
}): Promise<StagingSweepResult> {
  const keep = new Set(input.keepPaths.map((p) => path.resolve(p)))
  let entries: string[]
  try {
    entries = await fsp.readdir(input.stagingDir)
  } catch {
    return { removedCount: 0, freedBytes: 0, keptCount: 0 }
  }
  let removedCount = 0
  let freedBytes = 0
  let keptCount = 0
  for (const name of entries) {
    const abs = path.join(input.stagingDir, name)
    if (keep.has(path.resolve(abs))) {
      keptCount++
      continue
    }
    try {
      const footprint = await measureDirectoryFootprint(abs)
      await fsp.rm(abs, { recursive: true, force: true })
      removedCount++
      freedBytes += footprint.totalBytes
    } catch (err) {
      input.logger.warn('backup staging sweep: entry removal failed — skipping', {
        meta: {
          path: abs,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }
  return { removedCount, freedBytes, keptCount }
}

/**
 * Recursive size + file count of a path (file or directory). Absent
 * path → `present: false` with zeros. Used by the sweep to report
 * reclaimed bytes and by the orchestrator to surface the legacy
 * staging dir's footprint without touching it.
 */
export async function measureDirectoryFootprint(dir: string): Promise<DirectoryFootprint> {
  let stat: fs.Stats
  try {
    stat = await fsp.stat(dir)
  } catch {
    return { present: false, totalBytes: 0, fileCount: 0 }
  }
  if (!stat.isDirectory()) {
    return { present: true, totalBytes: stat.size, fileCount: 1 }
  }
  let totalBytes = 0
  let fileCount = 0
  let children: string[]
  try {
    children = await fsp.readdir(dir)
  } catch {
    return { present: true, totalBytes: 0, fileCount: 0 }
  }
  for (const child of children) {
    const nested = await measureDirectoryFootprint(path.join(dir, child))
    totalBytes += nested.totalBytes
    fileCount += nested.fileCount
  }
  return { present: true, totalBytes, fileCount }
}

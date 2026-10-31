/**
 * The boot-time restore of a PRE-MIGRATION snapshot (D986). The sqlite-settings
 * owner writes `.pending-restore.json`'s sibling marker; the launcher promotes
 * the snapshot over the database before any runner starts, so nothing holds the
 * file open (D679). It is its own marker, not a field of the system-restore one:
 * that one is owned by the backup service and carries an archive.
 *
 * Marker: `{ requests: [{ livePath, snapshotPath }] }`, both relative to the
 * data dir. The snapshot is COPIED (temp file + rename) and kept, so the same
 * restore can be asked for again. The launcher has no `@camstack/*` imports.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SQLITE_SIDECAR_SUFFIXES } from './sqlite-restore.js'

export const PRE_MIGRATION_RESTORE_MARKER = '.pending-migration-restore.json'

interface RestoreRequest {
  readonly livePath: string
  readonly snapshotPath: string
}

function isRequest(value: unknown): value is RestoreRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'livePath' in value &&
    typeof value.livePath === 'string' &&
    'snapshotPath' in value &&
    typeof value.snapshotPath === 'string'
  )
}

function requestsOf(raw: string): readonly RestoreRequest[] | null {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return null
  if (!('requests' in parsed) || !Array.isArray(parsed.requests)) return null
  const requests: unknown[] = parsed.requests
  return requests.every(isRequest) ? requests.filter(isRequest) : null
}

function inside(dataDir: string, relative: string): string | null {
  const root = path.resolve(dataDir)
  const full = path.resolve(root, relative)
  return full === root || full.startsWith(root + path.sep) ? full : null
}

function fsyncDirectory(dir: string): void {
  const fd = fs.openSync(dir, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Apply the marker if present. Never throws: a launcher that threw would fail every boot. */
export function applyPendingPreMigrationRestore(
  dataDir: string,
  log: (line: string) => void,
): void {
  const markerPath = path.join(dataDir, PRE_MIGRATION_RESTORE_MARKER)
  if (!fs.existsSync(markerPath)) return
  let requests: readonly RestoreRequest[] | null
  try {
    requests = requestsOf(fs.readFileSync(markerPath, 'utf-8'))
  } catch (err) {
    log(`[launcher] Pre-migration restore marker malformed — leaving in place: ${String(err)}`)
    return
  }
  if (requests === null) {
    log('[launcher] Pre-migration restore marker malformed — leaving in place')
    return
  }
  let allDone = true
  for (const request of requests) {
    const live = inside(dataDir, request.livePath)
    const snapshot = inside(dataDir, request.snapshotPath)
    if (live === null || snapshot === null) {
      log(`[launcher] Pre-migration restore: ${request.livePath} is outside the data dir — refused`)
      allDone = false
      continue
    }
    if (!fs.existsSync(snapshot)) {
      log(`[launcher] Pre-migration restore: snapshot ${request.snapshotPath} is missing`)
      allDone = false
      continue
    }
    try {
      for (const suffix of SQLITE_SIDECAR_SUFFIXES) fs.rmSync(live + suffix, { force: true })
      const temp = `${live}.restore-tmp`
      fs.copyFileSync(snapshot, temp)
      fs.renameSync(temp, live)
      try {
        fsyncDirectory(path.dirname(live))
      } catch (err) {
        log(
          `[launcher] WARNING Pre-migration restore: could not fsync (${String(err)}) — continuing`,
        )
      }
      log(`[launcher] Pre-migration restore: ${request.snapshotPath} → ${request.livePath}`)
    } catch (err) {
      log(`[launcher] Pre-migration restore of ${request.livePath} failed: ${String(err)}`)
      allDone = false
    }
  }
  if (allDone) fs.rmSync(markerPath, { force: true })
}

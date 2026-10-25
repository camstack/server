/**
 * The boot-time system restore — the ONLY restore there is. The launcher calls
 * it before the addon installer and before any runner starts, so nothing has a
 * file of the data dir open.
 *
 * Marker contract is owned by `SystemBackupService.scheduleRestoreMarker`
 * (`packages/system/src/builtins/system-backup`) — read inline here so the
 * launcher stays free of `@camstack/*` runtime imports. Schema:
 *   { archivePath: string, requestedAt: number, source: string, locations?: string[] }
 *
 * After the extraction, SQLite databases get their own step
 * (`sqlite-restore.ts`, D693): an owner snapshot is promoted over its database,
 * and a sidecar the archive did not bring is dropped, because SQLite would
 * replay a stale `-wal` onto the restored file.
 *
 * Failure modes:
 *   - marker malformed → log + leave it in place (operator visibility)
 *   - archive missing  → log + clear marker (auto-recover from stale)
 *   - tar fails        → throw → launcher exits non-zero, marker preserved
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as tar from 'tar'
import {
  applySqliteRestore,
  missingPromisedSnapshots,
  planSqliteRestore,
} from './sqlite-restore.js'

/** Path of the manifest file embedded inside every archive. */
const ARCHIVE_MANIFEST_NAME = '.camstack-backup-manifest.json'

const RESTORE_MARKER_FILE = '.pending-restore.json'

/**
 * Apply a pending system-restore archive over `dataDir` if a marker is
 * present. Runs BEFORE the addon installer so the restored snapshot's
 * `addons/` folder is what `ensureRequiredPackages` picks up.
 */
export async function applyPendingRestore(
  dataDir: string,
  log: (line: string) => void,
): Promise<void> {
  const markerPath = path.join(dataDir, RESTORE_MARKER_FILE)
  if (!fs.existsSync(markerPath)) return

  log(`[launcher] Pending restore marker found at ${markerPath}`)
  let archivePath: string | null = null
  let locations: string[] | null = null
  try {
    const raw = fs.readFileSync(markerPath, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed != null) {
      if ('archivePath' in parsed && typeof parsed.archivePath === 'string') {
        archivePath = parsed.archivePath
      }
      if (
        'locations' in parsed &&
        Array.isArray(parsed.locations) &&
        parsed.locations.every((l: unknown) => typeof l === 'string')
      ) {
        locations = parsed.locations.filter((l: unknown): l is string => typeof l === 'string')
      }
    }
  } catch (err) {
    log(`[launcher] Restore marker malformed — leaving in place: ${String(err)}`)
    return
  }

  if (archivePath == null) {
    log('[launcher] Restore marker missing archivePath — clearing')
    fs.rmSync(markerPath, { force: true })
    return
  }

  if (!fs.existsSync(archivePath)) {
    log(`[launcher] Restore archive ${archivePath} missing — clearing marker`)
    fs.rmSync(markerPath, { force: true })
    return
  }

  const scope = locations ? ` (only: ${locations.join(', ')})` : ''
  log(`[launcher] Restoring snapshot from ${archivePath} into ${dataDir}${scope}`)
  fs.mkdirSync(dataDir, { recursive: true })

  const allowedPrefixes = locations
    ? locations.map((loc) => loc.replace(/^\.\//, '').replace(/\/+$/, ''))
    : null
  const inScope = (normalized: string): boolean =>
    !allowedPrefixes ||
    allowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))
  // What the archive says it carries — read before the extraction, from the
  // manifest `createArchive` writes as the archive's FIRST entry.
  const promised = await readPromisedSnapshots(archivePath, log)
  // Every path this extraction writes — the SQLite step decides from it alone.
  const extracted: string[] = []
  await tar.extract({
    file: archivePath,
    cwd: dataDir,
    filter: (p) => {
      if (p === ARCHIVE_MANIFEST_NAME || p === `./${ARCHIVE_MANIFEST_NAME}`) return false
      const normalized = p.replace(/^\.\//, '').replace(/\/+$/, '')
      const keep = inScope(normalized)
      if (keep) extracted.push(normalized)
      return keep
    },
  })
  applySqliteRestore(dataDir, planSqliteRestore(extracted), log)
  // A database the archive promised and the extraction did not write was NOT
  // restored. Say so before "Restore complete" — silence would read as done.
  const { missing, outOfScope } = missingPromisedSnapshots(promised, extracted, inScope)
  for (const rel of missing) {
    log(
      `[launcher] WARNING Restore: the archive promised the database snapshot ${rel} but carried none — that database was NOT restored`,
    )
  }
  for (const rel of outOfScope) {
    log(
      `[launcher] Restore: the database snapshot ${rel} is outside the chosen locations — that database was left as it was`,
    )
  }
  fs.rmSync(markerPath, { force: true })
  log('[launcher] Restore complete; marker cleared')
}

/**
 * The `sqliteSnapshots[].snapshotPath` the archive's manifest lists. Reads only
 * up to the manifest (the first entry) and stops. An archive with no manifest,
 * or one from before D693, promises nothing.
 */
function readPromisedSnapshots(
  archivePath: string,
  log: (line: string) => void,
): Promise<readonly string[]> {
  return new Promise<readonly string[]>((resolve) => {
    let settled = false
    const done = (paths: readonly string[]): void => {
      if (settled) return
      settled = true
      reader.destroy()
      resolve(paths)
    }
    const chunks: Buffer[] = []
    const parser = new tar.Parser({
      onReadEntry: (entry) => {
        const name = entry.path.replace(/^\.\//, '')
        if (name !== ARCHIVE_MANIFEST_NAME) {
          entry.resume()
          return
        }
        entry.on('data', (chunk: Buffer) => chunks.push(chunk))
        entry.on('end', () => done(promisedIn(Buffer.concat(chunks).toString('utf-8'), log)))
      },
    })
    parser.on('end', () => done([]))
    const reader = fs.createReadStream(archivePath)
    reader.on('error', () => done([]))
    reader.pipe(parser)
  })
}

function promisedIn(json: string, log: (line: string) => void): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null || !('sqliteSnapshots' in parsed)) return []
    const list = parsed.sqliteSnapshots
    if (!Array.isArray(list)) return []
    const out: string[] = []
    for (const item of list) {
      if (
        typeof item === 'object' &&
        item !== null &&
        'snapshotPath' in item &&
        typeof item.snapshotPath === 'string'
      ) {
        out.push(item.snapshotPath)
      }
    }
    return out
  } catch (err) {
    log(`[launcher] Restore: the archive manifest could not be read — ${String(err)}`)
    return []
  }
}

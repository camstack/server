/**
 * Writes the marker the launcher reads to promote a pre-migration snapshot
 * (`server/backend/src/pre-migration-restore.ts`). The launcher has no
 * `@camstack/*` imports, so the contract is a plain JSON file, written here with
 * paths relative to the data dir. Requests accumulate: a second restore for
 * another database must not erase the first.
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { PreMigrationRestoreRequest } from './migration-engine.js'

export const PRE_MIGRATION_RESTORE_MARKER = '.pending-migration-restore.json'

interface MarkerRequest {
  readonly livePath: string
  readonly snapshotPath: string
}

function isMarkerRequest(value: unknown): value is MarkerRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'livePath' in value &&
    typeof value.livePath === 'string' &&
    'snapshotPath' in value &&
    typeof value.snapshotPath === 'string'
  )
}

async function existingRequests(markerPath: string): Promise<readonly MarkerRequest[]> {
  let raw: string
  try {
    raw = await fsp.readFile(markerPath, 'utf-8')
  } catch {
    return []
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || !('requests' in parsed)) return []
  const requests: unknown = parsed.requests
  return Array.isArray(requests) ? requests.filter(isMarkerRequest) : []
}

export async function scheduleMigrationRestore(
  dataRoot: string,
  request: PreMigrationRestoreRequest,
): Promise<void> {
  const markerPath = path.join(dataRoot, PRE_MIGRATION_RESTORE_MARKER)
  const live = path.relative(dataRoot, request.livePath)
  const snapshot = path.relative(dataRoot, request.snapshotPath)
  const kept = (await existingRequests(markerPath)).filter((entry) => entry.livePath !== live)
  const body = JSON.stringify({ requests: [...kept, { livePath: live, snapshotPath: snapshot }] })
  const temp = `${markerPath}.tmp`
  await fsp.writeFile(temp, body, { mode: 0o600 })
  await fsp.rename(temp, markerPath)
}

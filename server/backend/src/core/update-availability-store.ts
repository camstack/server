/**
 * Durable backing for {@link UpdateAvailabilityEmitter}'s dedup state.
 *
 * The emitter's whole job is "announce a (package, version) ONCE". Keeping
 * that in RAM meant every hub restart re-announced everything the operator had
 * already seen — and hubs restart on every framework update, which is exactly
 * the moment the list is longest.
 *
 * The mechanism is deliberately the one the neighbouring update code already
 * uses: a small JSON file under the node's data dir, next to
 * `auto-update.json` and `.restart-pending`. No new
 * database, no settings-store dependency (the emitter runs on the AGENT too,
 * where the hub's SQLite settings store does not exist).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { UpdateAvailablePayload } from './update-availability-emitter.js'

/** The emitter's two maps, in a JSON-round-trippable shape. */
export interface UpdateAvailabilityState {
  readonly latestByKey: Readonly<Record<string, string>>
  readonly held: Readonly<Record<string, UpdateAvailablePayload>>
}

export interface IUpdateAvailabilityStore {
  /** Previously persisted state, or `null` when there is none/it is unreadable. */
  load(): UpdateAvailabilityState | null
  save(state: UpdateAvailabilityState): void
}

/** Directory under the data dir that holds one file per emitter scope. */
export const UPDATE_AVAILABILITY_DIR = 'update-availability'

/**
 * One file per emitter scope (`addon-packages`, `server-update`,
 * `agent-update`) so two emitters in the same process never overwrite each
 * other's dedup state.
 */
export class FileUpdateAvailabilityStore implements IUpdateAvailabilityStore {
  readonly filePath: string

  constructor(
    dataDir: string,
    private readonly scopeId: string,
    private readonly logger: IScopedLogger,
  ) {
    this.filePath = path.join(dataDir, UPDATE_AVAILABILITY_DIR, `${scopeId}.json`)
  }

  load(): UpdateAvailabilityState | null {
    try {
      if (!fs.existsSync(this.filePath)) return null
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      return parseState(parsed)
    } catch (error: unknown) {
      // A corrupt file must not look like "nothing was ever announced" AND
      // must not crash boot. It re-announces once, then heals on the next save.
      this.logger.warn('Update-availability state unreadable; starting from empty', {
        meta: { scopeId: this.scopeId, path: this.filePath, error: errMsg(error) },
      })
      return null
    }
  }

  save(state: UpdateAvailabilityState): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
      fs.renameSync(tmp, this.filePath)
    } catch (error: unknown) {
      // Losing a write degrades to the old RAM-only behaviour (a re-announce
      // after restart) — never a failed update check.
      this.logger.warn('Failed to persist update-availability state', {
        meta: { scopeId: this.scopeId, path: this.filePath, error: errMsg(error) },
      })
    }
  }
}

function parseState(raw: unknown): UpdateAvailabilityState | null {
  if (raw === null || typeof raw !== 'object') return null
  const latestRaw: unknown = Reflect.get(raw, 'latestByKey')
  const heldRaw: unknown = Reflect.get(raw, 'held')
  if (latestRaw === null || typeof latestRaw !== 'object') return null
  if (heldRaw === null || typeof heldRaw !== 'object') return null

  const latestByKey: Record<string, string> = {}
  for (const [key, value] of Object.entries(latestRaw)) {
    if (typeof value === 'string') latestByKey[key] = value
  }
  const held: Record<string, UpdateAvailablePayload> = {}
  for (const [key, value] of Object.entries(heldRaw)) {
    const candidate = parseCandidate(value)
    if (candidate !== null) held[key] = candidate
  }
  return { latestByKey, held }
}

function parseCandidate(raw: unknown): UpdateAvailablePayload | null {
  if (raw === null || typeof raw !== 'object') return null
  const target: unknown = Reflect.get(raw, 'target')
  const packageName: unknown = Reflect.get(raw, 'packageName')
  const currentVersion: unknown = Reflect.get(raw, 'currentVersion')
  const latestVersion: unknown = Reflect.get(raw, 'latestVersion')
  const nodeId: unknown = Reflect.get(raw, 'nodeId')
  if (target !== 'addon' && target !== 'server') return null
  if (typeof packageName !== 'string') return null
  if (typeof currentVersion !== 'string') return null
  if (typeof latestVersion !== 'string') return null
  return {
    target,
    packageName,
    currentVersion,
    latestVersion,
    ...(typeof nodeId === 'string' ? { nodeId } : {}),
  }
}

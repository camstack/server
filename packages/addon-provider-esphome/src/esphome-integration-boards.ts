import { randomUUID } from 'node:crypto'
import {
  collectKeychainStoredKeys,
  errMsg,
  isSecretMarker,
  isSecretMarkerLike,
  REDACTED_SECRET,
  type IScopedLogger,
} from '@camstack/types'
import {
  buildIntegrationFormSchema,
  connectionOfRow,
  espBoardRowSchema,
  rowOfEntry,
  type EspBoardRow,
  type EspBrokerEntry,
  type EspConnection,
} from './config.js'

/** The keychain paths of a board row (`boards[id].encryptionKey`, `boards[id].password`), read off the form. */
export const BOARD_SECRET_PATHS: readonly string[] = [
  ...collectKeychainStoredKeys(buildIntegrationFormSchema()),
]

/** One integration as the list answers it. */
export interface EspIntegrationRef {
  readonly id: string
  readonly addonId: string
  readonly enabled: boolean
}

/** `integrations.*`, called as the owning addon: reads answer resolved values. */
export interface EspBoardsApi {
  listIntegrations(): Promise<readonly EspIntegrationRef[]>
  getSettings(integrationId: string): Promise<Record<string, unknown>>
  /** Saves without respawning the addon: the caller reconciles in-process. */
  setSettings(input: {
    readonly id: string
    readonly settings: Record<string, unknown>
    readonly secretKeys: string[]
    readonly skipRestart: true
  }): Promise<unknown>
}

/** The live sessions the registry keeps: one per board. */
export interface EspBoardSessions {
  list(): readonly { readonly id: string }[]
  createEntry(
    name: string,
    connection: EspConnection,
    options: { readonly id: string; readonly integrationId: string },
  ): Promise<unknown>
  updateEntry(id: string, connection: EspConnection): Promise<void>
  removeEntry(id: string): Promise<void>
  hasSameConnection(id: string, connection: Readonly<EspConnection>): boolean
}

/** The records the single-board layout kept (secrets resolved). Read for the one-off migration only. */
export interface EspLegacyBoards {
  listResolved(): Promise<EspBrokerEntry[]>
  remove(ids: readonly string[]): Promise<void>
}

export interface EspIntegrationBoardsDeps {
  readonly addonId: string
  readonly api: EspBoardsApi
  readonly sessions: EspBoardSessions
  readonly legacy: EspLegacyBoards
  /** Remove every device adopted from a board that left its integration. */
  readonly cascadeRemoveDevices: (boardId: string) => Promise<void>
  readonly logger: IScopedLogger
}

/** What a board asks the operator-facing add function for. */
export interface AddBoardInput {
  readonly host: string
  readonly port?: number
  readonly name?: string
  readonly encryptionKey?: string
  readonly password?: string
}

export interface MigrationReport {
  /** Boards moved into their integration's list. */
  readonly migrated: readonly string[]
  /** Old records with no integration pointing at them: left untouched. */
  readonly unlinked: readonly string[]
}

interface ParsedBoards {
  readonly entries: readonly EspBrokerEntry[]
  readonly problems: readonly { readonly id: string | null; readonly reason: string }[]
}

function isLocked(value: unknown): boolean {
  return isSecretMarker(value) || isSecretMarkerLike(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an integration's `boards` list. A row that cannot run is reported, never half-used. */
export function parseBoards(
  integrationId: string,
  settings: Record<string, unknown>,
): ParsedBoards {
  const raw = settings['boards']
  if (!Array.isArray(raw)) return { entries: [], problems: [] }
  const entries: EspBrokerEntry[] = []
  const problems: { id: string | null; reason: string }[] = []
  for (const item of raw) {
    const id = isRecord(item) && typeof item['id'] === 'string' ? item['id'] : null
    if (!isRecord(item)) {
      problems.push({ id, reason: 'not a board row' })
      continue
    }
    // A secret the keychain cannot serve reads as its marker: running on it
    // would open the board with a wrong key, and blanking it would erase it.
    if (isLocked(item['encryptionKey']) || isLocked(item['password'])) {
      problems.push({ id, reason: 'secret unavailable' })
      continue
    }
    const parsed = espBoardRowSchema.safeParse(item)
    if (!parsed.success) {
      problems.push({ id, reason: 'invalid row' })
      continue
    }
    const row = parsed.data
    entries.push({
      id: row.id,
      name: row.name.length > 0 ? row.name : row.host,
      connection: connectionOfRow(row),
      integrationId,
    })
  }
  return { entries, problems }
}

function rowsOf(settings: Record<string, unknown>): Record<string, unknown>[] {
  const raw = settings['boards']
  return Array.isArray(raw) ? raw.filter(isRecord) : []
}

/**
 * The boards of the ESPHome integrations: one session per board, each board its
 * own container device. The integration's `boards` list is the only source; a
 * reconcile starts, restarts or stops exactly the boards whose row changed.
 */
export class EspIntegrationBoards {
  private current = new Map<string, EspBrokerEntry>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: EspIntegrationBoardsDeps) {}

  /** Every board that has a session. */
  boards(): readonly EspBrokerEntry[] {
    return [...this.current.values()]
  }

  /** The boards of one integration. */
  boardsOf(integrationId: string): readonly EspBrokerEntry[] {
    return this.boards().filter((b) => b.integrationId === integrationId)
  }

  /** Serialised: two triggers never interleave their reads and their session changes. */
  reconcile(): Promise<void> {
    return this.enqueue(() => this.reconcileNow())
  }

  /**
   * Move every single-board integration to a one-entry list, keeping the board id
   * (so its devices stay) and both secrets. An old record is deleted only after
   * the row is read back with the same secrets; a failed step changes nothing.
   */
  migrateLegacy(): Promise<MigrationReport> {
    return this.enqueue(() => this.migrateNow())
  }

  /**
   * Add a board to an integration (the network scan calls this for every board
   * the operator picked). Idempotent on host and port. Saves the list, then
   * reconciles: only the new board connects.
   */
  addBoard(integrationId: string, input: AddBoardInput): Promise<EspBrokerEntry> {
    return this.enqueue(async () => {
      const settings = await this.requireOwnSettings(integrationId)
      const port = input.port ?? 6053
      const known = parseBoards(integrationId, settings).entries.find(
        (b) => b.connection.host === input.host && b.connection.port === port,
      )
      if (known !== undefined) return known
      const row: EspBoardRow = {
        id: `esp_${randomUUID().slice(0, 8)}`,
        host: input.host,
        port,
        name: input.name ?? '',
        encryptionKey: input.encryptionKey ?? '',
        password: input.password ?? '',
      }
      await this.saveRows(integrationId, [...rowsOf(settings), row])
      await this.reconcileNow()
      const added = this.current.get(row.id)
      if (added === undefined) throw new Error(`ESPHome board ${row.id} did not start`)
      return added
    })
  }

  /** Remove a board from its integration: only that board disconnects, its devices go. */
  removeBoard(integrationId: string, boardId: string): Promise<void> {
    return this.enqueue(async () => {
      const settings = await this.requireOwnSettings(integrationId)
      const rows = rowsOf(settings)
      const kept = rows.filter((r) => r['id'] !== boardId)
      if (kept.length === rows.length) return
      await this.saveRows(integrationId, kept)
      await this.reconcileNow()
    })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch((): undefined => undefined)
    return next
  }

  private async requireOwnSettings(integrationId: string): Promise<Record<string, unknown>> {
    const mine = (await this.deps.api.listIntegrations()).find(
      (i) => i.id === integrationId && i.addonId === this.deps.addonId,
    )
    if (mine === undefined) throw new Error(`'${integrationId}' is not an ESPHome integration`)
    return this.deps.api.getSettings(integrationId)
  }

  private async saveRows(
    integrationId: string,
    rows: readonly Record<string, unknown>[],
  ): Promise<void> {
    await this.deps.api.setSettings({
      id: integrationId,
      settings: { boards: [...rows] },
      secretKeys: [...BOARD_SECRET_PATHS],
      skipRestart: true,
    })
  }

  private async reconcileNow(): Promise<void> {
    const { api, sessions, logger } = this.deps
    const mine = (await api.listIntegrations()).filter((i) => i.addonId === this.deps.addonId)
    const desired = new Map<string, EspBrokerEntry>()
    const known = new Set<string>()
    let unreadable = false
    for (const integration of mine) {
      let settings: Record<string, unknown>
      try {
        settings = await api.getSettings(integration.id)
      } catch (err: unknown) {
        // A failed read changes nothing: the boards of this integration keep running.
        unreadable = true
        for (const board of this.boardsOf(integration.id)) {
          known.add(board.id)
          desired.set(board.id, board)
        }
        logger.warn('ESPHome reconcile: integration settings unreadable, its boards are kept', {
          tags: { integrationId: integration.id },
          meta: { error: errMsg(err) },
        })
        continue
      }
      const { entries, problems } = parseBoards(integration.id, settings)
      for (const problem of problems) {
        if (problem.id !== null) known.add(problem.id)
        logger.warn('ESPHome reconcile: board row not started', {
          tags: { integrationId: integration.id },
          meta: { boardId: problem.id, reason: problem.reason },
        })
      }
      for (const entry of entries) {
        known.add(entry.id)
        if (!integration.enabled) continue
        if (desired.has(entry.id)) {
          logger.warn('ESPHome reconcile: board id used twice, the second row is ignored', {
            tags: { integrationId: integration.id },
            meta: { boardId: entry.id },
          })
          continue
        }
        desired.set(entry.id, entry)
      }
    }

    for (const live of sessions.list()) {
      if (desired.has(live.id)) continue
      try {
        await sessions.removeEntry(live.id)
        this.current.delete(live.id)
        if (!known.has(live.id) && !unreadable) await this.deps.cascadeRemoveDevices(live.id)
      } catch (err: unknown) {
        logger.warn('ESPHome reconcile: stopping a board failed', {
          meta: { boardId: live.id, error: errMsg(err) },
        })
      }
    }

    const liveIds = new Set(sessions.list().map((s) => s.id))
    for (const entry of desired.values()) {
      try {
        if (!liveIds.has(entry.id)) {
          await sessions.createEntry(entry.name, entry.connection, {
            id: entry.id,
            integrationId: entry.integrationId ?? '',
          })
        } else if (!sessions.hasSameConnection(entry.id, entry.connection)) {
          await sessions.updateEntry(entry.id, entry.connection)
        }
        this.current.set(entry.id, entry)
      } catch (err: unknown) {
        logger.warn('ESPHome reconcile: starting a board failed', {
          meta: { boardId: entry.id, error: errMsg(err) },
        })
      }
    }
  }

  private async migrateNow(): Promise<MigrationReport> {
    const { api, legacy, logger } = this.deps
    const records = await legacy.listResolved()
    if (records.length === 0) return { migrated: [], unlinked: [] }
    const mine = (await api.listIntegrations()).filter((i) => i.addonId === this.deps.addonId)
    const done = new Set<string>()
    const referenced = new Set<string>()
    for (const integration of mine) {
      let settings: Record<string, unknown>
      try {
        settings = await api.getSettings(integration.id)
      } catch (err: unknown) {
        logger.warn('ESPHome migration: integration settings unreadable, left for the next boot', {
          tags: { integrationId: integration.id },
          meta: { error: errMsg(err) },
        })
        continue
      }
      const brokerId = settings['brokerId']
      const record =
        typeof brokerId === 'string' ? records.find((r) => r.id === brokerId) : undefined
      if (record === undefined) continue
      referenced.add(record.id)
      // A record whose keychain value could not be served reads as the redaction
      // token: copying it would replace the real key with a placeholder.
      if (
        record.connection.noisePsk === REDACTED_SECRET ||
        record.connection.password === REDACTED_SECRET
      ) {
        logger.warn(
          "ESPHome migration: the old record's secret is unavailable, left for the next boot",
          {
            tags: { integrationId: integration.id },
            meta: { boardId: record.id },
          },
        )
        continue
      }
      try {
        const rows = rowsOf(settings)
        if (!rows.some((r) => r['id'] === record.id)) {
          await this.saveRows(integration.id, [...rows, { ...rowOfEntry(record) }])
        }
        const back = parseBoards(
          integration.id,
          await api.getSettings(integration.id),
        ).entries.find((b) => b.id === record.id)
        const intact =
          back !== undefined &&
          back.connection.noisePsk === record.connection.noisePsk &&
          back.connection.password === record.connection.password &&
          back.connection.host === record.connection.host
        if (intact) done.add(record.id)
        else {
          logger.warn('ESPHome migration: the saved row does not match the old record, kept', {
            tags: { integrationId: integration.id },
            meta: { boardId: record.id },
          })
        }
      } catch (err: unknown) {
        logger.warn('ESPHome migration: moving a board failed, left for the next boot', {
          tags: { integrationId: integration.id },
          meta: { boardId: record.id, error: errMsg(err) },
        })
      }
    }
    if (done.size > 0) await legacy.remove([...done])
    const unlinked = records.filter((r) => !referenced.has(r.id)).map((r) => r.id)
    if (unlinked.length > 0) {
      logger.warn('ESPHome migration: boards without an integration are left as they are', {
        meta: { boardIds: unlinked },
      })
    }
    return { migrated: [...done], unlinked }
  }
}

import { randomUUID } from 'node:crypto'
import {
  errMsg,
  isSecretMarker,
  isSecretMarkerLike,
  REDACTED_SECRET,
  type IScopedLogger,
} from '@camstack/types'
import {
  connectionOfRow,
  espBoardRowSchema,
  type EspBoardRow,
  type EspBrokerEntry,
  type EspConnection,
} from './config.js'
import type { EspBoardsStore } from './esphome-instances.js'

/** One integration as the list answers it. */
export interface EspIntegrationRef {
  readonly id: string
  readonly addonId: string
  readonly enabled: boolean
}

/** `integrations.list`, called as the owning addon: the registry rows (the on/off switch lives there). */
export interface EspBoardsApi {
  listIntegrations(): Promise<readonly EspIntegrationRef[]>
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

export interface EspIntegrationBoardsDeps {
  readonly addonId: string
  readonly api: EspBoardsApi
  readonly sessions: EspBoardSessions
  /** The integrations' records: the only place the board rows live. */
  readonly store: EspBoardsStore
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

interface ParsedBoards {
  readonly entries: readonly EspBrokerEntry[]
  readonly problems: readonly { readonly id: string | null; readonly reason: string }[]
}

function isLocked(value: unknown): boolean {
  return isSecretMarker(value) || isSecretMarkerLike(value) || value === REDACTED_SECRET
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an integration's board rows. A row that cannot run is reported, never half-used. */
export function parseBoards(
  integrationId: string,
  raw: readonly Record<string, unknown>[],
): ParsedBoards {
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

/**
 * The boards of the ESPHome integrations: one session per board, each board its
 * own container device. The integration's record `boards` list is the only source; a
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
   * Add a board to an integration (the network scan calls this for every board
   * the operator picked). Idempotent on host and port. Saves the list, then
   * reconciles: only the new board connects.
   */
  addBoard(integrationId: string, input: AddBoardInput): Promise<EspBrokerEntry> {
    return this.enqueue(async () => {
      const rows = await this.requireOwnRows(integrationId)
      const port = input.port ?? 6053
      const known = parseBoards(integrationId, rows).entries.find(
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
      await this.saveRows(integrationId, [...rows, row])
      await this.reconcileNow()
      const added = this.current.get(row.id)
      if (added === undefined) throw new Error(`ESPHome board ${row.id} did not start`)
      return added
    })
  }

  /**
   * Replace the encryption key of an existing board. The caller passes a key it
   * actually READ: a failed read never reaches here, so an existing key is only
   * ever replaced by a value, never cleared (D49). Only that board reconnects.
   */
  setBoardKey(
    integrationId: string,
    boardId: string,
    key: string,
  ): Promise<'set' | 'unchanged' | 'missing'> {
    return this.enqueue(async () => {
      const rows = await this.requireOwnRows(integrationId)
      const target = rows.find((r) => r['id'] === boardId)
      if (target === undefined) return 'missing'
      if (target['encryptionKey'] === key) return 'unchanged'
      await this.saveRows(
        integrationId,
        rows.map((r) => (r['id'] === boardId ? { ...r, encryptionKey: key } : r)),
      )
      await this.reconcileNow()
      return 'set'
    })
  }

  /** Remove a board from its integration: only that board disconnects, its devices go. */
  removeBoard(integrationId: string, boardId: string): Promise<void> {
    return this.enqueue(async () => {
      const rows = await this.requireOwnRows(integrationId)
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

  private async requireOwnRows(integrationId: string): Promise<readonly Record<string, unknown>[]> {
    const mine = (await this.deps.api.listIntegrations()).find(
      (i) => i.id === integrationId && i.addonId === this.deps.addonId,
    )
    if (mine === undefined) throw new Error(`'${integrationId}' is not an ESPHome integration`)
    return this.deps.store.read(integrationId)
  }

  private async saveRows(
    integrationId: string,
    rows: readonly Record<string, unknown>[],
  ): Promise<void> {
    await this.deps.store.write(integrationId, rows)
  }

  private async reconcileNow(): Promise<void> {
    const { api, store, sessions, logger } = this.deps
    const mine = (await api.listIntegrations()).filter((i) => i.addonId === this.deps.addonId)
    const desired = new Map<string, EspBrokerEntry>()
    const known = new Set<string>()
    let unreadable = false
    for (const integration of mine) {
      let rows: readonly Record<string, unknown>[]
      try {
        rows = await store.read(integration.id)
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
      const { entries, problems } = parseBoards(integration.id, rows)
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
}

/**
 * A real SQLite `addon-settings` table in the canonical layout (id `<addonId>.<key>`, data
 * `{ addonId, key, value }`, a node row also `nodeId`) behind a ledger host that does what the
 * engine does with an owner's result: a `plan` is applied after its precondition is re-read
 * against the table, a `procedure` outcome is recorded as reported.
 */
import {
  type AddonMigration,
  type AddonMigrationHost,
  defineAddonMigrations,
  type IScopedLogger,
  type MigrationOwnerResult,
  preconditionOf,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'

const TABLE = 'addon-settings'

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

export interface SettingsRows {
  /** The raw read of the addon's rows, markers kept: each of `keys` that has a row. */
  readStored(keys: readonly string[]): Promise<Record<string, unknown>>
  /** Write one key of the addon as the settings writer would (a node row carries `nodeId`). */
  write(key: string, value: unknown): void
  remove(key: string): void
}

export interface SettingsFixture {
  readonly rows: () => Record<string, Record<string, unknown>>
  readonly boot: () => Promise<{
    readonly failed: readonly string[]
    readonly applied: readonly string[]
  }>
}

export function settingsFixture<TPorts>(input: {
  readonly addonId: string
  readonly catalogue: readonly AddonMigration<TPorts>[]
  /** Bare and node keys to seed, `value` as stored. */
  readonly seed: Readonly<Record<string, unknown>>
  /** A neighbour addon's row of the same key, which no migration of this addon may touch. */
  readonly neighbour: string
  readonly ports: (rows: SettingsRows) => TPorts
}): SettingsFixture {
  const { addonId } = input
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE "${TABLE}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)`)
  const upsert = db.prepare(`INSERT OR REPLACE INTO "${TABLE}" (id, data) VALUES (?, ?)`)
  const dataOf = (owner: string, key: string, value: unknown): string => {
    const at = key.indexOf('@')
    return JSON.stringify(
      at > 0
        ? { addonId: owner, key, value, nodeId: key.slice(at + 1) }
        : { addonId: owner, key, value },
    )
  }
  const write = (key: string, value: unknown): void =>
    void upsert.run(`${addonId}.${key}`, dataOf(addonId, key, value))
  for (const [key, value] of Object.entries(input.seed)) {
    write(key, value)
    upsert.run(`other-addon.${key}`, dataOf('other-addon', key, input.neighbour))
  }
  const rows = (): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      db
        .prepare(`SELECT id, data FROM "${TABLE}"`)
        .all()
        .flatMap((row) =>
          typeof row === 'object' &&
          row !== null &&
          'id' in row &&
          'data' in row &&
          typeof row.id === 'string' &&
          typeof row.data === 'string'
            ? [[row.id, JSON.parse(row.data)]]
            : [],
        ),
    )
  const readStored = async (keys: readonly string[]): Promise<Record<string, unknown>> => {
    const all = rows()
    return Object.fromEntries(
      keys.flatMap((key) => {
        const row = all[`${addonId}.${key}`]
        return row === undefined ? [] : [[key, Reflect.get(row, 'value')]]
      }),
    )
  }
  const remove = (key: string): void =>
    void db.prepare(`DELETE FROM "${TABLE}" WHERE id = ?`).run(`${addonId}.${key}`)
  const host: AddonMigrationHost = {
    declareOwner: async (declared) => ({
      bootId: 'boot',
      snapshot: 'none' as const,
      steps: declared.metas.map((m) => ({
        id: m.id,
        action: 'run' as const,
        state: 'pending' as const,
      })),
    }),
    startMigration: async () => ({ proceed: true, state: 'pending' as const, reason: null }),
    finishMigration: async ({ result }: { result: MigrationOwnerResult }) => {
      if (result.kind === 'failed') {
        return { status: 'failed' as const, error: result.error, rowsChanged: 0 }
      }
      if (result.kind === 'procedure') {
        return { status: 'applied' as const, error: null, rowsChanged: 0 }
      }
      try {
        let changed = 0
        db.exec('BEGIN')
        for (const edit of result.plan.edits) {
          if (edit.op !== 'setKeys' && edit.op !== 'deleteKeys') {
            throw new Error(`unexpected edit ${edit.op}`)
          }
          if (edit.scope !== TABLE) throw new Error(`no such table ${edit.scope}`)
          const now = rows()
          const ids = edit.op === 'setKeys' ? Object.keys(edit.values) : edit.keys
          const seen = Object.fromEntries(ids.map((id) => [id, now[id] ?? null]))
          if (edit.precondition !== preconditionOf(seen)) throw new Error('precondition mismatch')
          for (const id of ids) {
            if (edit.op === 'setKeys') upsert.run(id, JSON.stringify(edit.values[id]))
            else db.prepare(`DELETE FROM "${TABLE}" WHERE id = ?`).run(id)
            changed += 1
          }
        }
        db.exec('COMMIT')
        return { status: 'applied' as const, error: null, rowsChanged: changed }
      } catch (err) {
        db.exec('ROLLBACK')
        return {
          status: 'failed' as const,
          error: err instanceof Error ? err.message : String(err),
          rowsChanged: 0,
        }
      }
    },
  }
  return {
    rows,
    boot: async () => {
      const report = await runAddonMigrations(
        host,
        defineAddonMigrations(input.catalogue, input.ports({ readStored, write, remove })),
        silentLogger,
      )
      return { failed: report.failed, applied: report.applied }
    },
  }
}

/**
 * A real SQLite `addon-settings` table in the canonical layout (id `<addonId>.<key>`, data
 * `{ addonId, key, value }`), and a ledger host that applies what an owner returns the way the
 * engine does: a plan's precondition is re-read, then its edit lands in one transaction; a
 * procedure is recorded as reported.
 */
import {
  type AddonMigration,
  type AddonMigrationHost,
  defineAddonMigrations,
  type IScopedLogger,
  type MigrationOwnerResult,
  preconditionOf,
  runAddonMigrations,
  type StoredKeyRead,
} from '@camstack/types'
import Database from 'better-sqlite3'

export const ADDON_SETTINGS_TABLE = 'addon-settings'

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

export interface SettingsFixture {
  readonly rows: () => Record<string, Record<string, unknown>>
  /** The addon's write of one key (what a secret-aware state write leaves in the row). */
  readonly writeStored: (key: string, value: unknown) => void
  /** The addon's three-way read of one key. */
  readonly readStored: (key: string) => Promise<StoredKeyRead>
  readonly boot: (afterRead?: () => void) => Promise<{
    readonly failed: readonly string[]
    readonly applied: readonly string[]
  }>
}

export function settingsFixture<TPorts>(
  addonId: string,
  catalogue: readonly AddonMigration<TPorts>[],
  ports: (readStored: (key: string) => Promise<StoredKeyRead>) => TPorts,
  stored: Readonly<Record<string, unknown>>,
  neighbour: string,
): SettingsFixture {
  const db = new Database(':memory:')
  db.exec(
    `CREATE TABLE "${ADDON_SETTINGS_TABLE}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)`,
  )
  const insert = db.prepare(
    `INSERT OR REPLACE INTO "${ADDON_SETTINGS_TABLE}" (id, data) VALUES (?, ?)`,
  )
  for (const [key, value] of Object.entries(stored)) {
    insert.run(`${addonId}.${key}`, JSON.stringify({ addonId, key, value }))
    insert.run(
      `other-addon.${key}`,
      JSON.stringify({ addonId: 'other-addon', key, value: neighbour }),
    )
  }
  const rows = (): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      db
        .prepare(`SELECT id, data FROM "${ADDON_SETTINGS_TABLE}"`)
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
  const readStored = async (key: string): Promise<StoredKeyRead> => {
    const row = rows()[`${addonId}.${key}`]
    return row === undefined
      ? { kind: 'absent' }
      : { kind: 'present', value: Reflect.get(row, 'value') }
  }
  let hook: (() => void) | undefined
  const apply = (result: MigrationOwnerResult) => {
    if (result.kind === 'failed')
      return { status: 'failed' as const, error: result.error, rowsChanged: 0 }
    if (result.kind === 'procedure')
      return { status: 'applied' as const, error: null, rowsChanged: 0 }
    hook?.()
    try {
      let changed = 0
      db.exec('BEGIN')
      for (const edit of result.plan.edits) {
        if (edit.op !== 'setKeys' && edit.op !== 'deleteKeys')
          throw new Error(`unexpected edit ${edit.op}`)
        if (edit.scope !== ADDON_SETTINGS_TABLE) throw new Error(`no such table ${edit.scope}`)
        const keys = edit.op === 'setKeys' ? Object.keys(edit.values) : edit.keys
        const now = rows()
        const seen = Object.fromEntries(keys.map((k) => [k, now[k] ?? null]))
        if (edit.precondition !== preconditionOf(seen)) throw new Error('precondition mismatch')
        for (const key of keys) {
          if (edit.op === 'setKeys') insert.run(key, JSON.stringify(edit.values[key]))
          else db.prepare(`DELETE FROM "${ADDON_SETTINGS_TABLE}" WHERE id = ?`).run(key)
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
  }
  const host: AddonMigrationHost = {
    declareOwner: async (input) => ({
      bootId: 'boot',
      snapshot: 'none' as const,
      steps: input.metas.map((m) => ({
        id: m.id,
        action: 'run' as const,
        state: 'pending' as const,
      })),
    }),
    startMigration: async () => ({ proceed: true, state: 'pending' as const, reason: null }),
    finishMigration: async ({ result }) => apply(result),
  }
  return {
    rows,
    writeStored: (key, value) => {
      insert.run(`${addonId}.${key}`, JSON.stringify({ addonId, key, value }))
    },
    readStored,
    boot: async (afterRead) => {
      hook = afterRead
      const report = await runAddonMigrations(
        host,
        defineAddonMigrations(catalogue, ports(readStored)),
        silentLogger,
      )
      return { failed: report.failed, applied: report.applied }
    },
  }
}

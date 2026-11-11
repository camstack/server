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
  type MigrationMeta,
  type MigrationOwnerResult,
  preconditionOf,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'

const TABLE = 'addon-settings'
const DEVICE_TABLE = 'addon-device-settings'
const TABLES: readonly string[] = [TABLE, DEVICE_TABLE]

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

interface FixtureOutcome {
  readonly status: 'applied' | 'failed'
  readonly error: string | null
  readonly rowsChanged: number
}

export interface SettingsRows {
  /** The raw read of the addon's rows, markers kept: each of `keys` that has a row. */
  readStored(keys: readonly string[]): Promise<Record<string, unknown>>
  /** Write one key of the addon as the settings writer would (a node row carries `nodeId`). */
  write(key: string, value: unknown): void
  remove(key: string): void
  /** The addon's per-device rows of `field` that exist, by device id (`addon-device-settings`). */
  readDeviceField(
    deviceIds: readonly number[],
    field: string,
  ): Promise<ReadonlyMap<number, unknown>>
}

export interface SettingsFixture {
  readonly rows: () => Record<string, Record<string, unknown>>
  /** The `addon-device-settings` rows by id (`<addonId>:<deviceId>.<field>`). */
  readonly deviceRows: () => Record<string, Record<string, unknown>>
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
  /** Per-device fields to seed: device id -> field -> value as stored. */
  readonly deviceSeed?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly ports: (rows: SettingsRows) => TPorts
}): SettingsFixture {
  const { addonId } = input
  const db = new Database(':memory:')
  for (const table of TABLES) {
    db.exec(`CREATE TABLE "${table}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)`)
  }
  const upsert = db.prepare(`INSERT OR REPLACE INTO "${TABLE}" (id, data) VALUES (?, ?)`)
  const upsertDevice = db.prepare(
    `INSERT OR REPLACE INTO "${DEVICE_TABLE}" (id, data) VALUES (?, ?)`,
  )
  for (const [deviceId, fields] of Object.entries(input.deviceSeed ?? {})) {
    for (const [field, value] of Object.entries(fields)) {
      upsertDevice.run(
        `${addonId}:${deviceId}.${field}`,
        JSON.stringify({ addonId, deviceId, key: field, value }),
      )
      upsertDevice.run(
        `other-addon:${deviceId}.${field}`,
        JSON.stringify({
          addonId: 'other-addon',
          deviceId,
          key: field,
          value: input.neighbour,
        }),
      )
    }
  }
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
  const rowsOf = (table: string): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      db
        .prepare(`SELECT id, data FROM "${table}"`)
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
  const rows = (): Record<string, Record<string, unknown>> => rowsOf(TABLE)
  const deviceRows = (): Record<string, Record<string, unknown>> => rowsOf(DEVICE_TABLE)
  const readDeviceField = async (
    deviceIds: readonly number[],
    field: string,
  ): Promise<ReadonlyMap<number, unknown>> => {
    const all = deviceRows()
    return new Map(
      deviceIds.flatMap((id) => {
        const row = all[`${addonId}:${id}.${field}`]
        return row === undefined ? [] : [[id, Reflect.get(row, 'value')] as const]
      }),
    )
  }
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
  const finish = async (result: MigrationOwnerResult): Promise<FixtureOutcome> => {
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
        if (!TABLES.includes(edit.scope)) throw new Error(`no such table ${edit.scope}`)
        const now = rowsOf(edit.scope)
        const ids = edit.op === 'setKeys' ? Object.keys(edit.values) : edit.keys
        const seen = Object.fromEntries(ids.map((id) => [id, now[id] ?? null]))
        if (edit.precondition !== preconditionOf(seen)) throw new Error('precondition mismatch')
        for (const id of ids) {
          if (edit.op === 'setKeys') {
            db.prepare(`INSERT OR REPLACE INTO "${edit.scope}" (id, data) VALUES (?, ?)`).run(
              id,
              JSON.stringify(edit.values[id]),
            )
          } else db.prepare(`DELETE FROM "${edit.scope}" WHERE id = ?`).run(id)
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
  // The engine's gate (`MigrationEngine.start`): a migration runs only once its `dependsOn` and
  // the previous `seq` of its owner are applied. A host that always said "proceed" let a
  // dependent migration run over a predecessor that had failed.
  let declaredMetas: readonly MigrationMeta[] = []
  const settled = new Map<string, 'applied' | 'failed'>()
  const predecessorsOf = (id: string): readonly string[] => {
    const meta = declaredMetas.find((m) => m.id === id)
    if (meta === undefined) return []
    const previous = declaredMetas
      .filter((other) => other.owner === meta.owner && other.seq < meta.seq)
      .sort((a, b) => a.seq - b.seq)
      .at(-1)
    return [...meta.dependsOn, ...(previous === undefined ? [] : [previous.id])]
  }
  const host: AddonMigrationHost = {
    declareOwner: async (declared) => {
      declaredMetas = declared.metas
      settled.clear()
      return {
        bootId: 'boot',
        snapshot: 'none' as const,
        steps: declared.metas.map((m) => ({
          id: m.id,
          action: 'run' as const,
          state: 'pending' as const,
        })),
      }
    },
    startMigration: async ({ id }) => {
      const unmet = predecessorsOf(id).find((dep) => settled.get(dep) !== 'applied')
      if (unmet !== undefined) {
        return {
          proceed: false,
          state: 'blocked' as const,
          reason: `dependency-${settled.get(unmet) ?? 'pending'}:${unmet}`,
        }
      }
      return { proceed: true, state: 'pending' as const, reason: null }
    },
    finishMigration: async ({ id, result }: { id: string; result: MigrationOwnerResult }) => {
      const outcome = await finish(result)
      settled.set(id, outcome.status)
      return outcome
    },
  }
  return {
    rows,
    deviceRows,
    boot: async () => {
      const report = await runAddonMigrations(
        host,
        defineAddonMigrations(
          input.catalogue,
          input.ports({ readStored, write, remove, readDeviceField }),
        ),
        silentLogger,
      )
      return { failed: report.failed, applied: report.applied }
    },
  }
}

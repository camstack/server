/**
 * A real SQLite `addon-settings` table in the canonical layout (id `<addonId>.<key>`, data
 * `{ addonId, key, value }`, a node row also `nodeId`), and a ledger host that applies a returned
 * plan the way the engine does: precondition re-read, then the edit.
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
import { ADDON_SETTINGS_TABLE, type NodeFieldsPorts } from '../node-fields-per-node.js'

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

export interface PerNodeFixture {
  readonly rows: () => Record<string, Record<string, unknown>>
  /** Insert (or replace) a raw row between the plan's read and its apply. */
  readonly insertRow: (id: string, data: Record<string, unknown>) => void
  /** What the plan said it left alone (a twin conflict), across every boot. */
  readonly warnings: string[]
  readonly boot: (afterRead?: () => void) => Promise<{
    readonly failed: readonly string[]
    readonly applied: readonly string[]
  }>
}

export function perNodeFixture(
  addonId: string,
  catalogue: readonly AddonMigration<NodeFieldsPorts>[],
  bare: Readonly<Record<string, unknown>>,
  neighbour: string,
  nodes: readonly string[] = ['hub'],
): PerNodeFixture {
  const db = new Database(':memory:')
  db.exec(
    `CREATE TABLE "${ADDON_SETTINGS_TABLE}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)`,
  )
  const insert = db.prepare(
    `INSERT OR REPLACE INTO "${ADDON_SETTINGS_TABLE}" (id, data) VALUES (?, ?)`,
  )
  for (const [key, value] of Object.entries(bare)) {
    const at = key.indexOf('@')
    insert.run(
      `${addonId}.${key}`,
      JSON.stringify(
        at > 0 ? { addonId, key, value, nodeId: key.slice(at + 1) } : { addonId, key, value },
      ),
    )
    insert.run(
      `other-addon.${key}`,
      JSON.stringify({ addonId: 'other-addon', key, value: neighbour }),
    )
  }
  const remove = db.prepare(`DELETE FROM "${ADDON_SETTINGS_TABLE}" WHERE id = ?`)
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
  /** The raw read the addon's port does: every row of the addon, markers kept. */
  const readStored = async (keys: readonly string[]): Promise<Record<string, unknown>> => {
    const all = rows()
    return Object.fromEntries(
      keys.flatMap((key) => {
        const row = all[`${addonId}.${key}`]
        return row === undefined ? [] : [[key, Reflect.get(row, 'value')]]
      }),
    )
  }
  const warnings: string[] = []
  let hook: (() => void) | undefined
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
    startMigration: async () => ({
      proceed: true,
      state: 'pending' as const,
      reason: null,
    }),
    finishMigration: async ({ result }: { result: MigrationOwnerResult }) => {
      if (result.kind !== 'plan')
        return {
          status: 'failed' as const,
          error: 'not a plan',
          rowsChanged: 0,
        }
      hook?.()
      try {
        let changed = 0
        db.exec('BEGIN')
        for (const edit of result.plan.edits) {
          if (edit.op !== 'setKeys' && edit.op !== 'deleteKeys')
            throw new Error(`unexpected edit ${edit.op}`)
          if (edit.scope !== ADDON_SETTINGS_TABLE) throw new Error(`no such table ${edit.scope}`)
          const now = rows()
          const keys = edit.op === 'setKeys' ? Object.keys(edit.values) : edit.keys
          const seen = Object.fromEntries(keys.map((k) => [k, now[k] ?? null]))
          if (edit.precondition !== preconditionOf(seen)) throw new Error('precondition mismatch')
          for (const key of keys) {
            if (edit.op === 'setKeys') insert.run(key, JSON.stringify(edit.values[key]))
            else remove.run(key)
            changed += 1
          }
        }
        db.exec('COMMIT')
        return {
          status: 'applied' as const,
          error: null,
          rowsChanged: changed,
        }
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
    warnings,
    insertRow: (id, data) => void insert.run(id, JSON.stringify(data)),
    boot: async (afterRead) => {
      hook = afterRead
      const report = await runAddonMigrations(
        host,
        defineAddonMigrations(catalogue, {
          readStored,
          nodeIds: async () => nodes,
          warn: (m) => void warnings.push(m),
        }),
        silentLogger,
      )
      return { failed: report.failed, applied: report.applied }
    },
  }
}

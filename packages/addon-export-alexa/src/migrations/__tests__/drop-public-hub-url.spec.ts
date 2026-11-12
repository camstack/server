/**
 * The addon's global settings live in the canonical `addon-settings` table (one row per key, id
 * `<addonId>.<key>`, data `{ addonId, key, value }`); there is no per-addon scoped table. The retired URL keys are removed through the migration engine's `deleteKeys` edit. The
 * ledger host applies the returned plan to a real SQLite table the way the engine does
 * (precondition re-read, then delete), so the assertions read rows back.
 */
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  type IScopedLogger,
  type MigrationOwnerResult,
  preconditionOf,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { ADDON_SETTINGS_TABLE, ALEXA_ADDON_ID } from '../drop-public-hub-url.js'
import { ADDON_MIGRATIONS, DROP_PUBLIC_HUB_URL_ID } from '../index.js'

const NEIGHBOUR = 'keep-me'
const MARK = [{ deviceId: 7, exposedAt: 1 }]

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

function fixture(initial: Record<string, unknown>) {
  const db = new Database(':memory:')
  db.exec(
    `CREATE TABLE "${ADDON_SETTINGS_TABLE}" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)`,
  )
  const insert = db.prepare(`INSERT INTO "${ADDON_SETTINGS_TABLE}" (id, data) VALUES (?, ?)`)
  const wrap = (addonId: string, key: string, value: unknown): string =>
    JSON.stringify({ addonId, key, value })
  for (const [key, value] of Object.entries(initial)) {
    insert.run(`${ALEXA_ADDON_ID}.${key}`, wrap(ALEXA_ADDON_ID, key, value))
    insert.run(`other-addon.${key}`, wrap('other-addon', key, NEIGHBOUR))
  }
  const rowsOf = (): Record<string, object> =>
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
  /** The addon's global read, the wrappers unwrapped. */
  const read = (): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(rowsOf()).flatMap(([id, row]) =>
        id.startsWith(`${ALEXA_ADDON_ID}.`)
          ? [[id.slice(ALEXA_ADDON_ID.length + 1), Reflect.get(row, 'value')]]
          : [],
      ),
    )
  /** Another addon's rows with the same keys: a migration must leave them alone. */
  const neighbours = (): string[] =>
    Object.keys(rowsOf())
      .filter((id) => id.startsWith('other-addon.'))
      .sort()
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
      let changed = 0
      for (const edit of result.plan.edits) {
        if (edit.op !== 'deleteKeys') throw new Error(`unexpected edit ${edit.op}`)
        const now = rowsOf()
        if (edit.scope !== ADDON_SETTINGS_TABLE) throw new Error(`no such table ${edit.scope}`)
        const seen = Object.fromEntries(edit.keys.map((k) => [k, now[k] ?? null]))
        if (edit.precondition !== preconditionOf(seen)) throw new Error('precondition mismatch')
        const remove = db.prepare(`DELETE FROM "${edit.scope}" WHERE id = ?`)
        for (const key of edit.keys) changed += Number(remove.run(key).changes)
      }
      return { status: 'applied' as const, error: null, rowsChanged: changed }
    },
  }
  const boot = () =>
    runAddonMigrations(
      host,
      defineAddonMigrations(
        ADDON_MIGRATIONS.filter((m) => m.meta.id === DROP_PUBLIC_HUB_URL_ID),
        {
          readStored: async () => read(),
          // This fixture runs the URL migration only; the others are covered by their own spec.
          readRawStored: async () => read(),
          warn: () => undefined,
          listDeviceIds: async () => [],
          readDeviceField: async () => new Map(),
          listSkillIds: async () => [],
          putSkill: async () => 'exists',
          putLinks: async () => 'exists',
          replaceLinks: async () => undefined,
          readLinks: async () => null,
          hasSkill: async () => false,
          putExports: async () => 'exists',
          readExports: async () => null,
          clearOldTokenSecrets: async () => undefined,
          hasInstanceRecords: async () => false,
          putState: async () => 'exists',
          readState: async () => null,
          clearIngressTokenSecret: async () => undefined,
        },
      ),
      silentLogger,
    )
  return { read, neighbours, boot }
}

describe('drop-public-hub-url', () => {
  it('deletes the URL key and keeps the marked neighbour', async () => {
    const { read, neighbours, boot } = fixture({
      publicHubUrl: 'https://hub.example.org',
      exposed: MARK,
    })
    const report = await boot()
    expect(report.failed).toEqual([])
    expect(read()).toEqual({ exposed: MARK })
    expect(neighbours()).toEqual(['other-addon.exposed', 'other-addon.publicHubUrl'])
  })

  it('a second run is a no-op', async () => {
    const { read, boot } = fixture({
      publicHubUrl: 'https://hub.example.org',
      exposed: MARK,
    })
    await boot()
    const second = await boot()
    expect(second.failed).toEqual([])
    expect(read()).toEqual({ exposed: MARK })
  })
})

/**
 * The retired URL keys are removed through the migration engine's `deleteKeys` edit. The
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
import { GOOGLE_SETTINGS_SCOPE } from '../drop-public-hub-url.js'
import { ADDON_MIGRATIONS } from '../index.js'

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
  db.exec(`CREATE TABLE "${GOOGLE_SETTINGS_SCOPE}" (id TEXT PRIMARY KEY, data TEXT)`)
  const insert = db.prepare(`INSERT INTO "${GOOGLE_SETTINGS_SCOPE}" (id, data) VALUES (?, ?)`)
  for (const [key, value] of Object.entries(initial)) insert.run(key, JSON.stringify(value))
  const read = (): Record<string, unknown> =>
    Object.fromEntries(
      db
        .prepare(`SELECT id, data FROM "${GOOGLE_SETTINGS_SCOPE}"`)
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
        const now = read()
        const seen = Object.fromEntries(edit.keys.map((k) => [k, now[k] ?? null]))
        if (edit.precondition !== preconditionOf(seen)) throw new Error('precondition mismatch')
        const remove = db.prepare(`DELETE FROM "${GOOGLE_SETTINGS_SCOPE}" WHERE id = ?`)
        for (const key of edit.keys) changed += Number(remove.run(key).changes)
      }
      return { status: 'applied' as const, error: null, rowsChanged: changed }
    },
  }
  const boot = () =>
    runAddonMigrations(
      host,
      defineAddonMigrations(ADDON_MIGRATIONS, {
        readStored: async () => read(),
      }),
      silentLogger,
    )
  return { read, boot }
}

describe('drop-public-hub-url', () => {
  it('deletes both URL keys and keeps the marked neighbour', async () => {
    const { read, boot } = fixture({
      publicHubUrl: 'https://hub.example.org',
      detectedPublicHubUrl: 'https://hub.example.org',
      exposed: MARK,
    })
    const report = await boot()
    expect(report.failed).toEqual([])
    expect(read()).toEqual({ exposed: MARK })
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

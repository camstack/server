/**
 * The addon's global settings live in the canonical `addon-settings` table (one row per key, id
 * `<addonId>.<key>`). The retired webhook intake keys are removed through the migration engine's
 * `deleteKeys` edit; the ledger host below applies the returned plan to a real SQLite table the way
 * the engine does (precondition re-read, then delete), so the assertions read rows back.
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
import {
  ADDON_SETTINGS_TABLE,
  REOLINK_ADDON_ID,
} from '../migrations/drop-webhook-intake-settings.js'
import { REOLINK_MIGRATIONS } from '../migrations/index.js'

const MARK = { someUnrelatedKey: 'keep-me' }

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
  for (const [key, value] of Object.entries(initial)) {
    insert.run(
      `${REOLINK_ADDON_ID}.${key}`,
      JSON.stringify({ addonId: REOLINK_ADDON_ID, key, value }),
    )
    insert.run(
      `other-addon.${key}`,
      JSON.stringify({ addonId: 'other-addon', key, value: 'neighbour' }),
    )
  }
  const rows = (): Record<string, { value?: unknown }> =>
    Object.fromEntries(
      db
        .prepare(`SELECT id, data FROM "${ADDON_SETTINGS_TABLE}"`)
        .all()
        .map((row) => {
          const { id, data } = row as { id: string; data: string }
          return [id, JSON.parse(data) as { value?: unknown }]
        }),
    )
  const read = (): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(rows()).flatMap(([id, row]) =>
        id.startsWith(`${REOLINK_ADDON_ID}.`)
          ? [[id.slice(REOLINK_ADDON_ID.length + 1), row.value]]
          : [],
      ),
    )
  const neighbours = (): number =>
    Object.keys(rows()).filter((id) => id.startsWith('other-addon.')).length
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
    finishMigration: async ({ result }: { result: MigrationOwnerResult }) => {
      if (result.kind === 'procedure')
        return { status: 'applied' as const, error: null, rowsChanged: 0 }
      if (result.kind !== 'plan')
        return { status: 'failed' as const, error: 'not a plan', rowsChanged: 0 }
      let changed = 0
      for (const edit of result.plan.edits) {
        if (edit.op !== 'deleteKeys') throw new Error(`unexpected edit ${edit.op}`)
        const now = rows()
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
      defineAddonMigrations(REOLINK_MIGRATIONS, {
        readStored: async () => read(),
        readStoredRaw: async () => read(),
        stashPending: async () => undefined,
        warn: () => undefined,
      }),
      silentLogger,
    )
  return { read, neighbours, boot }
}

describe('drop-webhook-intake-settings', () => {
  it('deletes the three intake keys, keeps the marked key and the neighbour addon', async () => {
    const { read, neighbours, boot } = fixture({
      baichuanWebhookEnabled: true,
      baichuanWebhookPort: 9081,
      baichuanWebhookBindHost: '0.0.0.0',
      ...MARK,
    })
    const before = neighbours()
    const report = await boot()
    expect(report.failed).toEqual([])
    expect(read()).toEqual(MARK)
    expect(neighbours()).toBe(before)
  })

  it('a second run is a no-op', async () => {
    const { read, boot } = fixture({ baichuanWebhookPort: 9081, ...MARK })
    await boot()
    const second = await boot()
    expect(second.failed).toEqual([])
    expect(read()).toEqual(MARK)
  })
})

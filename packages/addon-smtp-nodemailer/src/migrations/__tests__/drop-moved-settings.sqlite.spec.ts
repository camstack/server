/**
 * Both SMTP migrations on REAL SQLite, through the real migration engine: the addon's global
 * settings live in the canonical `addon-settings` table (one row per key, id
 * `smtp-nodemailer.<key>`, data `{ addonId, key, value }`), and there is no
 * `smtp-nodemailer:addon-settings` table. The moved keys must go from where they are stored.
 *
 * The engine is the hub's own (`sqlite-storage`), mounted on purpose from the sibling package:
 * a fake store with a different layout is exactly what hid the Loki outage.
 */
import { fileURLToPath } from 'node:url'
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  makeInMemoryRecords,
  runAddonMigrations,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MigrationEngine } from '../../../../system/src/builtins/sqlite-storage/migrations/migration-engine.js'
import { MigrationsProvider } from '../../../../system/src/builtins/sqlite-storage/migrations/migrations-provider.js'
import { openOwnedSqliteFile } from '../../../../system/src/builtins/sqlite-storage/owned-sqlite-file.js'
import { SqliteSnapshotter } from '../../../../system/src/builtins/sqlite-storage/sqlite-snapshotter.js'
import {
  makeHarness,
  recordingLogger,
  type Harness,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/owned-files-harness.js'
import { smtpRelaysKind } from '../../relay-record-kinds.js'
import { ADDON_MIGRATIONS, type SmtpCataloguePorts } from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)
const ADDON = 'smtp-nodemailer'
const wrapper = (addonId: string, key: string, value: unknown): string =>
  JSON.stringify({ addonId, key, value })
const PASSWORD_MARKER = { $secret: 'keychain-ref-1' }

let h: Harness
beforeEach(() => {
  h = makeHarness()
  const seed = new Database(h.pathOf('settings'))
  seed.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const insert = seed.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  insert.run(`${ADDON}.host`, wrapper(ADDON, 'host', 'smtp.example.com'))
  insert.run(`${ADDON}.port`, wrapper(ADDON, 'port', 70000))
  insert.run(`${ADDON}.secure`, wrapper(ADDON, 'secure', 'yes'))
  insert.run(`${ADDON}.username`, wrapper(ADDON, 'username', 'mailer'))
  insert.run(`${ADDON}.password`, wrapper(ADDON, 'password', PASSWORD_MARKER))
  insert.run(`${ADDON}.fromAddress`, wrapper(ADDON, 'fromAddress', 'cam@example.com'))
  insert.run(`${ADDON}.unrelatedMark`, wrapper(ADDON, 'unrelatedMark', true))
  insert.run('other-addon.host', wrapper('other-addon', 'host', 'keep-me'))
  insert.run('other-addon.password', wrapper('other-addon', 'password', 'keep-me-too'))
  seed.close()
})
afterEach(() => {
  h.cleanup()
})

function rows(): Record<string, string> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const all = db.prepare('SELECT id, data FROM "addon-settings"').all()
    return Object.fromEntries(
      all.flatMap((r) =>
        typeof r === 'object' && r !== null && 'id' in r && 'data' in r
          ? [[String(r.id), String(r.data)]]
          : [],
      ),
    )
  } finally {
    db.close()
  }
}

/** Each ledger row as `status`, or `status: error` for a failed one. */
function ledger(): Record<string, string> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const all = db.prepare('SELECT id, status, error FROM _migrations').all()
    return Object.fromEntries(
      all.flatMap((r) =>
        typeof r === 'object' && r !== null && 'id' in r && 'status' in r
          ? [[String(r.id), 'error' in r && r.error ? `${r.status}: ${r.error}` : String(r.status)]]
          : [],
      ),
    )
  } finally {
    db.close()
  }
}

/** The addon's global read, as the settings backend answers it: the wrappers unwrapped. */
function storedValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, data] of Object.entries(rows())) {
    if (!id.startsWith(`${ADDON}.`)) continue
    out[id.slice(`${ADDON}.`.length)] = JSON.parse(data).value
  }
  return out
}

describe('smtp-nodemailer migrations on real SQLite', () => {
  it('moves the relay into a record and removes the moved keys from the canonical table, other rows untouched', async () => {
    const warnings: string[] = []
    const engine = new MigrationEngine({
      logger: recordingLogger(h.lines, 'Migrations'),
      catalogue: [],
      codeVersion: '1.0.0',
      snapshotterFor: (livePath) =>
        new SqliteSnapshotter({
          livePath,
          logger: recordingLogger(h.lines, 'Snapshot'),
          workerPath: SNAPSHOT_WORKER,
          workerExecArgv: ['--import', 'tsx'],
        }),
    })
    await openOwnedSqliteFile(h.specOf('settings'), {
      ...h.deps,
      migrationCatalogue: [],
      afterOpen: async (opened) => {
        await engine.runFile({
          databaseId: opened.databaseId,
          livePath: opened.livePath,
          call: (op, input) => opened.migrate(op, input),
        })
      },
    })
    const provider = new MigrationsProvider(engine)
    const stamp = <T extends object>(input: T): T =>
      Object.assign({}, input, { callerAddonId: ADDON })
    const host: AddonMigrationHost = {
      declareOwner: (input) => provider.declareOwner(stamp(input)),
      startMigration: (input) => provider.startMigration(stamp(input)),
      finishMigration: (input) => provider.finishMigration(stamp(input)),
    }
    const memory = makeInMemoryRecords(ADDON)
    await memory.records.declare({ relays: smtpRelaysKind })
    const handle = memory.records.kind(smtpRelaysKind)
    const ports: SmtpCataloguePorts = {
      // The keychain resolves the marker to the value.
      readStored: async () => ({ ...storedValues(), password: 'pw-plain' }),
      readRawStored: async () => storedValues(),
      warn: (message) => {
        warnings.push(message)
      },
      ensureRelayId: async () => 'relay-0007',
      findRelayId: async () => 'relay-0007',
      putRecord: async (id, body) => {
        await handle.put({ id, data: body }, { ifRev: 0 })
        return 'created'
      },
      readRecord: async (id) => {
        const row = await handle.getResolved(id)
        return row === null
          ? null
          : { host: row.data.host, hasPassword: (row.data.password ?? '').length > 0 }
      },
      clearOldPassword: async () => undefined,
    }
    const report = await runAddonMigrations(
      host,
      defineAddonMigrations(ADDON_MIGRATIONS, ports),
      recordingLogger(h.lines, 'Addon'),
    )
    expect(ledger()).toEqual({
      [`${ADDON}/2026-11-02-connection-to-records`]: 'applied',
      [`${ADDON}/2026-11-02-drop-moved-settings`]: 'applied',
    })
    expect(report.failed ?? []).toEqual([])
    // The record holds the relay, the odd stored values clamped / coerced, the password kept.
    const row = await handle.getResolved('relay-0007')
    expect(row?.data).toMatchObject({
      host: 'smtp.example.com',
      port: 65535,
      secure: false,
      username: 'mailer',
      password: 'pw-plain',
      fromAddress: 'cam@example.com',
    })
    expect(warnings.join(' ')).toContain('clamped to 65535')
    // The moved keys are gone from the canonical table; the addon's own unrelated key and
    // another addon's rows (same key names, one a password) survive byte for byte.
    expect(Object.keys(rows()).sort()).toEqual([
      'other-addon.host',
      'other-addon.password',
      `${ADDON}.unrelatedMark`,
    ])
    expect(rows()['other-addon.host']).toBe(wrapper('other-addon', 'host', 'keep-me'))
    expect(rows()['other-addon.password']).toBe(wrapper('other-addon', 'password', 'keep-me-too'))
  })
})

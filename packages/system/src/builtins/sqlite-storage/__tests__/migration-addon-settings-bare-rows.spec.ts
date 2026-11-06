/**
 * The hub migration that wraps bare `addon-settings` rows into `{ addonId, key, value }`, run by
 * the real engine over a real SQLite file. The four shapes found on a live hub (a bare `[]` at
 * `<addon>.brokers` / `.providers`), a node-scoped bare row, rows that must stay as they are, and
 * the end-to-end reason it exists: an addon plan that rebuilds its precondition as
 * `{ addonId, key, value }` fails over a bare row and applies once the row is wrapped.
 */
import { fileURLToPath } from 'node:url'
import { MigrationPlanSchema, type MigrationPlan, type StoredKeyRead } from '@camstack/types'
import { unwrapStoredValue } from '../../../kernel/prefix-walk.js'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADDON_SETTINGS_BARE_ROWS_MIGRATION,
  ADDON_SETTINGS_BARE_ROWS_MIGRATION_ID,
} from '../../../migrations/hub/2026-11-06-addon-settings-bare-rows.js'
import { MigrationEngine } from '../migrations/migration-engine.js'
import { applyEdits } from '../migrations/migration-edits.js'
import type { HubMigration } from '../migrations/migration-types.js'
import { openOwnedSqliteFile } from '../owned-sqlite-file.js'
import { SqliteSnapshotter } from '../sqlite-snapshotter.js'
import { makeHarness, recordingLogger, type Harness } from './support/owned-files-harness.js'

const SNAPSHOT_WORKER = fileURLToPath(new URL('../sqlite-snapshot-worker.ts', import.meta.url))

let h: Harness

/** What the four live bare rows look like, plus the shapes around them. */
const ROWS: Readonly<Record<string, unknown>> = {
  'auth-oidc.providers': [],
  'google-services.brokers': [],
  'provider-homeassistant.brokers': [],
  'provider-homematic.brokers': [{ id: 'b1', mark: 'kept' }],
  // a bare value on a node-scoped key gets the nodeId a canonical node row carries
  'detector.backend@agent-1': 'npu',
  // a dotted key keeps everything after the FIRST '.' as the key
  'mqtt-broker.a.b': 7,
  // already canonical, with and without a node: untouched
  'detector.threshold': {
    addonId: 'detector',
    key: 'threshold',
    value: 0.5,
    mark: 'c1',
  },
  'detector.mode@agent-3': {
    addonId: 'detector',
    key: 'mode@agent-3',
    value: 'x',
    nodeId: 'agent-3',
  },
  // a bare record with its own `value` field: ambiguous, left alone
  'odd.thing': { value: 1, other: 'bare-record' },
  // a wrapper that lost its value: not bare data, left alone
  'odd.corrupt': { addonId: 'odd', key: 'corrupt' },
  // no '.' in the id: nothing to derive an addon from
  nodot: [1, 2],
}

const REWRITTEN: readonly string[] = [
  'auth-oidc.providers',
  'google-services.brokers',
  'provider-homeassistant.brokers',
  'provider-homematic.brokers',
  'detector.backend@agent-1',
  'mqtt-broker.a.b',
]

function seedDatabase(path: string, rows: Readonly<Record<string, unknown>>): void {
  const seed = new Database(path)
  seed.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  const insert = seed.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  for (const [id, data] of Object.entries(rows)) insert.run(id, JSON.stringify(data))
  seed.close()
}

beforeEach(() => {
  h = makeHarness()
  seedDatabase(h.pathOf('settings'), ROWS)
})
afterEach(() => {
  h.cleanup()
})

function ledgerStatus(): unknown {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    return db
      .prepare<[string], { status: string }>('SELECT status FROM _migrations WHERE id = ?')
      .get(ADDON_SETTINGS_BARE_ROWS_MIGRATION_ID)?.status
  } finally {
    db.close()
  }
}

async function runPass(catalogue: readonly HubMigration[], bootId: string): Promise<void> {
  const engine = new MigrationEngine({
    logger: recordingLogger(h.lines, 'Migrations'),
    catalogue,
    codeVersion: '1.0.0',
    bootId,
    snapshotterFor: (livePath) =>
      new SqliteSnapshotter({
        livePath,
        logger: recordingLogger(h.lines, 'Snapshot'),
        workerPath: SNAPSHOT_WORKER,
        workerExecArgv: ['--import', 'tsx'],
      }),
  })
  const file = await openOwnedSqliteFile(h.specOf('settings'), {
    ...h.deps,
    migrationCatalogue: catalogue,
    afterOpen: async (opened) => {
      await engine.runFile({
        databaseId: opened.databaseId,
        livePath: opened.livePath,
        call: (op, input) => opened.migrate(op, input),
      })
    },
  })
  await file.stop()
}

function rows(): Record<string, unknown> {
  const db = new Database(h.pathOf('settings'), { readonly: true })
  try {
    const out: Record<string, unknown> = {}
    for (const row of db.prepare('SELECT id, data FROM "addon-settings" ORDER BY id').all()) {
      if (
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        'data' in row &&
        typeof row.id === 'string' &&
        typeof row.data === 'string'
      ) {
        out[row.id] = JSON.parse(row.data)
      }
    }
    return out
  } finally {
    db.close()
  }
}

describe('hub migration: bare addon-settings rows become canonical', () => {
  it('wraps the four live shapes, the node-scoped row and the dotted key; reads are unchanged', async () => {
    await runPass([ADDON_SETTINGS_BARE_ROWS_MIGRATION], 'boot-1')
    const after = rows()
    expect(after['google-services.brokers']).toEqual({
      addonId: 'google-services',
      key: 'brokers',
      value: [],
    })
    expect(after['auth-oidc.providers']).toEqual({
      addonId: 'auth-oidc',
      key: 'providers',
      value: [],
    })
    expect(after['provider-homeassistant.brokers']).toEqual({
      addonId: 'provider-homeassistant',
      key: 'brokers',
      value: [],
    })
    expect(after['provider-homematic.brokers']).toEqual({
      addonId: 'provider-homematic',
      key: 'brokers',
      value: [{ id: 'b1', mark: 'kept' }],
    })
    expect(after['detector.backend@agent-1']).toEqual({
      addonId: 'detector',
      key: 'backend@agent-1',
      value: 'npu',
      nodeId: 'agent-1',
    })
    expect(after['mqtt-broker.a.b']).toEqual({
      addonId: 'mqtt-broker',
      key: 'a.b',
      value: 7,
    })
    for (const id of REWRITTEN) expect(unwrapStoredValue(after[id])).toEqual(ROWS[id])
    expect(ledgerStatus()).toBe('applied')
  }, 60_000)

  it('leaves canonical rows, an ambiguous bare record, a corrupt wrapper and an id without a dot as they are', async () => {
    await runPass([ADDON_SETTINGS_BARE_ROWS_MIGRATION], 'boot-1')
    const after = rows()
    for (const id of Object.keys(ROWS).filter((key) => !REWRITTEN.includes(key))) {
      expect(after[id]).toEqual(ROWS[id])
    }
  }, 60_000)

  it('a second pass plans nothing', async () => {
    await runPass([ADDON_SETTINGS_BARE_ROWS_MIGRATION], 'boot-1')
    const first = rows()
    await runPass([ADDON_SETTINGS_BARE_ROWS_MIGRATION], 'boot-2')
    expect(rows()).toEqual(first)
    const db = new Database(h.pathOf('settings'), { readonly: true })
    try {
      expect(ADDON_SETTINGS_BARE_ROWS_MIGRATION).toHaveProperty('plan')
      const plan =
        'plan' in ADDON_SETTINGS_BARE_ROWS_MIGRATION
          ? ADDON_SETTINGS_BARE_ROWS_MIGRATION.plan(db)
          : { edits: [{ op: 'never' }] }
      expect(plan).toEqual({ edits: [] })
    } finally {
      db.close()
    }
  }, 60_000)
})

/** The google addon's ports for the one plan this spec runs (an addon never imports another). */
interface GooglePorts {
  readStored(key: string): Promise<StoredKeyRead>
  listBrokers(): Promise<readonly never[]>
  setBrokerCalendarIds(id: string, ids: readonly string[]): Promise<boolean>
}

/**
 * The REAL google plan, loaded by path: the system package must not import an addon (its rootDir
 * and the rule that addons are not dependencies of the framework), so the module is imported
 * dynamically and its answer is parsed by the plan schema, not cast.
 */
const GOOGLE_PLAN_MODULE = fileURLToPath(
  new URL(
    '../../../../../addon-google-services/src/migrations/drop-config-brokers-and-legacy-oauth.ts',
    import.meta.url,
  ),
)

async function planDropConfigBrokersAndLegacyOauth(ports: GooglePorts): Promise<MigrationPlan> {
  const mod: unknown = await import(/* @vite-ignore */ GOOGLE_PLAN_MODULE)
  const plan: unknown = Reflect.get(mod ?? {}, 'planDropConfigBrokersAndLegacyOauth')
  if (typeof plan !== 'function') throw new Error('the google plan is not exported')
  return MigrationPlanSchema.parse(await plan(ports))
}

describe('why it exists: an addon plan over a bare row', () => {
  /** The google plan's ports over the real file: stored read as the addon reads it (unwrapped). */
  function portsOver(db: Database.Database): GooglePorts {
    return {
      readStored: async (key): Promise<StoredKeyRead> => {
        const row = db
          .prepare<[string], { data: string }>('SELECT data FROM "addon-settings" WHERE id = ?')
          .get(`google-services.${key}`)
        return row === undefined
          ? { kind: 'absent' }
          : { kind: 'present', value: unwrapStoredValue(JSON.parse(row.data)) }
      },
      listBrokers: async () => [],
      setBrokerCalendarIds: async () => true,
    }
  }

  it('fails over the bare google-services.brokers row, applies once the hub migration wrapped it', async () => {
    const before = new Database(h.pathOf('settings'))
    try {
      const plan = await planDropConfigBrokersAndLegacyOauth(portsOver(before))
      expect(plan.edits).toHaveLength(1)
      expect(() => applyEdits(before, plan)).toThrow(/precondition failed for deleteKeys/)
    } finally {
      before.close()
    }

    await runPass([ADDON_SETTINGS_BARE_ROWS_MIGRATION], 'boot-1')

    const wrapped = new Database(h.pathOf('settings'))
    try {
      const plan = await planDropConfigBrokersAndLegacyOauth(portsOver(wrapped))
      applyEdits(wrapped, plan)
      expect(
        wrapped
          .prepare('SELECT 1 FROM "addon-settings" WHERE id = ?')
          .get('google-services.brokers'),
      ).toBeUndefined()
    } finally {
      wrapped.close()
    }
  }, 60_000)
})

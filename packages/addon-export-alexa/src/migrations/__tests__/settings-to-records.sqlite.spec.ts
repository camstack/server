/**
 * The Alexa migrations on REAL SQLite, through the hub's own migration engine: the addon's settings
 * live in the canonical `addon-settings` table (one row per key, id `export-alexa.<key>`, data
 * `{ addonId, key, value }`). The linked accounts and the Amazon push grants must reach the record
 * byte-identical, the old credentials may go only after the record read back the same, and an
 * unrelated key and another addon's rows must stay.
 */
import { fileURLToPath } from 'node:url'
import {
  type AddonMigrationHost,
  defineAddonMigrations,
  makeInMemoryRecords,
  type MigrationOwnerResult,
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
import { ALEXA_INSTANCE_ID, alexaSkillLinksKind, alexaSkillsKind } from '../../skill-records.js'
import {
  ADDON_MIGRATIONS,
  type AlexaCataloguePorts,
  DROP_MOVED_SETTINGS_ID,
  LEDGERS_TO_INTEGRATION_ID,
  SETTINGS_TO_INTEGRATION_ID,
} from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)
const ADDON = 'export-alexa'
const wrapper = (addonId: string, key: string, value: unknown): string =>
  JSON.stringify({ addonId, key, value })

const ACCESS_MARKER = { $secret: 'ref-access-u1' }
const REFRESH_MARKER = { $secret: 'ref-refresh-u1' }
const ACCOUNTS = [
  { userId: 'amzn1.u1', username: 'alice', linkedAt: 1700000000000 },
  { userId: 'amzn1.u2', username: 'bob', linkedAt: 1700000001234 },
]
/** The ledger as the keychain resolves it. */
const TOKENS_RESOLVED = [
  {
    userId: 'amzn1.u1',
    accessToken: 'Atza|access-plain',
    refreshToken: 'Atzr|refresh-plain',
    expiresAt: 1800000000000,
    receivedAt: 1700000002000,
  },
]
/** The same ledger as stored: credentials are markers. */
const TOKENS_STORED = [
  { ...TOKENS_RESOLVED[0], accessToken: ACCESS_MARKER, refreshToken: REFRESH_MARKER },
]

const LEGACY: Record<string, unknown> = {
  skillMode: 'custom',
  region: 'EU',
  expectedAudience: 'amzn1.ask.skill.abc',
  detectionSensors: false,
  objectDetection: true,
  snapshots: false,
  enforceIngressToken: true,
  linkedAccounts: ACCOUNTS,
  tokens: TOKENS_STORED,
  exposed: [{ deviceId: 7, marker: 'keep-me' }],
}

let h: Harness
function seed(values: Record<string, unknown>): void {
  const db = new Database(h.pathOf('settings'))
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  for (const [key, value] of Object.entries(values)) {
    insert.run(`${ADDON}.${key}`, wrapper(ADDON, key, value))
  }
  insert.run('other-addon.skillMode', wrapper('other-addon', 'skillMode', 'keep-me'))
  insert.run('other-addon.tokens', wrapper('other-addon', 'tokens', ['keep-me-too']))
  db.close()
}
beforeEach(() => {
  h = makeHarness()
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

function storedValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, data] of Object.entries(rows())) {
    if (!id.startsWith(`${ADDON}.`)) continue
    out[id.slice(`${ADDON}.`.length)] = JSON.parse(data).value
  }
  return out
}

/** The keychain: the token markers read as their credentials. */
function resolved(): Record<string, unknown> {
  const stored = storedValues()
  const tokens = stored['tokens']
  return Array.isArray(tokens) && tokens.length > 0
    ? { ...stored, tokens: TOKENS_RESOLVED }
    : stored
}

function deleteRow(key: string): void {
  // `clearSecrets(['tokens'])` removes the key from the settings; here the row goes the same way.
  const db = new Database(h.pathOf('settings'))
  try {
    db.prepare('DELETE FROM "addon-settings" WHERE id = ?').run(`${ADDON}.${key}`)
  } finally {
    db.close()
  }
}

interface Options {
  /** The link record's read-back answers with this access token instead of the one stored. */
  readonly readBackAccessToken?: string
  readonly readFails?: boolean
  /** A link record is already there, with these accounts and no grants. */
  readonly existingLinks?: boolean
}

async function boot(options: Options = {}) {
  const warnings: string[] = []
  const calls: string[] = []
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
  await memory.records.declare({ skills: alexaSkillsKind, 'skill-links': alexaSkillLinksKind })
  const skills = memory.records.kind(alexaSkillsKind)
  const links = memory.records.kind(alexaSkillLinksKind)
  if (options.existingLinks === true) {
    await links.put(
      {
        id: ALEXA_INSTANCE_ID,
        data: { name: 'Mine', linkedAccounts: [ACCOUNTS[0] ?? ACCOUNTS[1]!], tokens: [] },
      },
      { ifRev: 0 },
    )
  }
  const ports: AlexaCataloguePorts = {
    readStored: async () => {
      calls.push('read-stored')
      if (options.readFails === true) throw new Error('keychain locked')
      return resolved()
    },
    readRawStored: async () => storedValues(),
    warn: (message) => {
      warnings.push(message)
    },
    putSkill: async (body) => {
      if ((await skills.get(ALEXA_INSTANCE_ID)) !== null) return 'exists'
      calls.push('put-skill')
      await skills.put({ id: ALEXA_INSTANCE_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    putLinks: async (body) => {
      if ((await links.get(ALEXA_INSTANCE_ID)) !== null) return 'exists'
      calls.push('put-links')
      await links.put({ id: ALEXA_INSTANCE_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    replaceLinks: async (body) => {
      calls.push('replace-links')
      await links.put({ id: ALEXA_INSTANCE_ID, data: body })
    },
    readLinks: async () => {
      calls.push('read-back')
      const row = await links.getResolved(ALEXA_INSTANCE_ID)
      if (row === null) return null
      const tokens = row.data.tokens.map((t) =>
        options.readBackAccessToken === undefined
          ? t
          : { ...t, accessToken: options.readBackAccessToken },
      )
      return { ...row.data, tokens }
    },
    hasSkill: async () => (await skills.get(ALEXA_INSTANCE_ID)) !== null,
    clearOldTokenSecrets: async () => {
      calls.push('clear:tokens')
      deleteRow('tokens')
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const runCatalogue = () => runAddonMigrations(host, bound, recordingLogger(h.lines, 'Addon'))
  const execute = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { skills, links, calls, warnings, runCatalogue, execute }
}

describe('export-alexa migrations on real SQLite', () => {
  it('moves settings and ledgers into records, drops the moved keys and keeps the rest', async () => {
    seed(LEGACY)
    const w = await boot()
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    const done = ledger()
    for (const id of [
      SETTINGS_TO_INTEGRATION_ID,
      LEDGERS_TO_INTEGRATION_ID,
      DROP_MOVED_SETTINGS_ID,
    ]) {
      expect(done[id]).toBe('applied')
    }
    const skill = await w.skills.get(ALEXA_INSTANCE_ID)
    expect(skill?.data).toMatchObject({
      skillMode: 'custom',
      region: 'EU',
      expectedAudience: 'amzn1.ask.skill.abc',
      detectionSensors: false,
      objectDetection: true,
      snapshots: false,
      enforceIngressToken: true,
    })
    const after = rows()
    // The moved keys are gone; the unrelated marked key and another addon's rows stay.
    expect(Object.keys(after).sort()).toEqual(
      [`${ADDON}.exposed`, 'other-addon.skillMode', 'other-addon.tokens'].sort(),
    )
    expect(after[`${ADDON}.exposed`]).toBe(wrapper(ADDON, 'exposed', LEGACY['exposed']))
    expect(after['other-addon.tokens']).toBe(wrapper('other-addon', 'tokens', ['keep-me-too']))
  })

  it('round-trips the ledgers byte-identical, reads the record back, and only then clears', async () => {
    seed(LEGACY)
    const w = await boot()
    await w.execute(SETTINGS_TO_INTEGRATION_ID)
    await w.execute(LEDGERS_TO_INTEGRATION_ID)
    expect(w.calls).toEqual([
      'read-stored',
      'put-skill',
      'read-stored',
      'put-links',
      'read-back',
      'clear:tokens',
    ])
    const row = await w.links.getResolved(ALEXA_INSTANCE_ID)
    expect(row?.data.linkedAccounts).toEqual(ACCOUNTS)
    expect(row?.data.tokens).toEqual(TOKENS_RESOLVED)
  })

  it('keeps the old credentials when the record does not read back identical', async () => {
    seed(LEGACY)
    const w = await boot({ readBackAccessToken: 'something-else' })
    expect(await w.execute(LEDGERS_TO_INTEGRATION_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('does not match') as string,
    })
    expect(w.calls).not.toContain('clear:tokens')
    expect(storedValues()['tokens']).toEqual(TOKENS_STORED)
    expect(w.warnings.join(' ')).toContain('legacy ledgers are kept')
  })

  it('never overwrites an existing link record and keeps the old credentials', async () => {
    seed(LEGACY)
    const w = await boot({ existingLinks: true })
    expect(await w.execute(LEDGERS_TO_INTEGRATION_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    const row = await w.links.get(ALEXA_INSTANCE_ID)
    expect(row?.data.name).toBe('Mine')
    expect(w.calls).not.toContain('put-links')
    expect(w.calls).not.toContain('clear:tokens')
    expect(storedValues()['tokens']).toEqual(TOKENS_STORED)
  })

  it('a second run is already-done and writes nothing', async () => {
    seed(LEGACY)
    const w = await boot()
    await w.runCatalogue()
    const before = rows()
    for (const id of [SETTINGS_TO_INTEGRATION_ID, LEDGERS_TO_INTEGRATION_ID]) {
      expect(await w.execute(id)).toMatchObject({ result: { outcome: 'already-done' } })
    }
    expect(await w.execute(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'plan',
      plan: { edits: [] },
    })
    expect(rows()).toEqual(before)
  })

  it('a failed read of the old settings writes nothing and the legacy keys stay', async () => {
    seed(LEGACY)
    const before = rows()
    const w = await boot({ readFails: true })
    expect(await w.execute(LEDGERS_TO_INTEGRATION_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('keychain locked') as string,
    })
    expect(w.calls).toEqual(['read-stored'])
    expect(await w.links.get(ALEXA_INSTANCE_ID)).toBeNull()
    expect(rows()).toEqual(before)
  })

  it('the drop refuses while no record exists, then deletes nothing', async () => {
    seed(LEGACY)
    const w = await boot()
    expect(await w.execute(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no Alexa skill record') as string,
    })
    expect(Object.keys(rows())).toContain(`${ADDON}.tokens`)
  })

  it('the drop refuses while the old settings still carry the push credentials', async () => {
    seed(LEGACY)
    const w = await boot()
    await w.execute(SETTINGS_TO_INTEGRATION_ID)
    await w.execute(LEDGERS_TO_INTEGRATION_ID)
    // Put the unverified credentials back, as if the clear never ran.
    const db = new Database(h.pathOf('settings'))
    db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)').run(
      `${ADDON}.tokens`,
      wrapper(ADDON, 'tokens', TOKENS_STORED),
    )
    db.close()
    expect(await w.execute(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('still carry') as string,
    })
    expect(Object.keys(rows())).toContain(`${ADDON}.tokens`)
  })
})

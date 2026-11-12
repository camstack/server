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
import {
  ALEXA_INSTANCE_ID,
  alexaSkillExportsKind,
  alexaSkillLinksKind,
  alexaSkillsKind,
  alexaSkillStateKind,
  type SkillStateBody,
} from '../../skill-records.js'
import {
  ADDON_MIGRATIONS,
  type AlexaCataloguePorts,
  DROP_MOVED_SETTINGS_ID,
  DROP_MOVED_STATE_ID,
  LEDGERS_TO_INTEGRATION_ID,
  SETTINGS_TO_INTEGRATION_ID,
  STATE_TO_INSTANCE_ID,
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

const INGRESS_MARKER = { $secret: 'ref-ingress' }
const INGRESS_PLAIN = 'ingress-token-plain-0123456789'

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
  unrelatedKey: { 7: ['keep-me'] },
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
  const withTokens =
    Array.isArray(tokens) && tokens.length > 0 ? { ...stored, tokens: TOKENS_RESOLVED } : stored
  return 'ingressToken' in withTokens && typeof withTokens['ingressToken'] === 'object'
    ? { ...withTokens, ingressToken: INGRESS_PLAIN }
    : withTokens
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
  /** The state record already exists, with this body. */
  readonly existingState?: SkillStateBody
  /** The state record reads back with this ingress token instead of the one written. */
  readonly stateReadBackToken?: string
  readonly stateReadFails?: boolean
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
  await memory.records.declare({
    skills: alexaSkillsKind,
    'skill-links': alexaSkillLinksKind,
    'skill-exports': alexaSkillExportsKind,
    'skill-state': alexaSkillStateKind,
  })
  const states = memory.records.kind(alexaSkillStateKind)
  if (options.existingState !== undefined) {
    await states.put({ id: ALEXA_INSTANCE_ID, data: options.existingState }, { ifRev: 0 })
  }
  const exposure = memory.records.kind(alexaSkillExportsKind)
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
    listDeviceIds: async () => [],
    readDeviceField: async () => new Map(),
    listSkillIds: async () => [],
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
    putExports: async (body) => {
      if ((await exposure.get(ALEXA_INSTANCE_ID)) !== null) return 'exists'
      await exposure.put({ id: ALEXA_INSTANCE_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    readExports: async () => (await exposure.get(ALEXA_INSTANCE_ID))?.data ?? null,
    hasSkill: async () => (await skills.get(ALEXA_INSTANCE_ID)) !== null,
    clearOldTokenSecrets: async () => {
      calls.push('clear:tokens')
      deleteRow('tokens')
    },
    hasInstanceRecords: async () =>
      (await links.get(ALEXA_INSTANCE_ID)) !== null ||
      (await exposure.get(ALEXA_INSTANCE_ID)) !== null,
    putState: async (body) => {
      if ((await states.get(ALEXA_INSTANCE_ID)) !== null) return 'exists'
      calls.push('put-state')
      await states.put({ id: ALEXA_INSTANCE_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    readState: async () => {
      calls.push('read-state')
      if (options.stateReadFails === true) throw new Error('keychain locked')
      const row = await states.getResolved(ALEXA_INSTANCE_ID)
      if (row === null) return null
      return options.stateReadBackToken === undefined
        ? row.data
        : { ...row.data, ingressToken: options.stateReadBackToken }
    },
    clearIngressTokenSecret: async () => {
      calls.push('clear:ingressToken')
      deleteRow('ingressToken')
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const runCatalogue = () => runAddonMigrations(host, bound, recordingLogger(h.lines, 'Addon'))
  const execute = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { skills, links, states, calls, warnings, runCatalogue, execute }
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
      [`${ADDON}.unrelatedKey`, 'other-addon.skillMode', 'other-addon.tokens'].sort(),
    )
    expect(after[`${ADDON}.unrelatedKey`]).toBe(
      wrapper(ADDON, 'unrelatedKey', LEGACY['unrelatedKey']),
    )
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

/** The state a skill carried before the move: the credential is a keychain marker in the settings. */
const STATE_LEGACY: Record<string, unknown> = {
  ...LEGACY,
  ingressToken: INGRESS_MARKER,
  visionNamespace: 'cs-ns-1',
  detectionClasses: { 7: { classes: ['person'], missingSince: 1700000000000 } },
  accountVisibility: { 'amzn1.u1': { all: false, pendingRemoval: [7] } },
  exportedEndpoints: { 7: ['ep-a', 'ep-b'] },
  exportedSignatures: { 'ep-a': 'sig-a' },
  advertisedBrokerUrl: 'https://hub.example/broker',
  lwaClientId: 'amzn1.application-oa2-client.x',
}

describe('export-alexa state migrations on real SQLite', () => {
  it('moves the state, the token reads back from the record, then the keys and the secret go', async () => {
    seed(STATE_LEGACY)
    const w = await boot()
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    expect(ledger()[STATE_TO_INSTANCE_ID]).toBe('applied')
    expect(ledger()[DROP_MOVED_STATE_ID]).toBe('applied')
    const held = await w.states.getResolved(ALEXA_INSTANCE_ID)
    // The token survives byte for byte.
    expect(held?.data.ingressToken).toBe(INGRESS_PLAIN)
    expect(held?.data).toMatchObject({
      visionNamespace: 'cs-ns-1',
      exportedEndpoints: { 7: ['ep-a', 'ep-b'] },
      exportedSignatures: { 'ep-a': 'sig-a' },
      advertisedBrokerUrl: 'https://hub.example/broker',
      lwaClientId: 'amzn1.application-oa2-client.x',
    })
    expect(w.calls).toContain('clear:ingressToken')
    const left = Object.keys(storedValues())
    for (const moved of [
      'ingressToken',
      'visionNamespace',
      'detectionClasses',
      'accountVisibility',
      'exportedEndpoints',
      'exportedSignatures',
      'advertisedBrokerUrl',
      'lwaClientId',
    ]) {
      expect(left).not.toContain(moved)
    }
    expect(left).toContain('unrelatedKey')
    expect(rows()['other-addon.skillMode']).toBe(wrapper('other-addon', 'skillMode', 'keep-me'))
  })

  it('a second run is already-done and writes nothing', async () => {
    seed(STATE_LEGACY)
    const w = await boot()
    await w.runCatalogue()
    const before = rows()
    expect(await w.execute(STATE_TO_INSTANCE_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.execute(DROP_MOVED_STATE_ID)).toMatchObject({
      kind: 'plan',
      plan: { edits: [] },
    })
    expect(rows()).toEqual(before)
  })

  it('never overwrites an existing state record and keeps the legacy keys', async () => {
    seed(STATE_LEGACY)
    const existing: SkillStateBody = {
      name: 'Mine',
      ingressToken: 'a-token-that-must-survive-0000',
      visionNamespace: 'mine',
      detectionClasses: {},
      accountVisibility: {},
      exportedEndpoints: {},
      exportedSignatures: {},
      advertisedBrokerUrl: '',
      lwaClientId: '',
    }
    const w = await boot({ existingState: existing })
    await w.execute(SETTINGS_TO_INTEGRATION_ID)
    expect(await w.execute(STATE_TO_INSTANCE_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    const held = await w.states.getResolved(ALEXA_INSTANCE_ID)
    expect(held?.data.ingressToken).toBe('a-token-that-must-survive-0000')
    // The record does not hold what the settings carried: the drop refuses.
    expect(await w.execute(DROP_MOVED_STATE_ID)).toMatchObject({ kind: 'failed' })
    expect(Object.keys(storedValues())).toContain('ingressToken')
    expect(w.calls).not.toContain('clear:ingressToken')
  })

  it('a record that reads back with another token fails, and nothing is cleared', async () => {
    seed(STATE_LEGACY)
    const w = await boot({ stateReadBackToken: 'tampered' })
    await w.execute(SETTINGS_TO_INTEGRATION_ID)
    expect(await w.execute(STATE_TO_INSTANCE_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('does not match') as string,
    })
    expect(await w.execute(DROP_MOVED_STATE_ID)).toMatchObject({ kind: 'failed' })
    expect(Object.keys(storedValues())).toContain('ingressToken')
    expect(w.calls).not.toContain('clear:ingressToken')
  })

  it('a failed read of the settings writes nothing', async () => {
    seed(STATE_LEGACY)
    const before = rows()
    const w = await boot({ readFails: true })
    expect(await w.execute(STATE_TO_INSTANCE_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('keychain locked') as string,
    })
    expect(await w.states.get(ALEXA_INSTANCE_ID)).toBeNull()
    expect(rows()).toEqual(before)
  })

  it('a failed read of the record keeps the legacy keys', async () => {
    seed(STATE_LEGACY)
    const w = await boot({ stateReadFails: true })
    await w.execute(SETTINGS_TO_INTEGRATION_ID)
    expect(await w.execute(DROP_MOVED_STATE_ID)).toMatchObject({ kind: 'failed' })
    expect(Object.keys(storedValues())).toContain('ingressToken')
    expect(w.calls).not.toContain('clear:ingressToken')
  })

  it('adopts the default instance when only the token was ever minted', async () => {
    seed({ ingressToken: INGRESS_MARKER })
    const w = await boot()
    expect(await w.execute(STATE_TO_INSTANCE_ID)).toMatchObject({ result: { outcome: 'done' } })
    expect((await w.states.getResolved(ALEXA_INSTANCE_ID))?.data.ingressToken).toBe(INGRESS_PLAIN)
    expect(await w.skills.get(ALEXA_INSTANCE_ID)).not.toBeNull()
  })

  it('does nothing when no state key is stored', async () => {
    seed({ unrelatedKey: 1 })
    const w = await boot()
    expect(await w.execute(STATE_TO_INSTANCE_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.states.get(ALEXA_INSTANCE_ID)).toBeNull()
  })
})

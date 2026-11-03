/**
 * The Cloudflare tunnel migrations on REAL SQLite, through the real migration engine: the addon's
 * settings live in the canonical `addon-settings` table (one row per key, id
 * `cloudflare-tunnel.<key>`, data `{ addonId, key, value }`, node rows `<key>@<nodeId>` with
 * `nodeId`). The moved keys must go from where they are stored, and an unrelated key, another
 * addon's rows and the bare origin rows must stay.
 *
 * The engine is the hub's own (`sqlite-storage`), mounted on purpose from the sibling package:
 * a fake store with a different layout is exactly what hid the Loki outage.
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
import { MigrationEngine } from '../../../../../system/src/builtins/sqlite-storage/migrations/migration-engine.js'
import { MigrationsProvider } from '../../../../../system/src/builtins/sqlite-storage/migrations/migrations-provider.js'
import { openOwnedSqliteFile } from '../../../../../system/src/builtins/sqlite-storage/owned-sqlite-file.js'
import { SqliteSnapshotter } from '../../../../../system/src/builtins/sqlite-storage/sqlite-snapshotter.js'
import {
  makeHarness,
  recordingLogger,
  type Harness,
} from '../../../../../system/src/builtins/sqlite-storage/__tests__/support/owned-files-harness.js'
import { CLOUDFLARE_TUNNEL_RECORD_ID, cloudflareTunnelsKind } from '../../tunnel-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  CONNECTION_TO_RECORDS_ID,
  type CloudflareTunnelCataloguePorts,
  DROP_MOVED_SETTINGS_ID,
  LOCAL_ORIGIN_TO_NODE_ID,
} from '../index.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)
const ADDON = 'cloudflare-tunnel'
const wrapper = (addonId: string, key: string, value: unknown, nodeId?: string): string =>
  JSON.stringify(nodeId === undefined ? { addonId, key, value } : { addonId, key, value, nodeId })

const API_MARKER = { $secret: 'keychain-ref-api' }
const TUNNEL_MARKER = { $secret: 'keychain-ref-tunnel' }
/** What the keychain answers for the markers. */
const RESOLVED: Record<string, unknown> = {
  customApiToken: 'api-plain',
  customTunnelToken: 'jwt-plain',
}

const LEGACY: Record<string, unknown> = {
  mode: 'custom',
  customApiToken: API_MARKER,
  customTunnelToken: TUNNEL_MARKER,
  customAccountId: 'acc-1',
  customTunnelId: 'tun-1',
  customZoneId: 'zone-1',
  customZoneName: 'example.com',
  customDnsRecordId: 'dns-1',
  customHostname: 'cam.example.com',
  noTLSVerify: false,
  originServerName: 'camstack.local',
  httpHostHeader: '',
  debugLogging: true,
  protocol: 'http2',
  localHost: '192.0.2.10',
  localPortMode: 'custom',
  localPort: 8443,
  unrelatedMark: 'keep-me',
}

let h: Harness
function seed(values: Record<string, unknown>): void {
  const db = new Database(h.pathOf('settings'))
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  for (const [key, value] of Object.entries(values)) {
    const at = key.indexOf('@')
    insert.run(
      `${ADDON}.${key}`,
      wrapper(ADDON, key, value, at < 0 ? undefined : key.slice(at + 1)),
    )
  }
  insert.run('other-addon.mode', wrapper('other-addon', 'mode', 'keep-me'))
  insert.run('other-addon.localHost', wrapper('other-addon', 'localHost', 'keep-me-too'))
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

/** The addon's raw read, as the settings backend answers it: the wrappers unwrapped. */
function storedValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, data] of Object.entries(rows())) {
    if (!id.startsWith(`${ADDON}.`)) continue
    out[id.slice(`${ADDON}.`.length)] = JSON.parse(data).value
  }
  return out
}

/** The keychain: a marker reads as its value. */
function resolved(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(storedValues()).map(([key, value]) => [
      key,
      typeof value === 'object' && value !== null && key in RESOLVED ? RESOLVED[key] : value,
    ]),
  )
}

function deleteRows(keys: readonly string[]): void {
  // The addon forgets a secret through the settings writer; here the row goes the same way.
  const db = new Database(h.pathOf('settings'))
  try {
    const remove = db.prepare('DELETE FROM "addon-settings" WHERE id = ?')
    for (const key of keys) remove.run(`${ADDON}.${key}`)
  } finally {
    db.close()
  }
}

interface Options {
  /** The record read-back answers with this token instead of the one stored. */
  readonly readBackTunnelToken?: string
  readonly readFails?: boolean
  /** A record is already there, with this body. */
  readonly existing?: Record<string, unknown>
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
  await memory.records.declare({ tunnels: cloudflareTunnelsKind })
  const handle = memory.records.kind(cloudflareTunnelsKind)
  if (options.existing !== undefined) {
    await handle.put(
      {
        id: CLOUDFLARE_TUNNEL_RECORD_ID,
        data: {
          name: 'Mine',
          mode: 'quick',
          customAccountId: '',
          customTunnelId: '',
          customZoneId: '',
          customZoneName: '',
          customDnsRecordId: '',
          customHostname: 'mine.example.com',
          noTLSVerify: true,
          originServerName: '',
          httpHostHeader: '',
          debugLogging: false,
          protocol: 'auto',
          ...options.existing,
        },
      },
      { ifRev: 0 },
    )
  }
  const ports: CloudflareTunnelCataloguePorts = {
    readStored: async () => {
      calls.push('read-stored')
      if (options.readFails === true) throw new Error('keychain locked')
      return resolved()
    },
    readRawStored: async () => resolved(),
    warn: (message) => {
      warnings.push(message)
    },
    putRecord: async (body) => {
      if ((await handle.get(CLOUDFLARE_TUNNEL_RECORD_ID)) !== null) return 'exists'
      calls.push('put')
      await handle.put({ id: CLOUDFLARE_TUNNEL_RECORD_ID, data: body }, { ifRev: 0 })
      return 'created'
    },
    readRecord: async () => {
      calls.push('read-back')
      const row = await handle.getResolved(CLOUDFLARE_TUNNEL_RECORD_ID)
      if (row === null) return null
      return {
        hostname: row.data.customHostname,
        apiToken: row.data.customApiToken ?? '',
        tunnelToken: options.readBackTunnelToken ?? row.data.customTunnelToken ?? '',
      }
    },
    clearOldSecrets: async (keys) => {
      calls.push(`clear:${[...keys].join('+')}`)
      deleteRows(keys)
    },
  }
  const bound = defineAddonMigrations(ADDON_MIGRATIONS, ports)
  const runCatalogue = () => runAddonMigrations(host, bound, recordingLogger(h.lines, 'Addon'))
  const execute = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  return { handle, calls, warnings, runCatalogue, execute }
}

describe('cloudflare-tunnel migrations on real SQLite', () => {
  it('moves the tunnel into a record, drops the moved keys and copies the origin to the hub node rows', async () => {
    seed(LEGACY)
    const w = await boot()
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    expect(ledger()).toEqual({
      [CONNECTION_TO_RECORDS_ID]: 'applied',
      [DROP_MOVED_SETTINGS_ID]: 'applied',
      [LOCAL_ORIGIN_TO_NODE_ID]: 'applied',
    })
    const row = await w.handle.getResolved(CLOUDFLARE_TUNNEL_RECORD_ID)
    expect(row?.data).toMatchObject({
      mode: 'custom',
      customApiToken: 'api-plain',
      customTunnelToken: 'jwt-plain',
      customTunnelId: 'tun-1',
      customHostname: 'cam.example.com',
      noTLSVerify: false,
      originServerName: 'camstack.local',
      debugLogging: true,
      protocol: 'http2',
    })
    const after = rows()
    // The moved keys are gone; the unrelated key, the bare origin rows and another addon's rows stay.
    expect(Object.keys(after).sort()).toEqual(
      [
        'other-addon.localHost',
        'other-addon.mode',
        `${ADDON}.localHost`,
        `${ADDON}.localHost@hub`,
        `${ADDON}.localPort`,
        `${ADDON}.localPort@hub`,
        `${ADDON}.localPortMode`,
        `${ADDON}.localPortMode@hub`,
        `${ADDON}.unrelatedMark`,
      ].sort(),
    )
    expect(after[`${ADDON}.unrelatedMark`]).toBe(wrapper(ADDON, 'unrelatedMark', 'keep-me'))
    expect(after['other-addon.mode']).toBe(wrapper('other-addon', 'mode', 'keep-me'))
    expect(after[`${ADDON}.localHost@hub`]).toBe(
      wrapper(ADDON, 'localHost@hub', '192.0.2.10', 'hub'),
    )
    expect(after[`${ADDON}.localPort@hub`]).toBe(wrapper(ADDON, 'localPort@hub', 8443, 'hub'))
    expect(after[`${ADDON}.localHost`]).toBe(wrapper(ADDON, 'localHost', '192.0.2.10'))
  })

  it('copies the token, reads it back from the record, and only then clears it', async () => {
    seed(LEGACY)
    const w = await boot()
    await w.execute(CONNECTION_TO_RECORDS_ID)
    expect(w.calls).toEqual([
      'read-stored',
      'put',
      'read-back',
      'clear:customApiToken+customTunnelToken',
    ])
  })

  it('keeps a legacy secret the record does not verifiably hold', async () => {
    seed(LEGACY)
    const w = await boot({ readBackTunnelToken: 'something-else' })
    await w.execute(CONNECTION_TO_RECORDS_ID)
    expect(w.calls).toContain('clear:customApiToken')
    expect(w.calls).not.toContain('clear:customApiToken+customTunnelToken')
    expect(storedValues()['customTunnelToken']).toEqual(TUNNEL_MARKER)
    expect(w.warnings.join(' ')).toContain('legacy ones are kept')
  })

  it('never overwrites an existing record, and keeps the old secrets while it holds none', async () => {
    seed(LEGACY)
    const w = await boot({ existing: { customHostname: 'mine.example.com' } })
    expect(await w.execute(CONNECTION_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    const row = await w.handle.getResolved(CLOUDFLARE_TUNNEL_RECORD_ID)
    expect(row?.data).toMatchObject({ name: 'Mine', customHostname: 'mine.example.com' })
    expect(w.calls).not.toContain('put')
    expect(storedValues()['customApiToken']).toEqual(API_MARKER)
    expect(storedValues()['customTunnelToken']).toEqual(TUNNEL_MARKER)
  })

  it('a second run is already-done and writes nothing', async () => {
    seed(LEGACY)
    const w = await boot()
    await w.runCatalogue()
    const before = rows()
    expect(await w.execute(CONNECTION_TO_RECORDS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    for (const id of [DROP_MOVED_SETTINGS_ID, LOCAL_ORIGIN_TO_NODE_ID]) {
      expect(await w.execute(id)).toMatchObject({ kind: 'plan', plan: { edits: [] } })
    }
    expect(rows()).toEqual(before)
  })

  it('a node row that exists is never overwritten by the bare origin row', async () => {
    seed({ ...LEGACY, 'localPort@hub': 9443 })
    const w = await boot()
    await w.runCatalogue()
    expect(JSON.parse(rows()[`${ADDON}.localPort@hub`] ?? '{}').value).toBe(9443)
    expect(JSON.parse(rows()[`${ADDON}.localHost@hub`] ?? '{}').value).toBe('192.0.2.10')
  })

  it('a failed read of the old settings writes nothing and the legacy keys stay', async () => {
    seed(LEGACY)
    const before = rows()
    const w = await boot({ readFails: true })
    expect(await w.execute(CONNECTION_TO_RECORDS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('keychain locked') as string,
    })
    expect(w.calls).toEqual(['read-stored'])
    expect(await w.handle.get(CLOUDFLARE_TUNNEL_RECORD_ID)).toBeNull()
    expect(rows()).toEqual(before)
  })

  it('the drop refuses while the record lacks the hostname or the token, then deletes nothing', async () => {
    seed(LEGACY)
    const w = await boot()
    expect(await w.execute(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('no Cloudflare tunnel record') as string,
    })
  })

  it('the drop names the tunnel token the record lacks', async () => {
    seed(LEGACY)
    const noToken = await boot({ existing: { customTunnelToken: undefined } })
    expect(await noToken.execute(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('holds no tunnel token') as string,
    })
    expect(Object.keys(rows())).toContain(`${ADDON}.customTunnelToken`)
  })

  it('the drop names the hostname the record lacks', async () => {
    seed(LEGACY)
    const noHost = await boot({ existing: { customHostname: '', customTunnelToken: 'x' } })
    expect(await noHost.execute(DROP_MOVED_SETTINGS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('holds no hostname') as string,
    })
    expect(Object.keys(rows())).toContain(`${ADDON}.customTunnelToken`)
  })
})

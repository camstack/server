/**
 * The export-targets migrations (seq 6 and 7) on REAL SQLite, through the hub's own migration
 * engine: each `ha-export-links` record (id = broker id) must reach an `ha-export-targets` record
 * under a minted id carrying its switch, media role and devices (compared element-wise) plus the
 * addon-level `reconcileIntervalSec` row of the canonical `addon-settings` table. The link rows
 * and the `reconcileIntervalSec` / `knownBrokers` keys may go only once the target reads back;
 * an unrelated key (`exportedEntities`) and another addon's rows must stay.
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
import type { HaExportTargetBody } from '../../target-records.js'
import { haExportTargetsKind } from '../../target-records.js'
import { type HaExportLinksBody, haExportLinksKind } from '../legacy-links-kind.js'
import { ADDON_MIGRATIONS, DROP_LINKS_AND_CACHE_ID, TARGETS_FROM_LINKS_ID } from '../index.js'
import type { DropLinksAndCachePorts, TargetsFromLinksPorts } from '../targets-from-links.js'

const SNAPSHOT_WORKER = fileURLToPath(
  new URL(
    '../../../../../system/src/builtins/sqlite-storage/sqlite-snapshot-worker.ts',
    import.meta.url,
  ),
)
const ADDON = 'homeassistant-export'
const wrapper = (addonId: string, key: string, value: unknown): string =>
  JSON.stringify({ addonId, key, value })

let h: Harness
function seed(values: Record<string, unknown>): void {
  const db = new Database(h.pathOf('settings'))
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const insert = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  for (const [key, value] of Object.entries(values)) {
    insert.run(`${ADDON}.${key}`, wrapper(ADDON, key, value))
  }
  insert.run('other-addon.membership', wrapper('other-addon', 'membership', { keep: ['me'] }))
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

function storedValues(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, data] of Object.entries(rows())) {
    if (!id.startsWith(`${ADDON}.`)) continue
    out[id.slice(`${ADDON}.`.length)] = JSON.parse(data).value
  }
  return out
}

const SETTINGS: Record<string, unknown> = {
  reconcileIntervalSec: 217,
  knownBrokers: [{ id: 'ha_001', name: 'Home' }],
  exportedEntities: { actions: ['kept'], targets: [] },
}
const HOME: HaExportLinksBody = {
  name: 'Home',
  exportTo: true,
  mediaRole: 'publicEndpoint',
  devices: [
    '101',
    '104',
    '7',
    '12',
    '13',
    '14',
    '15',
    '16',
    '17',
    '18',
    '19',
    '20',
    '21',
    '22',
    '23',
    '24',
  ],
}
const CABIN: HaExportLinksBody = {
  name: 'Cabin',
  exportTo: false,
  mediaRole: 'internal',
  devices: ['20'],
}

interface Options {
  readonly readLinksFails?: boolean
  readonly readStoredFails?: boolean
  /** The read-back of targets answers with these devices instead of what was written. */
  readonly readBackDevices?: readonly string[]
  readonly links?: Readonly<Record<string, HaExportLinksBody>>
  readonly targets?: Readonly<Record<string, HaExportTargetBody>>
}

function deleteSettingRows(keys: readonly string[]): void {
  const db = new Database(h.pathOf('settings'))
  try {
    const del = db.prepare('DELETE FROM "addon-settings" WHERE id = ?')
    for (const key of keys) del.run(`${ADDON}.${key}`)
  } finally {
    db.close()
  }
}

async function boot(options: Options = {}) {
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
  await memory.records.declare({
    'ha-export-links': haExportLinksKind,
    'ha-export-targets': haExportTargetsKind,
  })
  const links = memory.records.kind(haExportLinksKind)
  const targets = memory.records.kind(haExportTargetsKind)
  for (const [id, data] of Object.entries(options.links ?? {})) {
    await links.put({ id, data }, { ifRev: 0 })
  }
  for (const [id, data] of Object.entries(options.targets ?? {})) {
    await targets.put({ id, data }, { ifRev: 0 })
  }
  const ports: TargetsFromLinksPorts & DropLinksAndCachePorts = {
    readStored: async () => {
      if (options.readStoredFails === true) throw new Error('settings unreadable')
      return storedValues()
    },
    readLinks: async () => {
      if (options.readLinksFails === true) throw new Error('links unreadable')
      const page = await links.query({ limit: 100 })
      return new Map(page.records.map((row) => [row.id, row.data]))
    },
    readTargets: async () => {
      const page = await targets.query({ limit: 100 })
      return new Map(
        page.records.map((row) => [
          row.id,
          options.readBackDevices !== undefined && row.id === 'hae_001'
            ? { ...row.data, devices: options.readBackDevices }
            : row.data,
        ]),
      )
    },
    putTarget: async (id, data) => {
      if ((await targets.get(id)) !== null) return 'exists'
      await targets.put({ id, data }, { ifRev: 0 })
      return 'created'
    },
    deleteLinks: async (ids) => {
      await links.deleteMany(ids)
    },
    // The addon writes this through its settings store; the spec removes the rows the same way.
    clearSettingKeys: async (keys) => {
      deleteSettingRows(keys)
    },
    warn: (message) => {
      warnings.push(message)
    },
  }
  const bound = defineAddonMigrations(
    ADDON_MIGRATIONS.filter((m) =>
      [TARGETS_FROM_LINKS_ID, DROP_LINKS_AND_CACHE_ID].includes(m.meta.id),
    ).map((m) =>
      // The earlier catalogue entries are not under test here: only the 6 -> 7 order is kept.
      m.meta.id === TARGETS_FROM_LINKS_ID ? { ...m, meta: { ...m.meta, dependsOn: [] } } : m,
    ),
    // The two bodies read only these ports; the other catalogue entries are filtered out above.
    {
      ...ports,
      putLinks: async () => 'exists',
      listInstances: async () => [],
      patchInstanceSettings: async () => false,
    },
  )
  const runCatalogue = () => runAddonMigrations(host, bound, recordingLogger(h.lines, 'Addon'))
  const execute = async (id: string): Promise<MigrationOwnerResult> => {
    const entry = bound.find((b) => b.meta.id === id)
    if (entry === undefined) throw new Error(`no ${id}`)
    return entry.execute()
  }
  const target = async (id: string) => (await targets.get(id))?.data ?? null
  const linkIds = async () =>
    (await links.query({ limit: 100 })).records.map((row) => row.id).sort()
  const targetIds = async () =>
    (await targets.query({ limit: 100 })).records.map((row) => row.id).sort()
  return { target, linkIds, targetIds, warnings, runCatalogue, execute }
}

const HOME_TARGET: HaExportTargetBody = {
  name: 'Home',
  connectionId: 'ha_001',
  mediaRole: 'publicEndpoint',
  reconcileIntervalSec: 217,
  devices: HOME.devices,
  enabled: true,
}

describe('homeassistant-export targets migration on real SQLite', () => {
  it('moves each link into a minted target, carrying the role and every device, then drops the old rows and keys', async () => {
    seed(SETTINGS)
    const w = await boot({ links: { ha_001: HOME, ha_002: CABIN } })
    const report = await w.runCatalogue()
    expect(report.failed ?? []).toEqual([])
    expect(report.blockOwner ?? []).toEqual([])
    expect(await w.target('hae_001')).toEqual(HOME_TARGET)
    expect(await w.target('hae_002')).toEqual({
      name: 'Cabin',
      connectionId: 'ha_002',
      mediaRole: 'internal',
      reconcileIntervalSec: 217,
      devices: ['20'],
      enabled: false,
    })
    expect(await w.linkIds()).toEqual([])
    expect(Object.keys(rows()).sort()).toEqual(
      [`${ADDON}.exportedEntities`, 'other-addon.membership'].sort(),
    )
    expect(storedValues()['exportedEntities']).toEqual(SETTINGS['exportedEntities'])
  })

  it('defaults the cadence to 300 when the addon never stored one', async () => {
    seed({ exportedEntities: SETTINGS['exportedEntities'] })
    const w = await boot({ links: { ha_001: HOME } })
    await w.runCatalogue()
    expect((await w.target('hae_001'))?.reconcileIntervalSec).toBe(300)
  })

  it('a second run changes nothing', async () => {
    seed(SETTINGS)
    const w = await boot({ links: { ha_001: HOME } })
    await w.runCatalogue()
    const before = rows()
    const target = await w.target('hae_001')
    expect(await w.execute(TARGETS_FROM_LINKS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.execute(DROP_LINKS_AND_CACHE_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(rows()).toEqual(before)
    expect(await w.target('hae_001')).toEqual(target)
    expect(await w.targetIds()).toEqual(['hae_001'])
  })

  it('creates no second target for a connection that already has one', async () => {
    seed(SETTINGS)
    const w = await boot({
      links: { ha_001: HOME },
      targets: {
        hae_001: { ...HOME_TARGET, name: 'Mine', mediaRole: 'internal' },
      },
    })
    expect(await w.execute(TARGETS_FROM_LINKS_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.targetIds()).toEqual(['hae_001'])
    expect((await w.target('hae_001'))?.name).toBe('Mine')
  })

  it('a failed read of the links writes nothing', async () => {
    seed(SETTINGS)
    const before = rows()
    const w = await boot({ links: { ha_001: HOME }, readLinksFails: true })
    expect(await w.execute(TARGETS_FROM_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('links unreadable') as string,
    })
    expect(await w.targetIds()).toEqual([])
    expect(rows()).toEqual(before)
  })

  it('a failed read of the settings writes nothing', async () => {
    seed(SETTINGS)
    const before = rows()
    const w = await boot({ links: { ha_001: HOME }, readStoredFails: true })
    expect(await w.execute(TARGETS_FROM_LINKS_ID)).toMatchObject({
      kind: 'failed',
    })
    expect(await w.targetIds()).toEqual([])
    expect(await w.linkIds()).toEqual(['ha_001'])
    expect(rows()).toEqual(before)
  })

  it('a target that does not read back identical fails the move and deletes nothing', async () => {
    seed(SETTINGS)
    const w = await boot({
      links: { ha_001: HOME },
      readBackDevices: HOME.devices.slice(0, 15),
    })
    expect(await w.execute(TARGETS_FROM_LINKS_ID)).toMatchObject({
      kind: 'failed',
      error: expect.stringContaining('does not match') as string,
    })
    expect(await w.linkIds()).toEqual(['ha_001'])
    expect(storedValues()['reconcileIntervalSec']).toBe(217)
  })

  it('compares devices element-wise: the same devices in another order do not read back', async () => {
    seed(SETTINGS)
    const w = await boot({
      links: { ha_001: HOME },
      readBackDevices: [...HOME.devices].reverse(),
    })
    expect(await w.execute(TARGETS_FROM_LINKS_ID)).toMatchObject({
      kind: 'failed',
    })
  })

  it('keeps a link whose target holds other devices, and the keys with it', async () => {
    seed(SETTINGS)
    const w = await boot({
      links: { ha_001: HOME },
      targets: { hae_001: { ...HOME_TARGET, devices: ['101'] } },
    })
    expect(await w.execute(DROP_LINKS_AND_CACHE_ID)).toMatchObject({
      result: { outcome: 'already-done' },
    })
    expect(await w.linkIds()).toEqual(['ha_001'])
    expect(storedValues()['knownBrokers']).toEqual(SETTINGS['knownBrokers'])
    expect(w.warnings.join(' ')).toContain('ha_001')
  })

  it('keeps a link that has no target at all', async () => {
    seed(SETTINGS)
    const w = await boot({ links: { ha_001: HOME } })
    await w.execute(DROP_LINKS_AND_CACHE_ID)
    expect(await w.linkIds()).toEqual(['ha_001'])
    expect(await w.targetIds()).toEqual([])
  })
})

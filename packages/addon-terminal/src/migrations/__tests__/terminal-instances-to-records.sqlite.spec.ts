/**
 * The Terminal list moves from the addon settings (`terminalInstances`) into `terminals` records
 * on REAL SQLite, through the real migration API, ledger and records engine. A field the old row
 * carried that a re-built row would lose (`profileSettings.mark`) is the discriminator: it must be
 * on the record, under the SAME id, so `terminal-camera-instance-<id>` stays the camera's stable id.
 */
import { defineAddonMigrations, runAddonMigrations } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type MigrationWorld,
  makeMigrationWorld,
} from '../../../../system/src/builtins/sqlite-storage/__tests__/support/migration-world.js'
import { recordingLogger } from '../../../../system/src/builtins/sqlite-storage/__tests__/support/owned-files-harness.js'
import { newTerminalCameraStableId, terminalInstancesKind } from '../../terminal-record-kinds.js'
import {
  ADDON_MIGRATIONS,
  INSTANCES_TO_RECORDS_ID,
  type TerminalMigrationPorts,
  terminalPortsOver,
} from '../index.js'
import {
  TERMINAL_SEED_ADDON,
  TERMINAL_SEED_ROWS,
  seedTerminalLegacySettings,
} from '../__fixtures__/seed.js'

const worlds: MigrationWorld[] = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((w) => w.cleanup()))
})

async function boot() {
  const world = await makeMigrationWorld()
  worlds.push(world)
  world.db.exec(
    'CREATE TABLE IF NOT EXISTS "addon-settings" (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  )
  const records = world.recordsFor(TERMINAL_SEED_ADDON)
  await records.declare({ terminals: terminalInstancesKind })
  const handle = records.kind(terminalInstancesKind)
  const portsOver = (): TerminalMigrationPorts =>
    terminalPortsOver(world.apiFor(TERMINAL_SEED_ADDON))
  const run = (ports: TerminalMigrationPorts = portsOver()) =>
    runAddonMigrations(
      world.hostFor(TERMINAL_SEED_ADDON),
      defineAddonMigrations(ADDON_MIGRATIONS, ports),
      recordingLogger(world.lines, 'Addon'),
    )
  const settingsRow = () =>
    world.db
      .prepare('SELECT id FROM "addon-settings" WHERE id = ?')
      .get(`${TERMINAL_SEED_ADDON}.terminalInstances`)
  const ledger = () =>
    world.db.prepare('SELECT id, status FROM _migrations WHERE id = ?').get(INSTANCES_TO_RECORDS_ID)
  return { world, handle, run, portsOver, settingsRow, ledger }
}

describe('Terminal instances settings to records, on real SQLite', () => {
  it('copies every row under its own id, keeps the marked field, then drops the old key', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    const report = await w.run()
    expect(report.failed).toEqual([])
    expect(w.ledger()).toMatchObject({ status: 'applied' })

    const page = await w.handle.query({ limit: 10 })
    expect(page.records.map((r) => r.id).sort()).toEqual(TERMINAL_SEED_ROWS.map((r) => r.id).sort())
    for (const seed of TERMINAL_SEED_ROWS) {
      const row = await w.handle.get(seed.id)
      expect(row?.data).toMatchObject({
        name: seed.name,
        nodeId: seed.nodeId,
        profileId: seed.profileId,
        profileLabel: seed.profileLabel,
        args: seed.args,
        cwd: seed.cwd,
        environment: seed.environment,
        profileSettings: seed.profileSettings,
      })
      expect(row?.data.enabled !== false).toBe(seed.enabled)
    }
    expect(w.settingsRow()).toBeUndefined()
  })

  it('the camera each record yields is the camera the old row named (device ids stay)', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    await w.run()
    for (const seed of TERMINAL_SEED_ROWS) {
      const row = await w.handle.get(seed.id)
      expect(row?.data.cameraStableId ?? newTerminalCameraStableId(seed.id)).toBe(
        seed.cameraStableId,
      )
    }
  })

  it('a second run is already-done and writes nothing', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    await w.run()
    const first = JSON.stringify((await w.handle.query({ limit: 10 })).records)
    const migration = ADDON_MIGRATIONS[0]
    if (migration === undefined || !('procedure' in migration)) {
      throw new Error('the catalogue holds no procedure')
    }
    const result = await migration.procedure(w.portsOver())
    expect(result).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify((await w.handle.query({ limit: 10 })).records)).toBe(first)
  })

  it('never overwrites a record that already exists, and still drops the key once it is there', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    const seed = TERMINAL_SEED_ROWS[0]
    if (seed === undefined) throw new Error('seed is empty')
    await w.handle.put(
      {
        id: seed.id,
        data: {
          name: 'Renamed since',
          nodeId: 'hub',
          profileId: 'glances',
          profileLabel: 'Glances',
          executable: '',
          args: [],
          cwd: '',
          environment: [],
          profileSettings: {},
        },
      },
      { ifRev: 0 },
    )
    await w.run()
    expect((await w.handle.get(seed.id))?.data.name).toBe('Renamed since')
    expect(await w.handle.get(TERMINAL_SEED_ROWS[1]?.id ?? '')).not.toBeNull()
    expect(w.settingsRow()).toBeUndefined()
  })

  const replaceLegacy = (w: Awaited<ReturnType<typeof boot>>, value: unknown) =>
    w.world.db
      .prepare('UPDATE "addon-settings" SET data = ? WHERE id = ?')
      .run(
        JSON.stringify({ addonId: TERMINAL_SEED_ADDON, key: 'terminalInstances', value }),
        `${TERMINAL_SEED_ADDON}.terminalInstances`,
      )
  const legacyValue = (w: Awaited<ReturnType<typeof boot>>): unknown => {
    const row = w.world.db
      .prepare('SELECT data FROM "addon-settings" WHERE id = ?')
      .get(`${TERMINAL_SEED_ADDON}.terminalInstances`)
    if (row === undefined || typeof row.data !== 'string') return undefined
    return JSON.parse(row.data).value
  }

  it('bad rows never block the good ones: they are converted, the key keeps only the bad rows, and it lands done', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    const nameless = { id: 'not-a-uuid', name: '' }
    const malformed = {
      ...TERMINAL_SEED_ROWS[0],
      id: '9a8b7c6d-0000-4000-8000-00000000cccc',
      args: 'x',
    }
    replaceLegacy(w, [...TERMINAL_SEED_ROWS, nameless, malformed])
    const report = await w.run()
    expect(report.failed).toEqual([])
    expect(w.ledger()).toMatchObject({ status: 'applied' })
    expect((await w.handle.query({ limit: 10 })).records).toHaveLength(TERMINAL_SEED_ROWS.length)
    expect(legacyValue(w)).toEqual([nameless, malformed])
  })

  it('a rerun with only bad rows left is already-done, rewrites nothing', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    const nameless = { id: 'not-a-uuid', name: '' }
    replaceLegacy(w, [nameless])
    const migration = ADDON_MIGRATIONS[0]
    if (migration === undefined || !('procedure' in migration)) {
      throw new Error('the catalogue holds no procedure')
    }
    const result = await migration.procedure(w.portsOver())
    expect(result).toMatchObject({ outcome: 'already-done' })
    expect(legacyValue(w)).toEqual([nameless])
  })

  it('a duplicate id is skipped after the first, which stays', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    const first = TERMINAL_SEED_ROWS[0]
    const dup = { ...first, name: 'Second with the same id' }
    replaceLegacy(w, [first, dup])
    const report = await w.run()
    expect(report.failed).toEqual([])
    const records = (await w.handle.query({ limit: 10 })).records
    expect(records).toHaveLength(1)
    expect(records[0]?.data.name).toBe(first?.name)
    expect(legacyValue(w)).toEqual([dup])
  })

  it('a disabled row survives disabled and an adopted legacy camera id survives', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    await w.run()
    const adopted = TERMINAL_SEED_ROWS[1]
    const record = await w.handle.get(adopted?.id ?? '')
    expect(record?.data.enabled).toBe(false)
    expect(record?.data.cameraStableId).toBe(adopted?.cameraStableId)
  })

  it('keeps the old key when a written record does not read back equal', async () => {
    const w = await boot()
    seedTerminalLegacySettings(w.world.db)
    const real = w.portsOver()
    const lying: TerminalMigrationPorts = {
      ...real,
      readRecord: async (id) => {
        const body = await real.readRecord(id)
        return body === null ? null : { ...body, name: `${body.name} (drifted)` }
      },
    }
    const report = await w.run(lying)
    expect(report.failed.length).toBeGreaterThan(0)
    expect(w.settingsRow()).toBeDefined()
  })

  it('an install with no legacy key is already-done', async () => {
    const w = await boot()
    const report = await w.run()
    expect(report.failed).toEqual([])
    expect(w.ledger()).toMatchObject({ status: 'applied' })
    expect((await w.handle.query({ limit: 10 })).records).toEqual([])
  })
})

/**
 * The grid list moves from the addon settings (`cameraGrids`) into `camera-grid` records on REAL
 * SQLite, through the real migration API, ledger and records engine. A field the old row carried
 * that a re-built row would lose (`cells[0].source.x = 0.1234`) is the discriminator: it must be
 * on the record, under the SAME id, so `camera-grid-<id>` stays the camera's stable id.
 */
import { defineAddonMigrations, runAddonMigrations } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type MigrationWorld,
  makeMigrationWorld,
} from '../../../sqlite-storage/__tests__/support/migration-world.js'
import { recordingLogger } from '../../../sqlite-storage/__tests__/support/owned-files-harness.js'
import { newGridCameraStableId } from '../../grid-camera-declarations.js'
import { cameraGridKind } from '../../grid-record-kinds.js'
import { GRID_SEED_ADDON, GRID_SEED_ROWS, seedGridLegacySettings } from '../__fixtures__/seed.js'
import {
  ADDON_MIGRATIONS,
  GRIDS_TO_RECORDS_ID,
  type GridMigrationPorts,
  gridPortsOver,
} from '../index.js'

const worlds: MigrationWorld[] = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map((w) => w.cleanup()))
})

function seedId(index: number): string {
  const id = GRID_SEED_ROWS[index]?.['id']
  if (typeof id !== 'string') throw new Error('seed row has no id')
  return id
}

async function boot() {
  const world = await makeMigrationWorld()
  worlds.push(world)
  world.db.exec(
    'CREATE TABLE IF NOT EXISTS "addon-settings" (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  )
  const records = world.recordsFor(GRID_SEED_ADDON)
  await records.declare({ 'camera-grid': cameraGridKind })
  const handle = records.kind(cameraGridKind)
  const portsOver = (): GridMigrationPorts => gridPortsOver(world.apiFor(GRID_SEED_ADDON))
  const run = (ports: GridMigrationPorts = portsOver()) =>
    runAddonMigrations(
      world.hostFor(GRID_SEED_ADDON),
      defineAddonMigrations(ADDON_MIGRATIONS, ports),
      recordingLogger(world.lines, 'Addon'),
    )
  const settingsRow = () =>
    world.db
      .prepare('SELECT id FROM "addon-settings" WHERE id = ?')
      .get(`${GRID_SEED_ADDON}.cameraGrids`)
  const ledger = () =>
    world.db.prepare('SELECT id, status FROM _migrations WHERE id = ?').get(GRIDS_TO_RECORDS_ID)
  const replaceLegacy = (value: unknown) =>
    world.db
      .prepare('UPDATE "addon-settings" SET data = ? WHERE id = ?')
      .run(
        JSON.stringify({ addonId: GRID_SEED_ADDON, key: 'cameraGrids', value }),
        `${GRID_SEED_ADDON}.cameraGrids`,
      )
  return { world, handle, run, portsOver, settingsRow, ledger, replaceLegacy }
}

describe('camera grids settings to records, on real SQLite', () => {
  it('copies every row under its own id, keeps the marked cell field, then drops the old key', async () => {
    const w = await boot()
    seedGridLegacySettings(w.world.db)
    const report = await w.run()
    expect(report.failed).toEqual([])
    expect(w.ledger()).toMatchObject({ status: 'applied' })

    const page = await w.handle.query({ limit: 10 })
    expect(page.records.map((r) => r.id).sort()).toEqual([seedId(0), seedId(1)].sort())
    const laidOut = await w.handle.get(seedId(0))
    expect(laidOut?.data).toMatchObject({ name: 'Front 2x2', fps: 12 })
    expect(laidOut?.data.cells[0]?.source.x).toBe(0.1234)
    expect(laidOut?.data.cells).toHaveLength(2)
    const switchedOff = await w.handle.get(seedId(1))
    expect(switchedOff?.data.enabled).toBe(false)
    expect(switchedOff?.data.publishedProfiles).toEqual(['mid', 'low'])
    expect(w.settingsRow()).toBeUndefined()
  })

  it('the camera each record yields is the camera the old row named (device ids stay)', async () => {
    const w = await boot()
    seedGridLegacySettings(w.world.db)
    await w.run()
    for (const [index, seed] of GRID_SEED_ROWS.entries()) {
      const row = await w.handle.get(seedId(index))
      expect(row?.data.cameraStableId ?? newGridCameraStableId(seedId(index))).toBe(
        seed['cameraStableId'],
      )
    }
  })

  it('a second run is already-done and writes nothing', async () => {
    const w = await boot()
    seedGridLegacySettings(w.world.db)
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
    seedGridLegacySettings(w.world.db)
    await w.handle.put(
      {
        id: seedId(0),
        data: { name: 'Renamed since', fps: 10, publishedProfiles: ['low'], cells: [] },
      },
      { ifRev: 0 },
    )
    await w.run()
    expect((await w.handle.get(seedId(0)))?.data.name).toBe('Renamed since')
    expect(await w.handle.get(seedId(1))).not.toBeNull()
    expect(w.settingsRow()).toBeUndefined()
  })

  it('a nameless row was always ignored: it is not copied and does not hold the key', async () => {
    const w = await boot()
    seedGridLegacySettings(w.world.db)
    w.replaceLegacy([...GRID_SEED_ROWS, { id: '1b2c3d4e-0000-4000-8000-00000000aaaa', name: '  ' }])
    const report = await w.run()
    expect(report.failed).toEqual([])
    expect((await w.handle.query({ limit: 10 })).records).toHaveLength(GRID_SEED_ROWS.length)
    expect(w.settingsRow()).toBeUndefined()
  })

  it('keeps the old key when a row cannot be copied, and still copies the others', async () => {
    const w = await boot()
    seedGridLegacySettings(w.world.db)
    w.replaceLegacy([...GRID_SEED_ROWS, { id: 'not-a-uuid', name: 'Broken' }])
    const report = await w.run()
    expect(report.failed.length).toBeGreaterThan(0)
    expect(w.settingsRow()).toBeDefined()
    expect((await w.handle.query({ limit: 10 })).records).toHaveLength(GRID_SEED_ROWS.length)
  })

  it('keeps the old key when a written record does not read back equal', async () => {
    const w = await boot()
    seedGridLegacySettings(w.world.db)
    const real = w.portsOver()
    const lying: GridMigrationPorts = {
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

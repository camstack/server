/**
 * planning#584 on REAL SQLite: a `plan` migration writes instance records through the
 * records engine, re-keys a device and tombstones one, in the SAME transaction as its
 * ledger row. The file target is the one production builds (`migrateTargetOf` over the
 * connection the records engine uses); every assertion reads the database file.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  declarationsOf,
  defineRecordKinds,
  deviceIdentityPrecondition,
  type MigrationMeta,
  type MigrationPlan,
  recordDeleteEdit,
  recordUpsertEdit,
  rekeyDeviceEdit,
  tombstoneDeviceEdit,
} from '@camstack/types'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEVICE_ROWS_COLLECTION } from '../../device-manager/device-row-store.js'
import { deviceManagerRecordKinds } from '../../device-manager/record-kinds.js'
import { migrateTargetOf, type MigrateTarget } from '../migrations/migration-pass.js'
import type { HubMigration, MigrationRecordWriter } from '../migrations/migration-types.js'
import { RecordsEngine } from '../records/records-engine.js'
import { silentLogger } from './support/records-harness.js'

const BLOCKS = 'core-blocks'
const GRID_ADDON = 'camera-grid'

const kinds = defineRecordKinds({
  'camera-grids': {
    schema: z.object({ name: z.string(), cameras: z.array(z.number()), mark: z.string() }),
    class: 'config',
    writeTrigger: 'test',
    device: 'required',
    retention: { none: 'test' },
  },
  'composed-blocks': {
    schema: z.object({
      blockId: z.string(),
      name: z.string(),
      cameras: z.array(z.number()),
      mark: z.string(),
    }),
    class: 'config',
    writeTrigger: 'test',
    device: 'required',
    retention: { none: 'test' },
  },
})

const OLD_GRID = { name: 'porch', cameras: [3, 4], mark: 'marked-survives' }

function meta(owner: string, slug: string, seq: number): MigrationMeta {
  return {
    id: `${owner}/2026-11-20-${slug}`,
    owner,
    level: owner === 'hub' ? 'hub-store' : 'addon-state',
    seq,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    onFailure: 'tolerate',
    bodyKind: 'plan',
    description: `test ${slug}`,
    fixtureMark: 'mark',
  }
}

let dir: string
let db: Database.Database
let engine: RecordsEngine
let writer: MigrationRecordWriter

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'mig-584-'))
  db = new Database(path.join(dir, 'settings.db'))
  db.exec(`
    CREATE TABLE "${DEVICE_ROWS_COLLECTION}" (
      id TEXT PRIMARY KEY NOT NULL, deviceId INTEGER NOT NULL, addonId TEXT NOT NULL,
      stableId TEXT NOT NULL, name TEXT NOT NULL);
    INSERT INTO "${DEVICE_ROWS_COLLECTION}" VALUES
      ('42', 42, '${GRID_ADDON}', 'grid-1', 'porch grid'),
      ('43', 43, '${GRID_ADDON}', 'grid-2', 'spare grid'),
      ('44', 44, 'other', 'x-1', 'not theirs');
    CREATE TABLE "addon-device-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
    INSERT INTO "addon-device-settings" VALUES
      ('${GRID_ADDON}:42.layout', '{"addonId":"${GRID_ADDON}","deviceId":"42","key":"layout","value":"2x2"}'),
      ('recorder:42.recordingConfig', '{"addonId":"recorder","deviceId":"42","key":"recordingConfig","value":{"on":false}}'),
      ('recorder:43.recordingConfig', '{"deviceId":"43","value":{"on":true}}');
    CREATE TABLE "device-runtime-state" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL);
    INSERT INTO "device-runtime-state" VALUES ('42', '{}'), ('43', '{}');
  `)
  engine = new RecordsEngine(db, { databaseId: 'settings', logger: silentLogger() })
  await engine.declareKinds({ owner: BLOCKS, kinds: { ...declarationsOf(kinds) } })
  await engine.declareKinds({
    owner: 'device-manager',
    kinds: { ...declarationsOf(deviceManagerRecordKinds) },
  })
  await engine.put({
    owner: BLOCKS,
    kind: 'camera-grids',
    record: { id: 'g1', deviceId: 42, data: OLD_GRID },
  })
  writer = engine.migrationWriter()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** The #580 move: grid record → composed-block record, device 42 re-keyed to the composer. */
function movePlan(): MigrationPlan {
  const old = writer.read(BLOCKS, 'camera-grids', 'g1')
  const parsed = kinds['camera-grids'].schema.parse(old)
  return {
    edits: [
      recordUpsertEdit({
        owner: BLOCKS,
        kind: kinds['composed-blocks'],
        id: 'blk1',
        deviceId: 42,
        data: { blockId: 'blk1', ...parsed },
        read: null,
      }),
      recordDeleteEdit({ owner: BLOCKS, kind: kinds['camera-grids'], id: 'g1', read: old }),
      rekeyDeviceEdit(
        42,
        { addonId: GRID_ADDON, stableId: 'grid-1' },
        { addonId: BLOCKS, stableId: 'composed-blk1' },
      ),
    ],
  }
}

function target(catalogue: readonly HubMigration[]): MigrateTarget {
  return migrateTargetOf(db, 'settings', catalogue, writer)
}

const PASS = {
  bootId: 'boot-1',
  codeVersion: '1.0.0',
  external: {},
  held: [],
  refusal: null,
  refusalDetail: null,
} as const

function deviceRow(id: number): unknown {
  return db
    .prepare(`SELECT deviceId, addonId, stableId FROM "${DEVICE_ROWS_COLLECTION}" WHERE id = ?`)
    .get(String(id))
}

function settingsIds(): readonly string[] {
  return db
    .prepare<[], { id: string }>('SELECT id FROM "addon-device-settings" ORDER BY id')
    .all()
    .map((r) => r.id)
}

function settingsRow(id: string): unknown {
  const row = db
    .prepare<[string], { data: string }>('SELECT data FROM "addon-device-settings" WHERE id = ?')
    .get(id)
  return row === undefined ? null : JSON.parse(row.data)
}

describe('a plan moves a record and re-keys its device in one transaction', () => {
  it('keeps the marked field and the deviceId, and a rerun is a no-op', async () => {
    const t = target([{ meta: meta('hub', 'grid-to-block', 1), plan: () => movePlan() }])
    const first = t.apply(PASS)
    expect(first.outcomes.map((o) => [o.id, o.outcome, o.error])).toEqual([
      ['hub/2026-11-20-grid-to-block', 'applied', null],
    ])

    const moved = await engine.get({ owner: BLOCKS, kind: 'composed-blocks', id: 'blk1' })
    expect(moved?.data).toEqual({ blockId: 'blk1', ...OLD_GRID })
    expect(moved?.deviceId).toBe(42)
    expect(await engine.get({ owner: BLOCKS, kind: 'camera-grids', id: 'g1' })).toBeNull()
    expect(deviceRow(42)).toEqual({ deviceId: 42, addonId: BLOCKS, stableId: 'composed-blk1' })
    // The provider's own settings follow it to the new owner; another addon's stay.
    expect(settingsIds()).not.toContain(`${GRID_ADDON}:42.layout`)
    expect(settingsIds()).toContain('recorder:42.recordingConfig')
    expect(settingsRow(`${BLOCKS}:42.layout`)).toEqual({
      addonId: BLOCKS,
      deviceId: '42',
      key: 'layout',
      value: '2x2',
    })

    const second = t.apply({ ...PASS, bootId: 'boot-2' })
    expect(second.outcomes).toEqual([])
    expect(second.statuses).toEqual({ 'hub/2026-11-20-grid-to-block': 'applied' })
    expect(deviceRow(42)).toEqual({ deviceId: 42, addonId: BLOCKS, stableId: 'composed-blk1' })
    expect((await engine.get({ owner: BLOCKS, kind: 'composed-blocks', id: 'blk1' }))?.rev).toBe(1)
  })

  it('rolls records and devices back together when a later edit fails', async () => {
    const failing = (): MigrationPlan => ({
      edits: [...movePlan().edits, { op: 'deleteRow', table: 'no_such_table', key: { id: 1 } }],
    })
    const t = target([{ meta: meta('hub', 'grid-to-block', 1), plan: failing }])
    const [outcome] = t.apply(PASS).outcomes
    expect(outcome?.outcome).toBe('failed')
    expect(outcome?.error).toMatch(/no_such_table/)

    expect(await engine.get({ owner: BLOCKS, kind: 'composed-blocks', id: 'blk1' })).toBeNull()
    expect((await engine.get({ owner: BLOCKS, kind: 'camera-grids', id: 'g1' }))?.data).toEqual(
      OLD_GRID,
    )
    expect(deviceRow(42)).toEqual({ deviceId: 42, addonId: GRID_ADDON, stableId: 'grid-1' })
    expect(settingsIds()).toContain(`${GRID_ADDON}:42.layout`)
    expect(settingsRow(`${BLOCKS}:42.layout`)).toBeNull()
  })

  it('applies the same move as an addon-owned plan (applyPlan)', async () => {
    const out = target([]).applyPlan({
      meta: meta(BLOCKS, 'grid-to-block', 1),
      plan: movePlan(),
      bootId: 'boot-1',
      codeVersion: '1.0.0',
    })
    expect(out).toMatchObject({ status: 'applied', error: null })
    expect(deviceRow(42)).toEqual({ deviceId: 42, addonId: BLOCKS, stableId: 'composed-blk1' })
    expect(
      (await engine.get({ owner: BLOCKS, kind: 'composed-blocks', id: 'blk1' }))?.data.mark,
    ).toBe('marked-survives')
  })
})

describe('tombstoneDevice', () => {
  it('deletes the row, records the D865 tombstone and clears the device settings, in the plan transaction', async () => {
    const t = target([
      {
        meta: meta('hub', 'retire-grid', 1),
        plan: () => ({
          edits: [tombstoneDeviceEdit(43, { addonId: GRID_ADDON, stableId: 'grid-2' })],
        }),
      },
    ])
    expect(t.apply(PASS).outcomes[0]?.outcome).toBe('applied')
    expect(deviceRow(43)).toBeUndefined()
    const tomb = await engine.get({ owner: 'device-manager', kind: 'tombstones', id: '43' })
    expect(tomb?.data).toMatchObject({ providerAddonId: GRID_ADDON })
    expect(settingsIds()).toEqual([`${GRID_ADDON}:42.layout`, 'recorder:42.recordingConfig'])
    expect(db.prepare('SELECT id FROM "device-runtime-state" ORDER BY id').all()).toEqual([
      { id: '42' },
    ])
  })

  it('a failure after it puts the device, its settings and no tombstone back', async () => {
    const t = target([
      {
        meta: meta('hub', 'retire-grid', 1),
        plan: () => ({
          edits: [
            tombstoneDeviceEdit(43, { addonId: GRID_ADDON, stableId: 'grid-2' }),
            { op: 'deleteRow', table: 'no_such_table', key: { id: 1 } },
          ],
        }),
      },
    ])
    expect(t.apply(PASS).outcomes[0]?.outcome).toBe('failed')
    expect(deviceRow(43)).toEqual({ deviceId: 43, addonId: GRID_ADDON, stableId: 'grid-2' })
    expect(await engine.get({ owner: 'device-manager', kind: 'tombstones', id: '43' })).toBeNull()
    expect(settingsIds()).toContain('recorder:43.recordingConfig')
  })
})

describe('refusals', () => {
  const applyAs = (owner: string, plan: MigrationPlan) =>
    target([]).applyPlan({ meta: meta(owner, 'x', 1), plan, bootId: 'b', codeVersion: '1' })

  it('an addon plan may not write another owner’s records', () => {
    const out = applyAs('ecowitt', movePlan())
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/may write only its own record kinds/)
  })

  it('an addon plan may not re-key or tombstone a device it neither owns nor adopts', () => {
    const read = { addonId: 'other', stableId: 'x-1' }
    expect(applyAs(BLOCKS, { edits: [tombstoneDeviceEdit(44, read)] }).error).toMatch(
      /may delete only its own devices/,
    )
    expect(
      applyAs(BLOCKS, {
        edits: [rekeyDeviceEdit(44, read, { addonId: 'other', stableId: 'x-2' })],
      }).error,
    ).toMatch(/may re-key only a device it owns or adopts/)
    expect(deviceRow(44)).toEqual({ deviceId: 44, addonId: 'other', stableId: 'x-1' })
  })

  it('a re-key onto an identity another device holds, or from a stale read, is refused', () => {
    const taken = applyAs('hub', {
      edits: [
        rekeyDeviceEdit(
          42,
          { addonId: GRID_ADDON, stableId: 'grid-1' },
          { addonId: GRID_ADDON, stableId: 'grid-2' },
        ),
      ],
    })
    expect(taken.error).toMatch(/already belongs to another device/)
    const stale = applyAs('hub', {
      edits: [
        {
          op: 'rekeyDevice',
          deviceId: 42,
          addonId: BLOCKS,
          stableId: 'b',
          precondition: deviceIdentityPrecondition({ addonId: GRID_ADDON, stableId: 'old' }),
        },
      ],
    })
    expect(stale.error).toMatch(/precondition failed for rekeyDevice/)

    db.prepare('INSERT INTO "addon-device-settings" VALUES (?, ?)').run(
      `${BLOCKS}:42.layout`,
      '{"value":"already here"}',
    )
    const clash = applyAs('hub', {
      edits: [
        rekeyDeviceEdit(
          42,
          { addonId: GRID_ADDON, stableId: 'grid-1' },
          { addonId: BLOCKS, stableId: 'b' },
        ),
      ],
    })
    expect(clash.error).toMatch(/already has setting "layout"/)
    expect(deviceRow(42)).toEqual({ deviceId: 42, addonId: GRID_ADDON, stableId: 'grid-1' })
  })

  it('a record body the kind schema refuses never becomes an edit', () => {
    expect(() =>
      recordUpsertEdit({
        owner: BLOCKS,
        kind: kinds['composed-blocks'],
        id: 'bad',
        deviceId: 42,
        // @ts-expect-error -- the body the schema refuses, on purpose
        data: { blockId: 'bad' },
      }),
    ).toThrow(/composed-blocks\/bad/)
  })
})

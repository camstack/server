/**
 * The offline quantity-field migration (planning issue #260), proved on files
 * written by the REAL storage engines: the settings file through
 * `SqliteSettingsBackend` + `RecordsEngine`, the history file through the
 * device-history declarations. A hand-rolled schema would pass by accident.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RecordsEngine } from '../../packages/system/src/builtins/sqlite-storage/records/records-engine.ts'
import { SqliteSettingsBackend } from '../../packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts'
import {
  declaration,
  silentLogger,
} from '../../packages/system/src/builtins/sqlite-storage/__tests__/support/records-harness.ts'
import { HISTORY_DECLARATIONS } from '../../packages/system/src/builtins/device-history/store/history-schema.ts'
import {
  EXIT_OK,
  EXIT_REFUSED,
  runMigration,
  type MigrationOptions,
  type MigrationResult,
} from '../migrations/quantity-field-migration.ts'
import { renamedHistoryKey } from '../migrations/quantity-field-renames.ts'

let dir: string
let settingsDb: string
let historyDb: string
let lines: string[]

const NO_OPENERS = { probe: () => ({ kind: 'openers', pids: [] }) } as const

function options(over: Partial<MigrationOptions> = {}): MigrationOptions {
  return {
    mode: 'apply',
    settingsDb,
    historyDb,
    backupDir: path.join(dir, 'backup'),
    assumeStopped: false,
    minIdleSeconds: 0,
    out: (line) => void lines.push(line),
    liveness: NO_OPENERS,
    ...over,
  }
}

function run(over: Partial<MigrationOptions> = {}): MigrationResult {
  return runMigration(options(over))
}

// ── fixture: a hub's files, written by the real engines ────────────────────────

const RUNTIME_STATE_101 = {
  'power-meter': {
    watts: 12.5,
    kwhTotal: 3,
    volts: 230,
    amps: 0.05,
    va: 12,
    extra: 1,
  },
  battery: { percentage: 80, volts: 3.7, charging: false },
  weather: { temperature: 21 },
  'temperature-sensor': { celsius: 20.1 },
  $owned: {
    'power-meter': {
      owner: 'x',
      mode: 'merge',
      fields: ['watts', 'volts'],
      values: { watts: 12.5 },
    },
    battery: {
      owner: 'x',
      mode: 'merge',
      fields: ['volts'],
      values: { volts: 3.7 },
    },
  },
}
/** Both names already present: the NEW key wins and the old one is dropped. */
const RUNTIME_STATE_102 = { 'power-meter': { watts: 1, power: 99 } }
/** presence.batteryPercent moved to the battery cap: the owner repopulates it, the stale key goes. */
const RUNTIME_STATE_103 = {
  presence: { batteryPercent: 55, present: true },
  $owned: {
    presence: {
      owner: 'x',
      mode: 'merge',
      fields: ['batteryPercent', 'present'],
      values: { batteryPercent: 55 },
    },
  },
}

const COMPOSITION = {
  source: { kind: 'composition' },
  from: [
    { cap: 'power-meter', fieldPath: 'watts' },
    { cap: 'battery', fieldPath: 'volts' },
    { cap: 'power-meter', fieldPath: 'volts' },
    { cap: 'weather', fieldPath: 'temperature' },
  ],
  features: [
    {
      kind: 'fields',
      cap: 'battery',
      fields: { percentage: { label: 'Level' }, volts: { label: 'V' } },
    },
  ],
  series: { read: { cap: 'media-player', fieldPath: 'positionMs' } },
}
const RECIPE = {
  source: { kind: 'recipe' },
  conditions: [{ cap: 'temperature-sensor', fieldPath: 'celsius' }],
  actions: [{ kind: 'cap', cap: 'power-meter', method: 'reset', args: { watts: 0 } }],
  code: 'return ctx.read.watts > 5',
}
/**
 * The shapes main added after the migration was first written: an automation
 * recipe whose conditions are a tree (leaf, expression with field and global
 * bindings, the `stationary-present` leaf that carries NO field), a `device-state`
 * and a `stationary` trigger, and a Customize keyed-array override whose
 * `source` is itself a `(cap, fieldPath)` pair.
 */
const AUTOMATION = {
  triggers: [
    { kind: 'device-state', deviceId: 7, cap: 'power-meter', fieldPath: 'watts', edge: true },
    { kind: 'stationary', deviceId: 7, zones: ['porch'] },
  ],
  conditions: {
    kind: 'all',
    children: [
      {
        kind: 'condition',
        deviceId: 7,
        cap: 'battery',
        fieldPath: 'percentage',
        operator: 'lt',
        value: 20,
      },
      { kind: 'stationary-present', deviceId: 7, className: 'package' },
      {
        kind: 'not',
        child: {
          kind: 'expression',
          expr: 'a > 3 && b < 5',
          bindings: {
            a: {
              kind: 'field',
              sourceKey: 'self',
              cap: 'temperature-sensor',
              fieldPath: 'celsius',
            },
            b: {
              kind: 'global',
              sourceStableId: 'x',
              cap: 'media-player',
              fieldPath: 'durationMs',
            },
          },
        },
      },
    ],
  },
  actions: [],
}
const CUSTOMIZATION = {
  overrides: [
    {
      kind: 'keyedArray',
      cap: 'consumables',
      targetId: 't',
      key: 'k',
      label: 'L',
      fieldPath: 'level',
      source: { addonId: 'a', stableId: 's', cap: 'battery', fieldPath: 'percentage' },
      transform: { kind: 'identity' },
    },
  ],
}
const RULE = {
  name: 'cold',
  conditions: [{ cap: 'temperature-sensor', fieldPath: 'celsius' }],
}

const OSD = {
  sources: [
    { kind: 'device-state', capName: 'power-meter', valuePath: 'watts' },
    { kind: 'device-state', capName: 'battery', valuePath: 'volts' },
    { kind: 'device-state', capName: 'weather', valuePath: 'temperature' },
  ],
}

/** Customize targets: the target id IS the field. Only power-meter's is renamed. */
const CUSTOMIZE = {
  draft: { kind: 'scalar', cap: 'power-meter', targetId: 'watts' },
  decoy: { kind: 'scalar', cap: 'weather', targetId: 'watts' },
}

/** Stored calls: argument keys follow the rename in the context of (cap, method) ONLY. */
const AUTOMATION_ACTIONS = {
  actions: [
    {
      kind: 'cap',
      deviceId: 1,
      cap: 'brightness',
      method: 'setBrightness',
      args: { percentage: 77 },
    },
    {
      kind: 'cap',
      deviceId: 1,
      cap: 'fan-control',
      method: 'setPercentage',
      args: { percentage: 66 },
    },
    { kind: 'cap', deviceId: 1, cap: 'media-player', method: 'seek', args: { positionMs: 4321 } },
    {
      kind: 'cap',
      deviceId: 1,
      cap: 'color',
      method: 'setColor',
      args: { mode: 'mired', mireds: 333 },
    },
    // same key, same cap, another method -> left alone (counted as an advisory)
    { kind: 'cap', deviceId: 1, cap: 'brightness', method: 'toggle', args: { percentage: 5 } },
    // same method name on another cap -> left alone
    { kind: 'cap', deviceId: 1, cap: 'light-x', method: 'setBrightness', args: { percentage: 9 } },
  ],
  note: { percentage: 12 },
}

/** Event payloads: addressed by (cap, event); a battery status event nests the cap's fields. */
const EVENT_PAYLOADS = {
  brightness: {
    cap: 'brightness',
    event: 'onBrightnessChanged',
    payload: { deviceId: 1, percentage: 41 },
  },
  color: { eventName: 'color.onColorChanged', data: { mireds: 250 } },
  battery: {
    cap: 'battery',
    event: 'onStatusChanged',
    payload: { deviceId: 1, status: { percentage: 88, volts: 3.3, charging: false } },
  },
  decoy: { cap: 'battery', event: 'onOther', payload: { percentage: 1 } },
}

/** `<cap>.<field>` as text: values and keys; prose and other caps stay. */
const QUALIFIED = {
  field: 'power-meter.watts',
  history: 'cap:battery.percentage',
  byKey: { 'temperature-sensor.celsius': 1 },
  prose: 'the power-meter.watts reading is high',
  other: 'weather.temperature',
}

/** Adopted-device configs keyed by the old field names; the decoys lack the sibling keys that identify the shape. */
const PROVIDER_CONFIGS = {
  'ha:1': {
    meterEntities: { watts: 'sensor.p', kwhTotal: 'sensor.e', volts: 'sensor.v' },
    children: [{ meterEntities: { amps: 'sensor.a' } }],
  },
  'mqtt:1': { brokerId: 'b', entityKey: 'k', meter: { watts: 'topic/w', volts: 'topic/v' } },
  'mqtt:decoy': { meter: { watts: 'keep' } },
  'esp:1': {
    kind: 'power-meter',
    brokerId: 'b',
    slots: { watts: 'e1' },
    slotUnits: { watts: 'W' },
  },
  'esp:decoy': { kind: 'battery', brokerId: 'b', slots: { watts: 'e1' } },
}

async function writeSettingsFile(): Promise<void> {
  const backend = new SqliteSettingsBackend(settingsDb)
  await backend.initialize()
  await backend.set({
    collection: 'device-runtime-state',
    key: '101',
    value: RUNTIME_STATE_101,
  })
  await backend.set({
    collection: 'device-runtime-state',
    key: '102',
    value: RUNTIME_STATE_102,
  })
  await backend.set({
    namespace: 'osd-manager',
    collection: 'addon-settings',
    key: 'bindings',
    value: OSD,
  })
  await backend.set({
    collection: 'addon-device-settings',
    key: 'exporter:101:binding',
    value: { cap: 'humidity-sensor', fieldPath: 'percent' },
  })
  await backend.set({
    collection: 'device-runtime-state',
    key: '103',
    value: RUNTIME_STATE_103,
  })
  await backend.set({ collection: 'addon-device-settings', key: 'customize:101', value: CUSTOMIZE })
  await backend.set({
    collection: 'addon-device-settings',
    key: 'events:101',
    value: EVENT_PAYLOADS,
  })
  await backend.set({ collection: 'system-settings', key: 'qualified', value: QUALIFIED })
  for (const [key, value] of Object.entries(PROVIDER_CONFIGS)) {
    await backend.set({ collection: 'addon-device-settings', key, value })
  }
  await backend.set({
    collection: 'system-settings',
    key: 'misc',
    value: { volts: 5, watts: 6 },
  })
  const db = backend.getDatabase()
  if (db === null) throw new Error('settings database not open')
  const engine = new RecordsEngine(db, {
    databaseId: 'settings',
    logger: silentLogger(),
    now: () => 1_000_000,
  })
  const flat = declaration({ device: 'none', at: 'none' })
  await engine.declareKinds({ owner: 'core-blocks', kinds: { blocks: flat } })
  await engine.declareKinds({
    owner: 'pipeline-analytics',
    kinds: { rules: flat },
  })
  await engine.put({
    owner: 'core-blocks',
    kind: 'blocks',
    record: { id: 'comp-1', data: COMPOSITION },
  })
  await engine.put({
    owner: 'core-blocks',
    kind: 'blocks',
    record: { id: 'recipe-1', data: RECIPE },
  })
  await engine.put({
    owner: 'core-blocks',
    kind: 'blocks',
    record: { id: 'auto-1', data: AUTOMATION },
  })
  await engine.put({
    owner: 'core-blocks',
    kind: 'blocks',
    record: { id: 'custom-1', data: CUSTOMIZATION },
  })
  await engine.put({
    owner: 'core-blocks',
    kind: 'blocks',
    record: { id: 'actions-1', data: AUTOMATION_ACTIONS },
  })
  await engine.put({
    owner: 'pipeline-analytics',
    kind: 'rules',
    record: { id: 'rule-1', data: RULE },
  })
  await backend.shutdown()
}

interface SeedSeries {
  readonly key: string
  readonly subject: string
  readonly points: readonly number[]
}

const SERIES: readonly SeedSeries[] = [
  { key: 'cap:power-meter.watts', subject: 'device:1', points: [10, 20, 30] },
  { key: 'cap:power-meter.power', subject: 'device:1', points: [20, 40] },
  { key: 'cap:battery.percentage', subject: 'device:2', points: [5] },
  { key: 'cap:battery.volts', subject: 'device:2', points: [7] },
  { key: 'cap:power-meter.volts', subject: 'device:2', points: [9] },
  { key: 'cap:weather.temperature', subject: 'device:1', points: [1] },
  // presence.batteryPercent: moved when the device has no battery level yet ...
  { key: 'cap:presence.batteryPercent', subject: 'device:3', points: [61, 62] },
  // ... dropped when it has one ...
  { key: 'cap:presence.batteryPercent', subject: 'device:4', points: [71] },
  { key: 'cap:battery.level', subject: 'device:4', points: [72] },
  // ... and dropped when the level only exists through the battery.percentage rename.
  { key: 'cap:presence.batteryPercent', subject: 'device:5', points: [81] },
  { key: 'cap:battery.percentage', subject: 'device:5', points: [82] },
]

async function writeHistoryFile(): Promise<void> {
  const backend = new SqliteSettingsBackend(historyDb)
  await backend.initialize()
  for (const d of HISTORY_DECLARATIONS) await backend.declareCollection(d)
  const db = backend.getDatabase()
  if (db === null) throw new Error('history database not open')
  const metric = db.prepare(
    'INSERT INTO "device-history:metrics" (key, source, owner_addon, subject_kind, kind, display_name, ingest, declared_at) ' +
      "VALUES (?, 'cap', 'device-history', 'device', 'gauge', ?, 'points', 1)",
  )
  const series = db.prepare(
    'INSERT INTO "device-history:series" (key, subject, device_id, scope, first_ts, last_ts) VALUES (?, ?, 1, \'\', ?, ?)',
  )
  const raw = db.prepare('INSERT INTO "device-history:raw" (series_id, ts, value) VALUES (?, ?, ?)')
  const rollup = db.prepare(
    'INSERT INTO "device-history:rollup-1h" (series_id, bucket_start, samples, sum, min, max) VALUES (?, ?, 1, ?, ?, ?)',
  )
  for (const key of new Set(SERIES.map((s) => s.key))) metric.run(key, key)
  for (const seed of SERIES) {
    const id = Number(series.run(seed.key, seed.subject, 10, 40).lastInsertRowid)
    for (const ts of seed.points) {
      raw.run(id, ts, ts * 2)
      rollup.run(id, ts * 3_600_000, ts, ts, ts)
    }
  }
  await backend.shutdown()
}

function age(file: string): void {
  const old = new Date(Date.now() - 3_600_000)
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${file}${suffix}`)) fs.utimesSync(`${file}${suffix}`, old, old)
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-quantity-migration-'))
  settingsDb = path.join(dir, 'camstack.db')
  historyDb = path.join(dir, 'history.db')
  lines = []
  await writeSettingsFile()
  await writeHistoryFile()
  age(settingsDb)
  age(historyDb)
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// ── reads ──────────────────────────────────────────────────────────────────────

function withDb<T>(file: string, read: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function kvRow(table: string, id: string): unknown {
  return withDb(settingsDb, (db) => {
    const row = db
      .prepare<[string], { data: string }>(`SELECT data FROM "${table}" WHERE id = ?`)
      .get(id)
    return row === undefined ? undefined : JSON.parse(row.data)
  })
}

function recordRow(kind: string, id: string): unknown {
  return withDb(settingsDb, (db) => {
    const row = db
      .prepare<[string, string], { json: string }>(
        'SELECT json(r.data) AS json FROM records r JOIN _record_kinds k ON k.kind_id = r.kind_id WHERE k.kind = ? AND r.id = ?',
      )
      .get(kind, id)
    return row === undefined ? undefined : JSON.parse(row.json)
  })
}

function seriesKeys(): string[] {
  return withDb(historyDb, (db) =>
    db
      .prepare<[], { key: string; subject: string }>(
        'SELECT key, subject FROM "device-history:series" ORDER BY key, subject',
      )
      .all()
      .map((row) => `${row.key}|${row.subject}`),
  )
}

function pointTs(key: string, subject: string): number[] {
  return withDb(historyDb, (db) =>
    db
      .prepare<[string, string], { ts: number }>(
        'SELECT r.ts FROM "device-history:raw" r JOIN "device-history:series" s ON s.id = r.series_id WHERE s.key = ? AND s.subject = ? ORDER BY r.ts',
      )
      .all(key, subject)
      .map((row) => row.ts),
  )
}

function hash(file: string): string {
  return fs.readFileSync(file).toString('base64')
}

// ── the cases ──────────────────────────────────────────────────────────────────

describe('quantity-field migration', () => {
  it('a dry run prints the per-store table and writes nothing', () => {
    const before = [hash(settingsDb), hash(historyDb)]
    const result = run({ mode: 'dry-run' })
    expect(result.exitCode).toBe(EXIT_OK)
    expect([hash(settingsDb), hash(historyDb)]).toEqual(before)
    const text = lines.join('\n')
    expect(text).toContain('device-runtime-state')
    expect(text).toContain('power-meter.watts')
    expect(text).toContain('-> power')
    expect(text).toContain('records[core-blocks/blocks]')
    expect(text).toContain('device-history:series')
    expect(fs.existsSync(path.join(dir, 'backup'))).toBe(false)
  })

  it('rewrites the runtime state: renamed keys, claims, merged collision, other caps untouched', () => {
    expect(run().exitCode).toBe(EXIT_OK)
    expect(kvRow('device-runtime-state', '101')).toEqual({
      'power-meter': {
        power: 12.5,
        energy: 3,
        voltage: 230,
        current: 0.05,
        apparentPower: 12,
        extra: 1,
      },
      battery: { level: 80, voltage: 3.7, charging: false },
      weather: { temperature: 21 },
      'temperature-sensor': { temperature: 20.1 },
      $owned: {
        'power-meter': {
          owner: 'x',
          mode: 'merge',
          fields: ['power', 'voltage'],
          values: { power: 12.5 },
        },
        battery: {
          owner: 'x',
          mode: 'merge',
          fields: ['voltage'],
          values: { voltage: 3.7 },
        },
      },
    })
    expect(kvRow('device-runtime-state', '102')).toEqual({
      'power-meter': { power: 99 },
    })
  })

  it('rewrites the stored references of every kind, by (cap, field) only', () => {
    expect(run().exitCode).toBe(EXIT_OK)
    expect(recordRow('blocks', 'comp-1')).toEqual({
      source: { kind: 'composition' },
      from: [
        { cap: 'power-meter', fieldPath: 'power' },
        { cap: 'battery', fieldPath: 'voltage' },
        { cap: 'power-meter', fieldPath: 'voltage' },
        { cap: 'weather', fieldPath: 'temperature' },
      ],
      features: [
        {
          kind: 'fields',
          cap: 'battery',
          fields: { level: { label: 'Level' }, voltage: { label: 'V' } },
        },
      ],
      series: { read: { cap: 'media-player', fieldPath: 'position' } },
    })
    expect(recordRow('blocks', 'recipe-1')).toMatchObject({
      conditions: [{ cap: 'temperature-sensor', fieldPath: 'temperature' }],
    })
    expect(recordRow('rules', 'rule-1')).toEqual({
      name: 'cold',
      conditions: [{ cap: 'temperature-sensor', fieldPath: 'temperature' }],
    })
    expect(kvRow('osd-manager:addon-settings', 'bindings')).toEqual({
      sources: [
        { kind: 'device-state', capName: 'power-meter', valuePath: 'power' },
        { kind: 'device-state', capName: 'battery', valuePath: 'voltage' },
        { kind: 'device-state', capName: 'weather', valuePath: 'temperature' },
      ],
    })
    expect(kvRow('addon-device-settings', 'exporter:101:binding')).toEqual({
      cap: 'humidity-sensor',
      fieldPath: 'humidity',
    })
    expect(kvRow('system-settings', 'misc')).toEqual({ volts: 5, watts: 6 })
  })

  it('rewrites an automation recipe tree, a stationary trigger and a Customize override source', () => {
    expect(run().exitCode).toBe(EXIT_OK)
    expect(recordRow('blocks', 'auto-1')).toEqual({
      triggers: [
        { kind: 'device-state', deviceId: 7, cap: 'power-meter', fieldPath: 'power', edge: true },
        { kind: 'stationary', deviceId: 7, zones: ['porch'] },
      ],
      conditions: {
        kind: 'all',
        children: [
          {
            kind: 'condition',
            deviceId: 7,
            cap: 'battery',
            fieldPath: 'level',
            operator: 'lt',
            value: 20,
          },
          { kind: 'stationary-present', deviceId: 7, className: 'package' },
          {
            kind: 'not',
            child: {
              kind: 'expression',
              expr: 'a > 3 && b < 5',
              bindings: {
                a: {
                  kind: 'field',
                  sourceKey: 'self',
                  cap: 'temperature-sensor',
                  fieldPath: 'temperature',
                },
                b: {
                  kind: 'global',
                  sourceStableId: 'x',
                  cap: 'media-player',
                  fieldPath: 'duration',
                },
              },
            },
          },
        ],
      },
      actions: [],
    })
    expect(recordRow('blocks', 'custom-1')).toEqual({
      overrides: [
        {
          kind: 'keyedArray',
          cap: 'consumables',
          targetId: 't',
          key: 'k',
          label: 'L',
          fieldPath: 'level',
          source: { addonId: 'a', stableId: 's', cap: 'battery', fieldPath: 'level' },
          transform: { kind: 'identity' },
        },
      ],
    })
  })

  it('reports what it cannot rewrite (free code, action arguments) and leaves it alone', () => {
    run({ mode: 'dry-run' })
    const text = lines.join('\n')
    expect(text).toContain('ADVISORY code mentions watts')
    expect(text).toContain('ADVISORY action arg power-meter.watts')
    run()
    expect(recordRow('blocks', 'recipe-1')).toMatchObject({
      code: 'return ctx.read.watts > 5',
      actions: [{ args: { watts: 0 } }],
    })
  })

  it('renames history series, merges onto an existing new key, keeps unrelated keys', () => {
    expect(run().exitCode).toBe(EXIT_OK)
    expect(seriesKeys()).toEqual(
      expect.arrayContaining([
        'cap:battery.level|device:2',
        'cap:battery.voltage|device:2',
        'cap:power-meter.power|device:1',
        'cap:power-meter.voltage|device:2',
        'cap:weather.temperature|device:1',
      ]),
    )
    // watts [10,20,30] merged into power [20,40]: the existing point at 20 wins, nothing is lost.
    expect(pointTs('cap:power-meter.power', 'device:1')).toEqual([10, 20, 30, 40])
    const rollups = withDb(historyDb, (db) =>
      db.prepare<[], { n: number }>('SELECT count(*) AS n FROM "device-history:rollup-1h"').get(),
    )
    expect(rollups?.n).toBe(12)
    const metrics = withDb(historyDb, (db) =>
      db
        .prepare<[], { key: string }>('SELECT key FROM "device-history:metrics" ORDER BY key')
        .all()
        .map((r) => r.key),
    )
    expect(metrics).toEqual([
      'cap:battery.level',
      'cap:battery.voltage',
      'cap:power-meter.power',
      'cap:power-meter.voltage',
      'cap:weather.temperature',
    ])
  })

  it('the history key map agrees with the cap map', () => {
    expect(renamedHistoryKey('cap:power-meter.watts')).toBe('cap:power-meter.power')
    expect(renamedHistoryKey('cap:battery.volts')).toBe('cap:battery.voltage')
    expect(renamedHistoryKey('cap:weather.temperature')).toBeNull()
  })

  it('renames a Customize target id by its cap, and only that cap', () => {
    run()
    expect(kvRow('addon-device-settings', 'customize:101')).toEqual({
      draft: { kind: 'scalar', cap: 'power-meter', targetId: 'power' },
      decoy: { kind: 'scalar', cap: 'weather', targetId: 'watts' },
    })
  })

  it('renames stored call arguments in the context of (cap, method) only', () => {
    run()
    expect(recordRow('blocks', 'actions-1')).toEqual({
      actions: [
        {
          kind: 'cap',
          deviceId: 1,
          cap: 'brightness',
          method: 'setBrightness',
          args: { level: 77 },
        },
        {
          kind: 'cap',
          deviceId: 1,
          cap: 'fan-control',
          method: 'setPercentage',
          args: { speed: 66 },
        },
        { kind: 'cap', deviceId: 1, cap: 'media-player', method: 'seek', args: { position: 4321 } },
        {
          kind: 'cap',
          deviceId: 1,
          cap: 'color',
          method: 'setColor',
          args: { mode: 'mired', colorTemperature: 333 },
        },
        { kind: 'cap', deviceId: 1, cap: 'brightness', method: 'toggle', args: { percentage: 5 } },
        {
          kind: 'cap',
          deviceId: 1,
          cap: 'light-x',
          method: 'setBrightness',
          args: { percentage: 9 },
        },
      ],
      note: { percentage: 12 },
    })
  })

  it('renames event payload keys by (cap, event), the battery status one level down', () => {
    run()
    expect(kvRow('addon-device-settings', 'events:101')).toEqual({
      brightness: {
        cap: 'brightness',
        event: 'onBrightnessChanged',
        payload: { deviceId: 1, level: 41 },
      },
      color: { eventName: 'color.onColorChanged', data: { colorTemperature: 250 } },
      battery: {
        cap: 'battery',
        event: 'onStatusChanged',
        payload: { deviceId: 1, status: { level: 88, voltage: 3.3, charging: false } },
      },
      decoy: { cap: 'battery', event: 'onOther', payload: { percentage: 1 } },
    })
  })

  it('renames a <cap>.<field> text, as a value and as a key, and nothing that is only prose', () => {
    run()
    expect(kvRow('system-settings', 'qualified')).toEqual({
      field: 'power-meter.power',
      history: 'cap:battery.level',
      byKey: { 'temperature-sensor.temperature': 1 },
      prose: 'the power-meter.watts reading is high',
      other: 'weather.temperature',
    })
  })

  it('renames provider configs keyed by field names, only where the sibling keys identify the shape', () => {
    run()
    expect(kvRow('addon-device-settings', 'ha:1')).toEqual({
      meterEntities: { power: 'sensor.p', energy: 'sensor.e', voltage: 'sensor.v' },
      children: [{ meterEntities: { current: 'sensor.a' } }],
    })
    expect(kvRow('addon-device-settings', 'mqtt:1')).toEqual({
      brokerId: 'b',
      entityKey: 'k',
      meter: { power: 'topic/w', voltage: 'topic/v' },
    })
    expect(kvRow('addon-device-settings', 'mqtt:decoy')).toEqual(PROVIDER_CONFIGS['mqtt:decoy'])
    expect(kvRow('addon-device-settings', 'esp:1')).toEqual({
      kind: 'power-meter',
      brokerId: 'b',
      slots: { power: 'e1' },
      slotUnits: { power: 'W' },
    })
    expect(kvRow('addon-device-settings', 'esp:decoy')).toEqual(PROVIDER_CONFIGS['esp:decoy'])
  })

  it('drops the stale presence.batteryPercent from runtime state and counts it', () => {
    run()
    expect(kvRow('device-runtime-state', '103')).toEqual({
      presence: { present: true },
      $owned: {
        presence: { owner: 'x', mode: 'merge', fields: ['present'], values: {} },
      },
    })
    expect(lines.join('\n')).toMatch(/presence\.batteryPercent/)
  })

  it('moves presence.batteryPercent history to battery.level, or drops it when the device has one', () => {
    expect(run().exitCode).toBe(EXIT_OK)
    expect(seriesKeys()).toEqual([
      'cap:battery.level|device:2',
      'cap:battery.level|device:3',
      'cap:battery.level|device:4',
      'cap:battery.level|device:5',
      'cap:battery.voltage|device:2',
      'cap:power-meter.power|device:1',
      'cap:power-meter.voltage|device:2',
      'cap:weather.temperature|device:1',
    ])
    expect(pointTs('cap:battery.level', 'device:3')).toEqual([61, 62])
    // the device already had a level: its own points stay, the stale ones are gone
    expect(pointTs('cap:battery.level', 'device:4')).toEqual([72])
    expect(pointTs('cap:battery.level', 'device:5')).toEqual([82])
    const stale = withDb(historyDb, (db) =>
      db
        .prepare<[], { n: number }>(
          'SELECT count(*) AS n FROM "device-history:metrics" WHERE key = \'cap:presence.batteryPercent\'',
        )
        .get(),
    )
    expect(stale?.n).toBe(0)
    expect(lines.join('\n')).toMatch(/moved/i)
  })

  it('backs up every file it touches before writing, and the backup is the old content', () => {
    const settingsBefore = hash(settingsDb)
    const result = run()
    expect(result.backupDir).toBe(path.join(dir, 'backup'))
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'backup', 'manifest.json'), 'utf8'))
    const originals = manifest.entries.map((entry: { original: string }) => entry.original)
    expect(originals).toContain(settingsDb)
    expect(originals).toContain(historyDb)
    const copy = manifest.entries.find(
      (entry: { original: string }) => entry.original === settingsDb,
    )
    expect(fs.readFileSync(copy.copy).toString('base64')).toBe(settingsBefore)
  })

  it('is idempotent: a second apply changes nothing and writes no second backup', () => {
    expect(run().exitCode).toBe(EXIT_OK)
    const after = [hash(settingsDb), hash(historyDb)]
    lines.length = 0
    const second = run({ backupDir: path.join(dir, 'backup-2') })
    expect(second.exitCode).toBe(EXIT_OK)
    expect([hash(settingsDb), hash(historyDb)]).toEqual(after)
    expect(fs.existsSync(path.join(dir, 'backup-2'))).toBe(false)
    expect(lines.join('\n')).toContain('nothing to change')
  })

  it('refuses when a process holds the database open, and touches nothing', () => {
    const before = [hash(settingsDb), hash(historyDb)]
    const result = run({
      liveness: { probe: () => ({ kind: 'openers', pids: [4242] }) },
    })
    expect(result.exitCode).toBe(EXIT_REFUSED)
    expect(lines.join('\n')).toContain('held open by process 4242')
    expect([hash(settingsDb), hash(historyDb)]).toEqual(before)
    expect(fs.existsSync(path.join(dir, 'backup'))).toBe(false)
  })

  it('refuses when a file was written a moment ago', () => {
    fs.utimesSync(settingsDb, new Date(), new Date())
    const result = run({ minIdleSeconds: 30 })
    expect(result.exitCode).toBe(EXIT_REFUSED)
    expect(lines.join('\n')).toMatch(/camstack\.db was written \d+s ago/)
  })

  it('fails closed when it cannot tell, unless the operator says the hub is stopped', () => {
    const cannotTell = {
      probe: () => ({ kind: 'unavailable', reason: 'no lsof' }),
    } as const
    expect(run({ liveness: cannotTell }).exitCode).toBe(EXIT_REFUSED)
    expect(run({ liveness: cannotTell, assumeStopped: true }).exitCode).toBe(EXIT_OK)
  })

  it('exits non-zero and leaves the backup when the post-write recount disagrees', () => {
    // A trigger that re-creates an old-name key after every rewrite: the recount must catch it.
    const db = new Database(settingsDb)
    db.exec(
      `CREATE TRIGGER resurrect AFTER UPDATE ON "device-runtime-state" BEGIN
         UPDATE "device-runtime-state" SET data = replace(data, '"power"', '"watts"') WHERE id = NEW.id AND id = '101' AND data LIKE '%"power"%';
       END`,
    )
    db.close()
    age(settingsDb)
    const result = run()
    expect(result.exitCode).toBe(1)
    expect(result.backupDir).not.toBeNull()
    expect(fs.existsSync(path.join(dir, 'backup', 'manifest.json'))).toBe(true)
    // The transaction rolled back: the file still holds the old data.
    expect(kvRow('device-runtime-state', '101')).toEqual(RUNTIME_STATE_101)
  })
})

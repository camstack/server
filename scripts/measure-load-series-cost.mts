/**
 * Measure the ON-DISK cost of the durable load series.
 *
 * Not an estimate: it drives the REAL engine (`SqliteSettingsBackend`) through
 * its REAL `declareCollection` DDL, writes a realistic fleet payload one
 * transaction per sample, checkpoints the WAL to TRUNCATE, and reads
 * `page_count x page_size` off the resulting file. Table plus index.
 *
 *   npx tsx scripts/measure-load-series-cost.mts            # the shipped shape
 *   npx tsx scripts/measure-load-series-cost.mts --variants # why it is that shape
 *
 * The rule this serves is in `docs/architecture/load-ledger.md`: a load is
 * declared resolved only with the measure, and the measure is written down.
 * Re-run it when the columns change — the number in the ledger is the number
 * this prints, and a stale one is worse than none.
 *
 * NOTE on the payload. The live cluster's process shape (3 nodes at 42 / 20 /
 * 14 rows) is taken from the ledger's own 2026-08-27 measurement. The rows are
 * SYNTHESISED here rather than pulled from production, because reading the live
 * hub needs a token this script must not mint. That affects only the string
 * lengths of `addonId` — every other column is a fixed-width integer — and the
 * addon ids used are the real ones from `docs/reference/addons.md`.
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/** Legacy DDL — the live table moved to device-history (D850); kept for the cost harness. */
const LOAD_SERIES_COLLECTION = 'metrics:node-load-samples'
const LOAD_SERIES_COLUMNS = [
  { name: 'id', type: 'INTEGER' as const, primaryKey: true, notNull: true },
  { name: 'nodeId', type: 'TEXT' as const, notNull: true },
  { name: 'atMs', type: 'INTEGER' as const, notNull: true },
  { name: 'pid', type: 'INTEGER' as const, notNull: true },
  { name: 'addonId', type: 'TEXT' as const },
  { name: 'classification', type: 'TEXT' as const, notNull: true },
  { name: 'cpuDeci', type: 'INTEGER' as const, notNull: true },
  { name: 'rssMib', type: 'INTEGER' as const, notNull: true },
  { name: 'cpuMainDeci', type: 'INTEGER' as const },
  { name: 'cpuGcDeci', type: 'INTEGER' as const },
] as const
const LOAD_SERIES_INDEXES = [
  { name: 'idx_load_samples_node_at', columns: ['nodeId', 'atMs'] as const },
] as const
import { SqliteSettingsBackend } from '../packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.js'

/** The live fleet's measured shape (load ledger, 2026-08-27). */
const NODES: ReadonlyArray<{ nodeId: string; rows: number }> = [
  { nodeId: 'hub', rows: 42 },
  { nodeId: 'agent-a', rows: 20 },
  { nodeId: 'mac-mini-agent', rows: 14 },
]

const ADDONS = [
  'stream-broker',
  'recorder',
  'pipeline-analytics',
  'pipeline-orchestrator',
  'pipeline-runner',
  'detection-pipeline',
  'device-manager',
  'sqlite-settings',
  'storage-orchestrator',
  'admin-ui',
  'notifiers',
  'ai',
  'alert-center',
  'model-studio',
  'embedding-encoder',
  'provider-hikvision',
  'provider-reolink',
  'provider-rtsp',
  'provider-onvif',
  'provider-unifi',
  'metrics-native',
  'local-auth',
  'export-hap',
  'export-alexa',
  'mqtt-broker',
  'homeassistant-export',
  'backup-orchestrator',
  'motion-wasm',
  'osd-manager',
  'liveness-monitor',
  'benchmark',
  'audio-analyzer',
  'platform-probe',
  'filesystem-storage',
  'loki-logging',
]

interface ColumnSpec {
  readonly name: string
  readonly type: 'TEXT' | 'INTEGER' | 'REAL'
  readonly primaryKey?: boolean
  readonly notNull?: boolean
}

interface Shape {
  readonly label: string
  readonly columns: readonly ColumnSpec[]
  readonly indexes: ReadonlyArray<{ name: string; columns: readonly string[] }>
  readonly row: (nodeId: string, atMs: number, i: number, seed: number) => readonly unknown[]
}

function facts(i: number, seed: number) {
  const managed = i > 0 && i < 40
  return {
    addonId: managed ? (ADDONS[i % ADDONS.length] ?? null) : null,
    classification: i === 0 ? 'root' : managed ? 'managed' : 'system',
    pid: 1000 + i * 37 + (seed % 11),
    cpu: Math.round((seed * 7 + i * 13) % 900) / 10,
    rss: 60_000_000 + ((seed * 104_729 + i * 65_537) % 900_000_000),
    main: Math.round((seed * 3 + i * 17) % 1500) / 10,
    gc: Math.round((seed * 5 + i * 19) % 900) / 10,
  }
}

/** The SHIPPED shape — read straight off the store so the two cannot drift. */
const SHIPPED: Shape = {
  label: 'shipped',
  columns: LOAD_SERIES_COLUMNS as readonly ColumnSpec[],
  indexes: LOAD_SERIES_INDEXES.map((i) => ({ name: i.name, columns: [...i.columns] })),
  row: (nodeId, atMs, i, seed) => {
    const f = facts(i, seed)
    return [
      null,
      nodeId,
      atMs,
      f.pid,
      f.addonId,
      f.classification,
      Math.round(f.cpu * 10),
      Math.round(f.rss / 1_048_576),
      Math.round(f.main * 10),
      Math.round(f.gc * 10),
    ]
  },
}

/** The shapes that were rejected, kept so the choice stays checkable. */
const NAIVE: Shape = {
  label: 'naive (TEXT key, 2 idx, every field)',
  columns: [
    { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
    { name: 'nodeId', type: 'TEXT', notNull: true },
    { name: 'atMs', type: 'INTEGER', notNull: true },
    { name: 'pid', type: 'INTEGER', notNull: true },
    { name: 'addonId', type: 'TEXT' },
    { name: 'classification', type: 'TEXT', notNull: true },
    { name: 'cpuPercent', type: 'REAL', notNull: true },
    { name: 'memoryRssBytes', type: 'INTEGER', notNull: true },
    { name: 'cpuMainPercent', type: 'REAL' },
    { name: 'cpuGcPercent', type: 'REAL' },
    { name: 'threadCount', type: 'INTEGER' },
    { name: 'uptimeSec', type: 'INTEGER', notNull: true },
  ],
  indexes: [
    { name: 'idx_naive_node_at', columns: ['nodeId', 'atMs'] },
    { name: 'idx_naive_at', columns: ['atMs'] },
  ],
  row: (nodeId, atMs, i, seed) => {
    const f = facts(i, seed)
    return [
      `${nodeId}|${atMs}|${f.pid}`,
      nodeId,
      atMs,
      f.pid,
      f.addonId,
      f.classification,
      f.cpu,
      f.rss,
      f.main,
      f.gc,
      6 + (i % 12),
      100_000 + seed * 10 + i,
    ]
  },
}

const TEXT_KEY: Shape = {
  label: 'shipped columns + TEXT composite key',
  columns: [
    { name: 'id', type: 'TEXT', primaryKey: true, notNull: true },
    ...(LOAD_SERIES_COLUMNS as readonly ColumnSpec[]).slice(1),
  ],
  indexes: [{ name: 'idx_text_node_at', columns: ['nodeId', 'atMs'] }],
  row: (nodeId, atMs, i, seed) => {
    const f = facts(i, seed)
    return [
      `${nodeId}|${atMs.toString(36)}|${f.pid.toString(36)}`,
      nodeId,
      atMs,
      f.pid,
      f.addonId,
      f.classification,
      Math.round(f.cpu * 10),
      Math.round(f.rss / 1_048_576),
      Math.round(f.main * 10),
      Math.round(f.gc * 10),
    ]
  },
}

async function measure(shape: Shape, cadenceSec: number, retentionHours: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'camstack-load-cost-'))
  const dbPath = join(dir, 'camstack.db')
  const backend = new SqliteSettingsBackend(dbPath)
  await backend.initialize()
  await backend.declareCollection({
    collection: LOAD_SERIES_COLLECTION,
    columns: shape.columns,
    indexes: shape.indexes.map((i) => ({ name: i.name, columns: [...i.columns] })),
  })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  const cols = shape.columns.map((c) => `"${c.name}"`).join(', ')
  const placeholders = shape.columns.map(() => '?').join(', ')
  const stmt = db.prepare(
    `INSERT INTO "${LOAD_SERIES_COLLECTION}" (${cols}) VALUES (${placeholders})`,
  )
  // ONE transaction per sample — the same contract `insertMany` implements.
  const writeSample = db.transaction((rows: ReadonlyArray<readonly unknown[]>) => {
    for (const r of rows) stmt.run(...r)
  })

  const samples = Math.round((retentionHours * 3600) / cadenceSec)
  const start = 1_700_000_000_000
  let totalRows = 0
  let transactions = 0
  const t0 = Date.now()
  for (let s = 0; s < samples; s++) {
    const atMs = start + s * cadenceSec * 1000
    for (const node of NODES) {
      const rows: (readonly unknown[])[] = []
      for (let i = 0; i < node.rows; i++) rows.push(shape.row(node.nodeId, atMs, i, s))
      writeSample(rows)
      totalRows += rows.length
      transactions += 1
    }
  }
  db.pragma('wal_checkpoint(TRUNCATE)')
  const bytes =
    (db.pragma('page_count', { simple: true }) as number) *
    (db.pragma('page_size', { simple: true }) as number)
  const elapsed = (Date.now() - t0) / 1000
  db.close()
  rmSync(dir, { recursive: true, force: true })

  console.log(
    [
      shape.label.padEnd(38),
      `cadence=${String(cadenceSec).padStart(2)}s`,
      `retention=${String(retentionHours).padStart(2)}h`,
      `rows=${totalRows.toLocaleString('en-US').padStart(11)}`,
      `tx=${transactions.toLocaleString('en-US').padStart(8)}`,
      `MiB=${(bytes / 1_048_576).toFixed(1).padStart(7)}`,
      `B/row=${(bytes / totalRows).toFixed(1).padStart(6)}`,
      `write=${elapsed.toFixed(1)}s`,
    ].join('  '),
  )
}

const variants = process.argv.includes('--variants')
if (variants) {
  for (const shape of [NAIVE, TEXT_KEY, SHIPPED]) await measure(shape, 10, 6)
} else {
  for (const cadence of [60, 10, 5]) await measure(SHIPPED, cadence, 6)
  // What the knob's ceiling would want, if the row cap did not stop it.
  await measure(SHIPPED, 5, 72)
}

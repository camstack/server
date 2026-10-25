#!/usr/bin/env node
/**
 * Flatten the recorder's and the stream-broker's settings blobs into rows.
 *
 * ## What it moves
 *
 * Both addons are FORKED, so their `ctx.settings` is
 * `readBlob/mergeBlob('addon-settings', 'root', <addonId>)` — ONE row in the
 * SCOPED table `<addonId>:addon-settings`, holding every top-level key the
 * addon ever persisted, INCLUDING the operator's config fields. Measured on the
 * 2026-08-19 evidence copy:
 *
 *   recorder:addon-settings / root       201 833 B
 *     recordingOpsLog     147 437 B   500 entries   → recorder:ops-log
 *     recordingExports     50 441 B    55 exports   → recorder:exports
 *     recordingConfigs      2 468 B    17 cameras   → recorder:recording-configs
 *     recordingPlacement    1 405 B                 → STAYS a blob key
 *
 *   stream-broker:addon-settings / root   33 155 B
 *     probeSnapshots       17 282 B   109 streams   → stream-broker:probe-snapshots
 *     rtspTokens           13 147 B   243 streams   → stream-broker:rtsp-tokens
 *     profileMap            2 306 B    29 cameras   → stream-broker:profile-map
 *     deviceOverrides         354 B                 → STAYS a blob key
 *     rtspEnabled             absent                → STAYS a blob key
 *
 * Every target row is `id` (the map key) + the columns the owner projects +
 * `value`, the validated payload as JSON. The column NAMES are what matter: on
 * the next boot `declareCollection` compares them against `PRAGMA table_info`,
 * and a declared column the table lacks that SQLite cannot add in place makes
 * the engine DROP and recreate the table — taking every row this wrote. Keep
 * the lists below and the `*_COLUMNS` constants in the addon in lockstep.
 *
 * ## What it does NOT do
 *
 * It does not delete the blob keys. They are the only copy until this has run,
 * and a migration that deletes its own source leaves nothing to re-run against.
 * Each addon drops its own keys at its next boot, and only once the successor
 * collection is non-empty (`retireRootKeys`, wired from the recorder's and the
 * broker's `onInitialize`).
 *
 * ## Running it
 *
 *   node scripts/migrate-recorder-broker-blobs.mjs <path-to-camstack.db>
 *   node scripts/migrate-recorder-broker-blobs.mjs <path-to-camstack.db> --apply
 *
 * Without `--apply` it opens the file READ-ONLY, reports exactly what it would
 * write, and touches nothing.
 *
 * **The hub must be stopped.** Opening a live SQLite file read-write from a
 * second process — especially across a FUSE path such as Unraid's `/mnt/user`,
 * where the kernel and the FUSE layer do not share a page cache — is how this
 * database was corrupted on 2026-08-19. Stop the container, migrate the file at
 * its real location (`/mnt/cache/...`), start it again.
 *
 * Idempotent: re-running upserts the same rows and reports 0 new.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'

/** Every target collection, its DDL and how one blob entry becomes one row. */
const PLANS = [
  {
    addon: 'recorder',
    blobKey: 'recordingOpsLog',
    /** The blob is an ARRAY of entries, not a map — the row key is `entry.id`. */
    shape: 'array',
    table: 'recorder:ops-log',
    columns: [
      '"id" TEXT PRIMARY KEY NOT NULL',
      '"at" INTEGER NOT NULL',
      '"deviceId" INTEGER',
      '"value" TEXT NOT NULL',
    ],
    names: ['id', 'at', 'deviceId', 'value'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS "idx_recorder_ops_log_at" ON "recorder:ops-log" ("at")',
      'CREATE INDEX IF NOT EXISTS "idx_recorder_ops_log_device" ON "recorder:ops-log" ("deviceId")',
    ],
    keyOf: (entry) => (typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null),
    toRow: (key, entry) => {
      if (!Number.isFinite(entry.at)) return null
      return {
        id: key,
        at: entry.at,
        deviceId: Number.isInteger(entry.deviceId) ? entry.deviceId : null,
        value: JSON.stringify(entry),
      }
    },
  },
  {
    addon: 'recorder',
    blobKey: 'recordingExports',
    shape: 'map',
    table: 'recorder:exports',
    columns: [
      '"id" TEXT PRIMARY KEY NOT NULL',
      '"deviceId" INTEGER NOT NULL',
      '"createdAt" INTEGER NOT NULL',
      '"state" TEXT NOT NULL',
      '"value" TEXT NOT NULL',
    ],
    names: ['id', 'deviceId', 'createdAt', 'state', 'value'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS "idx_recorder_exports_device" ON "recorder:exports" ("deviceId")',
      'CREATE INDEX IF NOT EXISTS "idx_recorder_exports_created" ON "recorder:exports" ("createdAt")',
    ],
    toRow: (key, rec) => {
      if (!Number.isInteger(rec.deviceId)) return null
      if (!Number.isFinite(rec.createdAt)) return null
      if (typeof rec.state !== 'string' || rec.state.length === 0) return null
      return {
        id: key,
        deviceId: rec.deviceId,
        createdAt: rec.createdAt,
        state: rec.state,
        value: JSON.stringify(rec),
      }
    },
  },
  {
    addon: 'recorder',
    blobKey: 'recordingConfigs',
    shape: 'map',
    table: 'recorder:recording-configs',
    columns: [
      '"id" TEXT PRIMARY KEY NOT NULL',
      '"deviceId" INTEGER NOT NULL',
      '"enabled" INTEGER NOT NULL',
      '"mode" TEXT',
      '"value" TEXT NOT NULL',
    ],
    names: ['id', 'deviceId', 'enabled', 'mode', 'value'],
    indexes: [],
    toRow: (key, config) => {
      const deviceId = Number(key)
      if (!Number.isInteger(deviceId)) return null
      return {
        id: key,
        deviceId,
        enabled: config.enabled === true ? 1 : 0,
        mode: typeof config.mode === 'string' ? config.mode : null,
        value: JSON.stringify(config),
      }
    },
  },
  {
    addon: 'stream-broker',
    blobKey: 'probeSnapshots',
    shape: 'map',
    table: 'stream-broker:probe-snapshots',
    columns: [
      '"id" TEXT PRIMARY KEY NOT NULL',
      '"deviceId" INTEGER',
      '"at" INTEGER NOT NULL',
      '"value" TEXT NOT NULL',
    ],
    names: ['id', 'deviceId', 'at', 'value'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS "idx_stream_broker_probe_device" ON "stream-broker:probe-snapshots" ("deviceId")',
    ],
    toRow: (key, snapshot) => {
      if (!Number.isFinite(snapshot.at)) return null
      return {
        id: key,
        deviceId: brokerDeviceId(key),
        at: snapshot.at,
        value: JSON.stringify(snapshot),
      }
    },
  },
  {
    addon: 'stream-broker',
    blobKey: 'rtspTokens',
    shape: 'map',
    table: 'stream-broker:rtsp-tokens',
    columns: ['"id" TEXT PRIMARY KEY NOT NULL', '"deviceId" INTEGER', '"value" TEXT NOT NULL'],
    names: ['id', 'deviceId', 'value'],
    indexes: [
      'CREATE INDEX IF NOT EXISTS "idx_stream_broker_rtsp_tokens_device" ON "stream-broker:rtsp-tokens" ("deviceId")',
    ],
    /** The blob value is a BARE token string; the row wraps it as `{ token }`. */
    toRow: (key, token) => {
      if (typeof token !== 'string' || token.length === 0) return null
      return { id: key, deviceId: brokerDeviceId(key), value: JSON.stringify({ token }) }
    },
  },
  {
    addon: 'stream-broker',
    blobKey: 'profileMap',
    shape: 'map',
    table: 'stream-broker:profile-map',
    columns: [
      '"id" TEXT PRIMARY KEY NOT NULL',
      '"deviceId" INTEGER NOT NULL',
      '"auto" INTEGER NOT NULL',
      '"value" TEXT NOT NULL',
    ],
    names: ['id', 'deviceId', 'auto', 'value'],
    indexes: [],
    toRow: (key, assignment) => {
      const deviceId = Number(key)
      if (!Number.isInteger(deviceId)) return null
      if (assignment.map === null || typeof assignment.map !== 'object') return null
      const auto = assignment.auto === true
      return {
        id: key,
        deviceId,
        auto: auto ? 1 : 0,
        value: JSON.stringify({ map: assignment.map, auto }),
      }
    },
  },
]

/** Keys that STAY in the root blob, reported so the operator can see them survive. */
const KEPT_KEYS = {
  recorder: ['recordingPlacement'],
  'stream-broker': ['rtspEnabled', 'deviceOverrides'],
}

/**
 * The numeric camera out of a broker id (`<deviceId>/<camStreamId>`) or a bare
 * device key. `null` rather than a guess: a key whose head is not a number is
 * one this addon did not write, and inventing a device would put the row on a
 * camera at random.
 */
function brokerDeviceId(key) {
  const head = key.includes('/') ? key.slice(0, key.indexOf('/')) : key
  const id = Number(head)
  return Number.isInteger(id) && id > 0 ? id : null
}

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read a forked addon's `root` settings row.
 *
 * The scoped table stores the value as a single `data` JSON column holding the
 * object verbatim — no `{ addonId, key, value }` envelope (that is the UNSCOPED
 * `addon-settings` table a hub BUILTIN writes). A row that is missing or
 * unparseable reads as ABSENT and the caller decides whether that is fatal.
 */
function readRoot(db, addonId) {
  const table = `${addonId}:addon-settings`
  const exists = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(table)
  if (!exists) return null
  const row = db.prepare(`SELECT data FROM "${table}" WHERE id = 'root'`).get()
  if (!row || typeof row.data !== 'string') return null
  try {
    const parsed = JSON.parse(row.data)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Every (key, value) pair a plan's blob contributes, whatever its shape. */
function entriesOf(plan, blob) {
  if (plan.shape === 'array') {
    if (!Array.isArray(blob)) return null
    const out = []
    for (const entry of blob) {
      if (!isPlainObject(entry)) {
        out.push([null, entry])
        continue
      }
      out.push([plan.keyOf(entry), entry])
    }
    return out
  }
  if (!isPlainObject(blob)) return null
  return Object.entries(blob)
}

function planRows(plan, blob) {
  const entries = entriesOf(plan, blob)
  if (entries === null)
    return { rows: [], skipped: [{ key: '(whole key)', why: 'not the expected shape' }], total: 0 }
  const rows = []
  const skipped = []
  for (const [key, value] of entries) {
    if (key === null) {
      skipped.push({ key: '(no id)', why: 'entry carries no usable row key' })
      continue
    }
    // `rtspTokens` values are bare strings; everything else is an object.
    if (plan.blobKey !== 'rtspTokens' && !isPlainObject(value)) {
      skipped.push({ key, why: 'value is not an object' })
      continue
    }
    const row = plan.toRow(key, value)
    if (row === null) {
      skipped.push({ key, why: 'missing a NOT NULL column value' })
      continue
    }
    rows.push(row)
  }
  return { rows, skipped, total: entries.length }
}

function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const dbPath = args.find((a) => !a.startsWith('--'))
  if (!dbPath) {
    fail('usage: migrate-recorder-broker-blobs.mjs <path-to-camstack.db> [--apply]')
  }
  const resolved = path.resolve(dbPath)
  if (!existsSync(resolved)) fail(`no such file: ${resolved}`)

  console.log(`\nrecorder + stream-broker blob flatten — ${apply ? 'APPLY' : 'DRY RUN'}`)
  console.log(`  database: ${resolved}`)
  if (!apply) {
    console.log('  (opened READ-ONLY; pass --apply to write, with the hub stopped)')
  }

  // A dry run opens with `SQLITE_OPEN_READONLY` — the same guarantee
  // `file:…?mode=ro` gives the sqlite3 CLI, which is what the 2026-08-19
  // incident post-mortem requires of any read against a database that might be
  // live.
  const db = apply
    ? new Database(resolved, { fileMustExist: true })
    : new Database(resolved, { readonly: true, fileMustExist: true })

  try {
    const roots = new Map()
    for (const addon of ['recorder', 'stream-broker']) {
      const root = readRoot(db, addon)
      if (root === null) {
        fail(
          `\`${addon}:addon-settings\` / root is missing or unreadable. Nothing to migrate — ` +
            'and an empty read is NOT evidence the addon has no settings, so this refuses ' +
            'rather than writing empty collections.',
        )
      }
      roots.set(addon, root)
    }

    console.log('\n  read from the blobs:')
    const planned = []
    for (const plan of PLANS) {
      const root = roots.get(plan.addon)
      if (!(plan.blobKey in root)) {
        console.log(`    ${plan.addon}/${plan.blobKey}  ABSENT — nothing to migrate`)
        planned.push({ plan, rows: [], skipped: [], total: 0 })
        continue
      }
      const result = planRows(plan, root[plan.blobKey])
      console.log(
        `    ${plan.addon}/${plan.blobKey}  ${result.total} entr(ies) → ` +
          `${result.rows.length} row(s) in "${plan.table}"`,
      )
      planned.push({ plan, ...result })
    }

    let anySkipped = false
    for (const { plan, skipped } of planned) {
      if (skipped.length === 0) continue
      anySkipped = true
      // Never silent: a skipped entry is data that disappears at the cutover,
      // which is indistinguishable from data that was deleted.
      console.log(`\n  ⚠ ${plan.addon}/${plan.blobKey}: ${skipped.length} entr(ies) SKIPPED:`)
      for (const s of skipped.slice(0, 20)) console.log(`      ${s.key}: ${s.why}`)
      if (skipped.length > 20) console.log(`      … and ${skipped.length - 20} more`)
    }
    if (!anySkipped) console.log('\n  no entries skipped')

    console.log('\n  keys that STAY in the root blob (untouched by this and by the purge):')
    for (const [addon, keys] of Object.entries(KEPT_KEYS)) {
      const root = roots.get(addon)
      const present = keys.filter((k) => k in root)
      const other = Object.keys(root).filter(
        (k) => !keys.includes(k) && !PLANS.some((p) => p.addon === addon && p.blobKey === k),
      )
      console.log(
        `    ${addon}: ${present.length > 0 ? present.join(', ') : '(none of the named ones)'}` +
          (other.length > 0 ? ` · plus ${other.length} config field(s): ${other.join(', ')}` : ''),
      )
    }

    if (!apply) {
      console.log('\n  DRY RUN — nothing written. Re-run with --apply, hub stopped.\n')
      return
    }

    console.log('\n  written:')
    const verifications = []
    for (const { plan, rows } of planned) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${plan.table}" (${plan.columns.join(', ')})`)
      for (const ddl of plan.indexes) db.exec(ddl)
      const before = db.prepare(`SELECT COUNT(*) AS n FROM "${plan.table}"`).get().n
      if (rows.length > 0) {
        const cols = plan.names.map((c) => `"${c}"`).join(', ')
        const placeholders = plan.names.map(() => '?').join(', ')
        const updates = plan.names
          .filter((c) => c !== 'id')
          .map((c) => `"${c}" = excluded."${c}"`)
          .join(', ')
        const insert = db.prepare(
          `INSERT INTO "${plan.table}" (${cols}) VALUES (${placeholders}) ` +
            `ON CONFLICT("id") DO UPDATE SET ${updates}`,
        )
        const writeAll = db.transaction((batch) => {
          for (const row of batch) insert.run(plan.names.map((c) => row[c]))
        })
        writeAll(rows)
      }
      const after = db.prepare(`SELECT COUNT(*) AS n FROM "${plan.table}"`).get().n
      console.log(
        `    ${plan.table}: ${before} → ${after} rows  (upserted ${rows.length}, new ${after - before})`,
      )
      verifications.push({ plan, rows, after })
    }

    // ── verification: read a sample back through SQL and compare ──────────
    const mismatches = []
    let verified = 0
    for (const { plan, rows } of verifications) {
      const sample = rows.length <= 5 ? rows : pickSample(rows, 5)
      const cols = plan.names.map((c) => `"${c}"`).join(', ')
      for (const expected of sample) {
        const actual = db
          .prepare(`SELECT ${cols} FROM "${plan.table}" WHERE "id" = ?`)
          .get(expected.id)
        if (!actual) {
          mismatches.push(`${plan.table}/${expected.id}: row absent after write`)
          continue
        }
        for (const c of plan.names) {
          if (actual[c] !== expected[c]) {
            mismatches.push(
              `${plan.table}/${expected.id}.${c}: wrote ${expected[c]} → read ${actual[c]}`,
            )
          }
        }
        verified += 1
      }
    }
    console.log(`\n  verified ${verified} sampled row(s) column-by-column`)
    if (mismatches.length > 0) {
      console.log('  ✗ MISMATCHES:')
      for (const m of mismatches) console.log(`      ${m}`)
      fail('verification failed — the blobs are untouched, investigate before cutting over')
    }

    console.log(
      '\n  ✓ done. The blob keys are UNTOUCHED — each addon drops its own at its next\n' +
        '    boot, and only once the matching collection is non-empty.\n',
    )
  } finally {
    db.close()
  }
}

/** Evenly-spaced sample, so the check is not all first-N. */
function pickSample(rows, count) {
  const step = Math.max(1, Math.floor(rows.length / count))
  const out = []
  for (let i = 0; i < rows.length && out.length < count; i += step) out.push(rows[i])
  return out
}

main()

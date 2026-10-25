#!/usr/bin/env node
/**
 * Flatten the device-manager's three fleet blobs into `device-manager:devices`.
 *
 * ## What it moves
 *
 * The device-manager is a HUB BUILTIN, so its `ctx.settings` is
 * `ConfigManager.createSettingsView` — `getAllAddon` / `setAllAddon`, one row
 * per key in the UNSCOPED `addon-settings` table, keyed `<addonId>.<key>` with
 * the value wrapped as `{ addonId, key, value }`. (It has never written the
 * scoped `device-manager:addon-settings` table; that one is empty.) Three of
 * those rows held the whole fleet:
 *
 *   - `device-manager.deviceMeta`      `{ [String(id)]: PersistedDeviceMeta }`
 *   - `device-manager.deviceMetadata`  `{ [String(id)]: Record<string, unknown> }`
 *   - `device-manager.deviceIndex`     `{ [addonId]: stableId[] }`
 *
 * They become one row per device in `device-manager:devices`. `deviceIndex` is
 * NOT migrated as data: `addonId` and `stableId` are columns of every row, so
 * an addon's device list is a query. It carries exactly one bit that is not
 * derivable — membership means "`registerDevice` has run at least once", which
 * is how `registerDevice` tells a first registration from a meta refresh — and
 * that bit becomes the `registered` column.
 *
 * ## What it does NOT do
 *
 * It does not delete the blobs. They are the only copy until this has run, and
 * a migration that deletes its own source leaves nothing to re-run against.
 * The hub purges them at its next boot, and only once `device-manager:devices`
 * is non-empty (`RETIRED_SETTINGS_ROWS` in
 * `packages/system/src/builtins/sqlite-storage/retired-settings-keys.ts`).
 *
 * ## Running it
 *
 *   node scripts/migrate-device-manager-blobs.mjs <path-to-camstack.db>
 *   node scripts/migrate-device-manager-blobs.mjs <path-to-camstack.db> --apply
 *
 * Without `--apply` it opens the file READ-ONLY, reports exactly what it would
 * write, and touches nothing.
 *
 * **The hub must be stopped.** Opening a live SQLite file read-write from a
 * second process — especially across a FUSE path such as Unraid's `/mnt/user`,
 * where the kernel and the FUSE layer do not share a page cache — is how this
 * database was corrupted on 2026-08-19. Stop the container, migrate the file at
 * its real location, start it again.
 *
 * Idempotent: re-running upserts the same rows and reports 0 new.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Database from 'better-sqlite3'

const BLOB_COLLECTION = 'addon-settings'
const ROW_META = 'device-manager.deviceMeta'
const ROW_METADATA = 'device-manager.deviceMetadata'
const ROW_INDEX = 'device-manager.deviceIndex'
const DEVICES_TABLE = 'device-manager:devices'

/**
 * Byte-identical to `DEVICE_ROWS_COLUMNS` in
 * `packages/system/src/builtins/device-manager/device-row-store.ts`, rendered
 * the way `SqliteSettingsBackend.ensureTable` renders it (`JSON` → `TEXT`,
 * `BOOLEAN` → `INTEGER`).
 *
 * The names are what matter: on the next boot `declareCollection` compares the
 * DECLARED column names against `PRAGMA table_info`, and a declared column the
 * table lacks that SQLite cannot add in place makes the engine DROP and
 * recreate the table — taking every row this script just wrote. Keep this list
 * and that one in lockstep.
 */
const DEVICE_COLUMNS_DDL = [
  '"id" TEXT PRIMARY KEY NOT NULL',
  '"deviceId" INTEGER NOT NULL',
  '"addonId" TEXT NOT NULL',
  '"stableId" TEXT NOT NULL',
  '"type" TEXT NOT NULL',
  '"name" TEXT NOT NULL',
  '"userNamed" INTEGER',
  '"location" TEXT',
  '"disabled" INTEGER NOT NULL DEFAULT 0',
  '"parentDeviceId" INTEGER',
  '"registered" INTEGER NOT NULL DEFAULT 0',
  '"features" TEXT',
  '"exportFingerprint" TEXT',
  '"integrationId" TEXT',
  '"linkDeviceId" INTEGER',
  '"primaryChildEntityId" TEXT',
  '"childLayout" TEXT',
  '"role" TEXT',
  '"display" TEXT',
  '"metadata" TEXT',
]

const DEVICE_INDEXES_DDL = [
  `CREATE INDEX IF NOT EXISTS "idx_dm_devices_addon_stable" ON "${DEVICES_TABLE}" ("addonId", "stableId")`,
  `CREATE INDEX IF NOT EXISTS "idx_dm_devices_parent" ON "${DEVICES_TABLE}" ("parentDeviceId")`,
  `CREATE INDEX IF NOT EXISTS "idx_dm_devices_integration" ON "${DEVICES_TABLE}" ("integrationId")`,
]

/** Column order used by both the INSERT and the read-back verification. */
const COLUMN_NAMES = [
  'id',
  'deviceId',
  'addonId',
  'stableId',
  'type',
  'name',
  'userNamed',
  'location',
  'disabled',
  'parentDeviceId',
  'registered',
  'features',
  'exportFingerprint',
  'integrationId',
  'linkDeviceId',
  'primaryChildEntityId',
  'childLayout',
  'role',
  'display',
  'metadata',
]

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read one `addon-settings` row and unwrap the `{ addonId, key, value }`
 * envelope `setAllAddon` writes.
 *
 * A row that is missing, unparseable, or wrapped without a `value` reads as
 * ABSENT — the same thing `getAllAddon` does with it — and the caller decides
 * whether absence is fatal. Guessing at a corrupt envelope would put invented
 * devices in the ledger.
 */
function readBlob(db, rowId) {
  const row = db.prepare(`SELECT data FROM "${BLOB_COLLECTION}" WHERE id = ?`).get(rowId)
  if (!row || typeof row.data !== 'string') return null
  let parsed
  try {
    parsed = JSON.parse(row.data)
  } catch {
    return null
  }
  if (isPlainObject(parsed) && 'addonId' in parsed && 'key' in parsed) {
    return 'value' in parsed && isPlainObject(parsed.value) ? parsed.value : null
  }
  return isPlainObject(parsed) ? parsed : null
}

/** `true|false` → `1|0`; absent stays absent (SQL NULL). */
function boolCol(value) {
  if (value === true) return 1
  if (value === false) return 0
  return null
}

function jsonCol(value) {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/**
 * One `PersistedDeviceMeta` → one column tuple.
 *
 * Returns `null` for a record missing an identity field the collection
 * declares `NOT NULL` (`id` / `addonId` / `stableId` / `type` / `name`). Such a
 * record cannot be written and cannot be projected into a `DeviceInfo` either —
 * the caller reports it rather than inventing a value.
 */
function toRow(key, meta, registered, metadata) {
  const id = typeof meta.id === 'number' ? meta.id : Number(key)
  if (!Number.isInteger(id)) return null
  if (typeof meta.addonId !== 'string' || meta.addonId.length === 0) return null
  if (typeof meta.stableId !== 'string' || meta.stableId.length === 0) return null
  if (typeof meta.type !== 'string') return null
  if (typeof meta.name !== 'string') return null
  return {
    id: String(id),
    deviceId: id,
    addonId: meta.addonId,
    stableId: meta.stableId,
    type: meta.type,
    name: meta.name,
    userNamed: boolCol(meta.userNamed),
    location: typeof meta.location === 'string' ? meta.location : null,
    disabled: meta.disabled === true ? 1 : 0,
    parentDeviceId: typeof meta.parentDeviceId === 'number' ? meta.parentDeviceId : null,
    registered: registered ? 1 : 0,
    features: Array.isArray(meta.features) ? JSON.stringify(meta.features) : null,
    exportFingerprint: typeof meta.exportFingerprint === 'string' ? meta.exportFingerprint : null,
    integrationId: typeof meta.integrationId === 'string' ? meta.integrationId : null,
    linkDeviceId: typeof meta.linkDeviceId === 'number' ? meta.linkDeviceId : null,
    primaryChildEntityId:
      typeof meta.primaryChildEntityId === 'string' ? meta.primaryChildEntityId : null,
    childLayout: Array.isArray(meta.childLayout) ? JSON.stringify(meta.childLayout) : null,
    role: typeof meta.role === 'string' ? meta.role : null,
    display: isPlainObject(meta.display) ? jsonCol(meta.display) : null,
    metadata:
      isPlainObject(metadata) && Object.keys(metadata).length > 0 ? jsonCol(metadata) : null,
  }
}

function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const dbPath = args.find((a) => !a.startsWith('--'))
  if (!dbPath) {
    fail('usage: migrate-device-manager-blobs.mjs <path-to-camstack.db> [--apply]')
  }
  const resolved = path.resolve(dbPath)
  if (!existsSync(resolved)) fail(`no such file: ${resolved}`)

  console.log(`\ndevice-manager blob flatten — ${apply ? 'APPLY' : 'DRY RUN'}`)
  console.log(`  database: ${resolved}`)
  if (!apply) {
    console.log('  (opened READ-ONLY; pass --apply to write, with the hub stopped)')
  }

  // A dry run opens with `SQLITE_OPEN_READONLY` — the same guarantee
  // `file:…?mode=ro` gives the sqlite3 CLI, which is what the incident
  // post-mortem requires of any read against a database that might be live.
  const db = apply
    ? new Database(resolved, { fileMustExist: true })
    : new Database(resolved, { readonly: true, fileMustExist: true })

  try {
    const meta = readBlob(db, ROW_META)
    if (meta === null) {
      fail(
        `\`${ROW_META}\` is missing or unreadable in "${BLOB_COLLECTION}". ` +
          'Nothing to migrate — and an empty read is NOT evidence the fleet is empty, ' +
          'so this refuses rather than writing a zero-device ledger.',
      )
    }
    const metadataMap = readBlob(db, ROW_METADATA) ?? {}
    const indexMap = readBlob(db, ROW_INDEX) ?? {}

    // `registered` = former `deviceIndex` membership, per `(addonId, stableId)`.
    const registeredPairs = new Set()
    for (const [addonId, stableIds] of Object.entries(indexMap)) {
      if (!Array.isArray(stableIds)) continue
      for (const stableId of stableIds) {
        if (typeof stableId === 'string') registeredPairs.add(`${addonId} ${stableId}`)
      }
    }

    const metaEntries = Object.entries(meta)
    const metadataCount = Object.keys(metadataMap).length
    console.log('\n  read from the blobs:')
    console.log(`    deviceMeta      ${metaEntries.length} devices`)
    console.log(`    deviceMetadata  ${metadataCount} devices`)
    console.log(
      `    deviceIndex     ${Object.keys(indexMap).length} addons, ${registeredPairs.size} stableIds`,
    )

    const rows = []
    const skipped = []
    let unregistered = 0
    let metadataAttached = 0
    for (const [key, record] of metaEntries) {
      if (!isPlainObject(record)) {
        skipped.push({ key, why: 'not an object' })
        continue
      }
      const registered = registeredPairs.has(`${record.addonId} ${record.stableId}`)
      const metadata = metadataMap[key]
      const row = toRow(key, record, registered, metadata)
      if (row === null) {
        skipped.push({
          key,
          why: 'missing a NOT NULL identity field (id/addonId/stableId/type/name)',
        })
        continue
      }
      if (!registered) unregistered += 1
      if (row.metadata !== null) metadataAttached += 1
      rows.push(row)
    }

    console.log('\n  planned rows:')
    console.log(`    devices          ${rows.length} (expected ${metaEntries.length})`)
    console.log(`    with metadata    ${metadataAttached} (expected ${metadataCount})`)
    console.log(`    registered=0     ${unregistered}`)
    if (skipped.length > 0) {
      // Never silent: a skipped device is a device that disappears from the
      // fleet, which is indistinguishable from one that was removed.
      console.log(
        `\n  ⚠ ${skipped.length} record(s) SKIPPED — they will not exist after the cutover:`,
      )
      for (const s of skipped.slice(0, 20)) console.log(`      ${s.key}: ${s.why}`)
      if (skipped.length > 20) console.log(`      … and ${skipped.length - 20} more`)
    }
    const orphanMetadata = Object.keys(metadataMap).filter((k) => !(k in meta))
    if (orphanMetadata.length > 0) {
      console.log(
        `\n  ⚠ ${orphanMetadata.length} metadata entr(ies) belong to devices with no meta row — dropped: ` +
          orphanMetadata.slice(0, 20).join(', '),
      )
    }

    if (!apply) {
      console.log('\n  DRY RUN — nothing written. Re-run with --apply, hub stopped.\n')
      return
    }

    db.exec(`CREATE TABLE IF NOT EXISTS "${DEVICES_TABLE}" (${DEVICE_COLUMNS_DDL.join(', ')})`)
    for (const ddl of DEVICE_INDEXES_DDL) db.exec(ddl)

    const before = db.prepare(`SELECT COUNT(*) AS n FROM "${DEVICES_TABLE}"`).get().n
    const cols = COLUMN_NAMES.map((c) => `"${c}"`).join(', ')
    const placeholders = COLUMN_NAMES.map(() => '?').join(', ')
    const updates = COLUMN_NAMES.filter((c) => c !== 'id')
      .map((c) => `"${c}" = excluded."${c}"`)
      .join(', ')
    const insert = db.prepare(
      `INSERT INTO "${DEVICES_TABLE}" (${cols}) VALUES (${placeholders}) ` +
        `ON CONFLICT("id") DO UPDATE SET ${updates}`,
    )
    const writeAll = db.transaction((batch) => {
      for (const row of batch) insert.run(COLUMN_NAMES.map((c) => row[c]))
    })
    writeAll(rows)
    const after = db.prepare(`SELECT COUNT(*) AS n FROM "${DEVICES_TABLE}"`).get().n

    console.log('\n  written:')
    console.log(`    rows in ${DEVICES_TABLE}: ${before} → ${after}`)
    console.log(`    upserted: ${rows.length}, new: ${after - before}`)

    if (after !== rows.length) {
      console.log(
        `\n  ⚠ the table holds ${after} rows but this pass planned ${rows.length}. ` +
          'Extra rows are devices a previous run wrote that the blobs no longer describe.',
      )
    }

    // ── verification: read a sample back through SQL and compare ──────────
    const sample = rows.length <= 10 ? rows : pickSample(rows, 10)
    const mismatches = []
    for (const expected of sample) {
      const actual = db
        .prepare(`SELECT ${cols} FROM "${DEVICES_TABLE}" WHERE "id" = ?`)
        .get(expected.id)
      if (!actual) {
        mismatches.push(`${expected.id}: row absent after write`)
        continue
      }
      for (const c of COLUMN_NAMES) {
        if (actual[c] !== expected[c]) {
          mismatches.push(`${expected.id}.${c}: wrote ${expected[c]} → read ${actual[c]}`)
        }
      }
    }
    console.log(`\n  verified ${sample.length} sampled device(s) column-by-column`)
    if (mismatches.length > 0) {
      console.log('  ✗ MISMATCHES:')
      for (const m of mismatches) console.log(`      ${m}`)
      fail('verification failed — the blobs are untouched, investigate before cutting over')
    }
    for (const row of sample) {
      console.log(`      ${row.deviceId}  ${row.addonId}/${row.stableId}  "${row.name}"`)
    }

    console.log(
      '\n  ✓ done. The blobs are UNTOUCHED — the hub purges them at its next boot,\n' +
        `    and only once "${DEVICES_TABLE}" is non-empty.\n`,
    )
  } finally {
    db.close()
  }
}

/** Evenly-spaced sample, so the check is not all first-N (all one addon). */
function pickSample(rows, count) {
  const step = Math.floor(rows.length / count)
  const out = []
  for (let i = 0; i < rows.length && out.length < count; i += step) out.push(rows[i])
  return out
}

main()

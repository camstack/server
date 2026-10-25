import { describe, expect, it } from 'vitest'
import { summariseTableSizes } from '../table-sizes.js'

/**
 * Nothing in this system could answer "which collection is the database".
 *
 * Measured 2026-08-25: the file is 858 MB and `freePct=2` — it is not a
 * high-water mark waiting for a VACUUM, it is 840 MB of live rows. `dbSizeMb`
 * says how big, `freePct` says how much is real, and neither says WHOSE. The
 * collections are not even enumerable from source: `<addonId>:<canonical>`
 * tables are created on first write and declared nowhere (see the storage map),
 * so the list only exists on the running node.
 */
describe('summariseTableSizes', () => {
  it('ranks tables by bytes and gives each a share of the file', () => {
    const report = summariseTableSizes(
      [
        {
          name: 'pipeline-analytics:media',
          tableName: 'pipeline-analytics:media',
          bytes: 600_000_000,
          pages: 146_484,
          kind: 'table',
        },
        {
          name: 'device-manager:devices',
          tableName: 'device-manager:devices',
          bytes: 200_000_000,
          pages: 48_828,
          kind: 'table',
        },
        {
          name: 'addon-device-settings',
          tableName: 'addon-device-settings',
          bytes: 81_100_000,
          pages: 19_800,
          kind: 'index',
        },
      ],
      881_100_000,
      2,
    )

    expect(report.tables).toEqual([
      { name: 'pipeline-analytics:media', sizeMb: 572, pages: 146_484, pct: 68, kind: 'table' },
      { name: 'device-manager:devices', sizeMb: 191, pages: 48_828, pct: 23, kind: 'table' },
    ])
    // The tail is not silently dropped: a report that hides 9% reads as "these
    // three are the database" when they are not.
    expect(report.otherMb).toBe(77)
    expect(report.otherObjects).toBe(1)
  })

  it('is empty, not a crash, when dbstat returned nothing', () => {
    expect(summariseTableSizes([], 0, 10)).toEqual({
      tables: [],
      otherMb: 0,
      otherObjects: 0,
      tableCount: 0,
      indexCount: 0,
      byOwner: [],
    })
  })

  it('never divides by zero when the file size is unknown', () => {
    const report = summariseTableSizes(
      [{ name: 't', tableName: 't', bytes: 1_048_576, pages: 256, kind: 'table' }],
      0,
      10,
    )
    expect(report.tables[0]).toEqual({ name: 't', sizeMb: 1, pages: 256, pct: 0, kind: 'table' })
  })
})

/**
 * "388 tables" was the wrong label and it produced the wrong question.
 *
 * `dbstat` groups by OBJECT, and an index is an object: four of the first ten
 * entries on the live hub were indexes (`sqlite_autoindex_*`, `idx_media_owner`,
 * `idx_motion_device_ts`). Counting them as tables makes a cluster with ~40
 * addons look like it invented hundreds of collections. So the report says how
 * many of each, and attributes the tail to the addon whose prefix owns it —
 * `<addonId>:<canonical>` collections are created on first write and declared
 * in no source file, so the prefix is the only ownership signal that exists.
 */
describe('the report separates tables from indexes and attributes the tail', () => {
  // `tableName` is `sqlite_master.tbl_name`: for a table it is the table, for an
  // index it is the table the index belongs to. An index name carries no
  // reliable ownership — `idx_b_outbox` only LOOKS parseable — so the rollup
  // reads the relation SQLite already stores instead of guessing from a string.
  const rows = [
    { name: 'a:media', tableName: 'a:media', bytes: 40_000_000, pages: 10, kind: 'table' as const },
    {
      name: 'sqlite_autoindex_a:media_1',
      tableName: 'a:media',
      bytes: 20_000_000,
      pages: 5,
      kind: 'index' as const,
    },
    {
      name: 'a:tracks',
      tableName: 'a:tracks',
      bytes: 10_000_000,
      pages: 3,
      kind: 'table' as const,
    },
    { name: 'b:outbox', tableName: 'b:outbox', bytes: 8_000_000, pages: 2, kind: 'table' as const },
    {
      name: 'idx_b_outbox',
      tableName: 'b:outbox',
      bytes: 4_000_000,
      pages: 1,
      kind: 'index' as const,
    },
    { name: 'sections', tableName: 'sections', bytes: 1_000_000, pages: 1, kind: 'table' as const },
  ]

  it('counts each kind instead of calling them all tables', () => {
    const report = summariseTableSizes(rows, 83_000_000, 2)
    expect(report.tableCount).toBe(4)
    expect(report.indexCount).toBe(2)
    expect(report.otherObjects).toBe(4)
  })

  it('rolls every object up to the addon prefix that owns it', () => {
    const report = summariseTableSizes(rows, 83_000_000, 2)
    expect(report.byOwner).toEqual([
      { owner: 'a', sizeMb: 67, objects: 3 },
      { owner: 'b', sizeMb: 11, objects: 2 },
      { owner: '(unscoped)', sizeMb: 1, objects: 1 },
    ])
  })
})

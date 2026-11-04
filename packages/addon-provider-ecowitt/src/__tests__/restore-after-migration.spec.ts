/**
 * Boot wiring of the Hub migration: the catalogue runs from `onRestoreDevices` before anything
 * else is restored, a Hub row is never restored, a row the migration restored is not restored
 * twice, a migration that did not run is named once, and a Gateway that is persisted but not
 * restored yet is found by stableId on a resume.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  type AddonMigrationRunReport,
  DeviceType,
  type IScopedLogger,
  type SavedDevice,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { findExistingGateway } from '../ecowitt-integration-devices.js'
import { restoreAfterMigration } from '../migrations/restore-after-migration.js'

const warns: Array<{ message: string; deviceId: unknown }> = []
const logger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message: string, ctx?: { tags?: Record<string, unknown> }) =>
    void warns.push({ message, deviceId: ctx?.tags?.['deviceId'] }),
  error: () => undefined,
  child: () => logger,
  withTags: () => logger,
}

const ID = 'provider-ecowitt/m'

function saved(id: number, type: DeviceType, parent: number | null): SavedDevice {
  return {
    id,
    stableId: `s${id}`,
    type,
    name: `d${id}`,
    location: null,
    disabled: false,
    parentDeviceId: parent,
    config: {},
  }
}

const REPORT = (applied: boolean): AddonMigrationRunReport => ({
  declared: true,
  snapshot: 'none',
  applied: applied ? [ID] : [],
  failed: [],
  blocked: [],
  skipped: [],
  blockOwner: [],
})

const UNDER_HUB = saved(11, DeviceType.Container, 10)
const ROWS = [
  saved(10, DeviceType.Hub, null),
  UNDER_HUB,
  saved(12, DeviceType.Container, null),
  saved(13, DeviceType.Gateway, null),
]

describe('restoreAfterMigration', () => {
  it('runs the migration first, never restores a Hub row, never restores a row twice', async () => {
    const order: string[] = []
    const restoredRows: number[][] = []
    await restoreAfterMigration({
      saved: ROWS,
      migrationId: ID,
      logger,
      runMigration: async (restoreRows) => {
        order.push('migration')
        await restoreRows([UNDER_HUB])
        return REPORT(true)
      },
      restoreRows: async (rows) => {
        order.push('migration-restore')
        restoredRows.push(rows.map((r) => r.id))
      },
      restoreRest: async (rows) => {
        order.push('rest')
        restoredRows.push(rows.map((r) => r.id))
      },
    })
    expect(order).toEqual(['migration', 'migration-restore', 'rest'])
    expect(restoredRows).toEqual([[11], [12, 13]])
  })

  it('an engine that did not apply the migration: one warn per Hub row, then the throw', async () => {
    warns.length = 0
    await expect(
      restoreAfterMigration({
        saved: ROWS,
        migrationId: ID,
        logger,
        runMigration: async () => {
          throw new Error('migration(s) x did not apply and block this addon')
        },
        restoreRows: async () => undefined,
        restoreRest: async () => undefined,
      }),
    ).rejects.toThrow(/block this addon/)
    expect(warns.map((w) => w.message).join('\n')).toContain(ID)

    warns.length = 0
    await restoreAfterMigration({
      saved: ROWS,
      migrationId: ID,
      logger,
      runMigration: async () => REPORT(false),
      restoreRows: async () => undefined,
      restoreRest: async () => undefined,
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]?.deviceId).toBe(10)
  })

  it('addon.ts routes onRestoreDevices through it, with the catalogue bound to ports', () => {
    const src = readFileSync(fileURLToPath(new URL('../addon.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/onRestoreDevices[\s\S]{0,400}restoreAfterMigration\(/)
    expect(src).toMatch(
      /this\.runMigrations\(this\.migrationCatalogue\(ports\), \{\s*only: \[ECOWITT_HUB_MIGRATION_ID\]/,
    )
    expect(src).toMatch(/defineAddonMigrations\(ADDON_MIGRATIONS, hubPorts\)/)
  })
})

describe('findExistingGateway', () => {
  const stableId = 'ecowitt:x:device'
  it('finds a Gateway persisted but not restored, by stableId (live list is empty)', async () => {
    const found = await findExistingGateway({
      stableId,
      live: async () => [],
      saved: [
        { id: 7, stableId: 'other' },
        { id: 8, stableId },
      ],
    })
    expect(found).toBe(8)
  })
  it('prefers a live device and answers null when none holds the stableId', async () => {
    expect(
      await findExistingGateway({ stableId, live: async () => [{ id: 3, stableId }], saved: [] }),
    ).toBe(3)
    expect(await findExistingGateway({ stableId, live: async () => [], saved: [] })).toBeNull()
  })
})

/**
 * D902 — the backup orchestrator's schedules, destination policies and seed
 * markers live ONLY in its records kinds. The `backup_schedules`,
 * `backup_destination_policies` and `backup_seed_markers` tables and the
 * settings-store path that created them are gone: an orchestrator without
 * `ctx.records` keeps nothing (and says so), it never grows a table.
 *
 * Through the real addon, the real records engine and a real settings
 * backend; the only fake is the storage cap, which lists no location.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AddonContext,
  createRecordsAccess,
  type IScopedLogger,
  type RecordsAccess,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { BackupOrchestratorAddon } from '../backup-orchestrator.addon.js'
import { backupOrchestratorRecordKinds, backupRecordStoresOf } from '../record-kinds.js'

const LEGACY_TABLES = ['backup_schedules', 'backup_destination_policies', 'backup_seed_markers']

interface ScheduleProvider {
  readonly listSchedules: () => Promise<readonly { readonly id: string }[]>
  readonly upsertSchedule: (input: {
    label: string
    cron: string
    enabled: boolean
    locationIds: readonly string[]
    retentionCount: number
  }) => Promise<{ readonly id: string }>
}

function makeLogger(): IScopedLogger {
  const noop = vi.fn()
  const logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: a no-op logger stand-in in a spec
  return logger as unknown as IScopedLogger
}

function makeCtx(
  dataDir: string,
  settings: SqliteSettingsBackend,
  records: RecordsAccess | undefined,
): AddonContext {
  const ctx = {
    id: 'backup-orchestrator',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir,
    nodeDataDir: dataDir,
    records,
    kernel: {
      localNodeId: 'hub',
      capabilityRegistry: {
        getSingleton: (name: string) => (name === 'settings-store' ? settings : null),
      },
    },
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
    },
    api: { storage: { listLocations: { query: vi.fn(async () => []) } } },
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the addon reads only the members above
  return ctx as unknown as AddonContext
}

async function boot(ctx: AddonContext): Promise<{
  addon: BackupOrchestratorAddon
  provider: ScheduleProvider
}> {
  const addon = new BackupOrchestratorAddon()
  const result = await addon.initialize(ctx)
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the registration's provider is the backup surface
  const registrations = (
    Array.isArray(result) ? result : (result?.providers ?? [])
  ) as ReadonlyArray<{
    readonly provider: ScheduleProvider
  }>
  const first = registrations[0]
  if (!first) throw new Error('backup-orchestrator registered no provider')
  return { addon, provider: first.provider }
}

const NIGHTLY = {
  label: 'nightly',
  cron: '0 3 * * *',
  enabled: true,
  locationIds: ['backups:default'],
  retentionCount: 7,
}

describe('backup configuration lives only in records (D902)', () => {
  let dataDir = ''
  let settings: SqliteSettingsBackend

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-backup-records-'))
    settings = new SqliteSettingsBackend(':memory:')
    await settings.initialize()
  })

  afterEach(async () => {
    await settings.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('creates no backup_* table on the settings file, with or without records', async () => {
    const bare = await boot(makeCtx(dataDir, settings, undefined))
    await bare.provider.upsertSchedule(NIGHTLY).catch(() => null)
    await bare.addon.shutdown()

    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'backup-orchestrator',
      transport: world.transportFor('backup-orchestrator'),
      secrets: null,
    })
    const withRecords = await boot(makeCtx(dataDir, settings, records))
    await withRecords.provider.upsertSchedule(NIGHTLY)
    await withRecords.addon.shutdown()

    expect(LEGACY_TABLES.filter((t) => settings.hasTable(t))).toEqual([])
  })

  it('a schedule written through the addon is a records row and survives a restart', async () => {
    const world = makeRecordsWorld()
    await world.provider.init()
    const records = createRecordsAccess({
      owner: 'backup-orchestrator',
      transport: world.transportFor('backup-orchestrator'),
      secrets: null,
    })
    const first = await boot(makeCtx(dataDir, settings, records))
    const saved = await first.provider.upsertSchedule(NIGHTLY)
    await first.addon.shutdown()

    await records.declare(backupOrchestratorRecordKinds)
    const row = await backupRecordStoresOf(records).schedules.get(saved.id)
    expect(row?.data.cron).toBe('0 3 * * *')

    const second = await boot(makeCtx(dataDir, settings, records))
    expect((await second.provider.listSchedules()).map((s) => s.id)).toContain(saved.id)
    await second.addon.shutdown()
  })
})

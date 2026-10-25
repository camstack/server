/**
 * D852 — the WIRING of "nothing to carry", not only its pure function.
 *
 * A due weekly schedule (events + history) on a hub where the database owner
 * has neither file must be skipped by the real addon's schedule tick: no
 * snapshot asked, no upload begun, no run recorded, no outcome stamped. When
 * the owner DOES have one of them, the same tick goes ahead and asks for its
 * snapshot — which proves the skip above is the guard and not an idle timer.
 *
 * The addon is the real one on a real in-memory settings engine; the owner
 * and the storage cap are the only fakes, and neither decides anything.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonContext, DataStoreDatabase, IScopedLogger, RecordsAccess } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { BackupOrchestratorAddon } from '../backup-orchestrator.addon.js'
import { makeBackupRecords } from './support/backup-records.js'

interface ScheduleWire {
  readonly id: string
  readonly lastAttemptAt?: number
  readonly lastSuccessAt?: number
  readonly lastError?: string
}

interface BackupProvider {
  readonly listRuns: () => Promise<readonly unknown[]>
  readonly listSchedules: () => Promise<readonly ScheduleWire[]>
  readonly upsertSchedule: (input: {
    label: string
    cron: string
    enabled: boolean
    locationIds: readonly string[]
    retentionCount: number
    databases?: readonly DataStoreDatabase[]
  }) => Promise<ScheduleWire>
}

function makeLogger(info: ReturnType<typeof vi.fn>): IScopedLogger {
  const noop = vi.fn()
  const logger = { debug: noop, info, warn: noop, error: noop, child: () => logger }
  return logger as unknown as IScopedLogger
}

interface Probes {
  readonly ctx: AddonContext
  readonly writeSnapshot: ReturnType<typeof vi.fn>
  readonly beginUpload: ReturnType<typeof vi.fn>
  readonly info: ReturnType<typeof vi.fn>
}

function makeCtx(
  dataDir: string,
  settings: SqliteSettingsBackend,
  owned: readonly DataStoreDatabase[],
  records: RecordsAccess,
): Probes {
  const writeSnapshot = vi.fn(async () => {
    throw new Error('snapshot refused (spec)')
  })
  const beginUpload = vi.fn(async () => ({ uploadId: 'up-1' }))
  const info = vi.fn()
  const ctx = {
    id: 'backup-orchestrator',
    logger: makeLogger(info),
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
    api: {
      databaseSnapshot: {
        listDatabases: {
          query: vi.fn(async () => ({
            databases: owned.map((databaseId) => ({
              databaseId,
              livePath: path.join(dataDir, `${databaseId}.db`),
            })),
          })),
        },
        writeSnapshot: { mutate: writeSnapshot },
      },
      storage: {
        listLocations: {
          query: vi.fn(async () => [
            {
              id: 'backups:default',
              type: 'backups',
              displayName: 'default',
              providerId: 'filesystem-storage',
              config: {},
              enabled: true,
              isSystem: false,
              createdAt: 1,
              updatedAt: 1,
            },
          ]),
        },
        beginUpload: { mutate: beginUpload },
        writeChunk: { mutate: vi.fn(async () => undefined) },
        finalizeUpload: { mutate: vi.fn(async () => undefined) },
        abortUpload: { mutate: vi.fn(async () => undefined) },
        delete: { mutate: vi.fn(async () => undefined) },
        exists: { query: vi.fn(async () => false) },
        read: { query: vi.fn(async () => ({ dataBase64: '' })) },
        write: { mutate: vi.fn(async () => undefined) },
      },
    },
  } as unknown as AddonContext
  return { ctx, writeSnapshot, beginUpload, info }
}

describe('a due weekly schedule with nothing to carry (D852 wiring)', () => {
  let dataDir = ''
  let addon: BackupOrchestratorAddon | null = null

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-weekly-skip-'))
  })

  afterEach(async () => {
    await addon?.shutdown()
    addon = null
    vi.useRealTimers()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  async function boot(owned: readonly DataStoreDatabase[]): Promise<Probes & BackupProvider> {
    const settings = new SqliteSettingsBackend(':memory:')
    await settings.initialize()
    const probes = makeCtx(dataDir, settings, owned, (await makeBackupRecords()).records)
    addon = new BackupOrchestratorAddon()
    const result = await addon.initialize(probes.ctx)
    const registrations = (
      Array.isArray(result) ? result : (result?.providers ?? [])
    ) as ReadonlyArray<{ readonly provider: BackupProvider }>
    const first = registrations[0]
    if (!first) throw new Error('backup-orchestrator registered no provider')
    await first.provider.upsertSchedule({
      label: 'weekly',
      cron: '* * * * *',
      enabled: true,
      locationIds: ['backups:default'],
      retentionCount: 4,
      databases: ['events', 'history'],
    })
    return { ...probes, ...first.provider }
  }

  it('the tick skips it: no snapshot, no upload, no run, no outcome', async () => {
    const h = await boot(['settings'])

    await vi.advanceTimersByTimeAsync(61_000)
    // The tick DID fire and chose to skip — an idle timer would also leave no trace.
    await vi.waitFor(() =>
      expect(h.info).toHaveBeenCalledWith(
        'Scheduled backup skipped — no database it carries exists yet',
        expect.anything(),
      ),
    )

    expect(h.writeSnapshot).not.toHaveBeenCalled()
    expect(h.beginUpload).not.toHaveBeenCalled()
    expect(await h.listRuns()).toEqual([])
    const [schedule] = await h.listSchedules()
    expect(schedule?.lastError).toBeUndefined()
    expect(schedule?.lastSuccessAt).toBeUndefined()
  })

  it('once the owner has one of the files, the same tick goes ahead and asks for its snapshot', async () => {
    const h = await boot(['settings', 'events'])

    await vi.advanceTimersByTimeAsync(61_000)

    await vi.waitFor(() => expect(h.writeSnapshot).toHaveBeenCalledTimes(1))
    expect(h.writeSnapshot.mock.calls[0]?.[0]).toEqual({ databaseId: 'events' })
    // The owner refused (spec): the failure is on the record, so the run settled.
    await vi.waitFor(async () => {
      const [schedule] = await h.listSchedules()
      expect(schedule?.lastError).toContain('snapshot refused')
    })
  })
})

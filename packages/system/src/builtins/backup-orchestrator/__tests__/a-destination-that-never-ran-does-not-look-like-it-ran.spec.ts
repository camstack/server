/**
 * D384 — the destinations screen tells the truth about a backup that
 * did not happen.
 *
 * ## The incident this pins (hub, 2026-09-07)
 *
 * The operator: "SMB backup is enabled, it says last run tonight, but there
 * is nothing there." `backup.listDestinations` said, for `backups:smb`:
 * `enabled: true`, `cron: "0 3 * * *"`, `nextRunAt: tomorrow 03:00`, no
 * error. `backup.listArchives` said `[]`. Both were true statements about
 * different things, and together they were a lie:
 *
 *   - `cron` / `nextRunAt` came from `backup_destination_policies.cron`, a
 *     column seeded `0 3 * * *` for every new location and read by NOTHING
 *     since the schedules refactor (e286cc7ae, 2026-07-28). Sibling
 *     `backups:default` proved it: its policy advertised a nightly 03:00
 *     cadence while its only schedule was DISABLED, and its `nextRunAt` sat
 *     at 2026-07-29 — six weeks in the past.
 *   - the run DID fire at 03:00:26, the SMB provider refused with
 *     `missing config.share`, and the refusal lived only in a log line and
 *     an in-memory run record. The hub restarted five times that morning.
 *     By the time anyone looked, no surface held the reason.
 *
 * ## What is asserted
 *
 * Everything goes through the real addon's provider surface. The only fake
 * is the storage cap, and it is not a decider: it refuses `backups:smb` the
 * way the real SMB provider did, and accepts everything else.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonContext, IScopedLogger, RecordsAccess, StorageLocation } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { BackupOrchestratorAddon } from '../backup-orchestrator.addon.js'
import { makeBackupRecords } from './support/backup-records.js'

const SMB_REFUSAL = 'smb-storage: location "backups:smb" missing config.share'

interface DestinationWire {
  readonly id: string
  readonly cron?: string
  readonly nextRunAt?: number
  readonly lastAttemptAt?: number
  readonly lastError?: string
  readonly lastSuccessAt?: number
}

interface ScheduleWire {
  readonly id: string
  readonly lastAttemptAt?: number
  readonly lastSuccessAt?: number
  readonly lastError?: string
}

interface BackupProvider {
  readonly trigger: (input?: {
    destinations?: string[]
    locations?: string[]
  }) => Promise<{ readonly entries: readonly unknown[] }>
  readonly listDestinations: () => Promise<readonly DestinationWire[]>
  readonly listRuns: () => Promise<readonly { readonly state: string }[]>
  readonly upsertSchedule: (input: {
    label: string
    cron: string
    enabled: boolean
    locationIds: readonly string[]
    retentionCount: number
  }) => Promise<ScheduleWire>
}

function makeLogger(): IScopedLogger {
  const noop = vi.fn()
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  return logger as unknown as IScopedLogger
}

function location(id: string): StorageLocation {
  return {
    id,
    type: 'backups',
    displayName: id,
    providerId: id.endsWith(':smb') ? 'smb-storage' : 'filesystem-storage',
    config: {},
    enabled: true,
    isSystem: false,
    createdAt: 1,
    updatedAt: 1,
  }
}

/**
 * Storage cap that refuses `backups:smb` at `beginUpload` — exactly where
 * the live provider refused — and accepts every other location.
 */
function makeCtx(
  locations: readonly StorageLocation[],
  dataDir: string,
  settings: SqliteSettingsBackend,
  records: RecordsAccess,
): AddonContext {
  const blobs = new Map<string, string>()
  const key = (loc: string, rel: string): string => `${loc}::${rel}`
  let uploadSeq = 0
  return {
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
    api: {
      storage: {
        listLocations: { query: vi.fn(async () => locations) },
        beginUpload: {
          mutate: vi.fn(async ({ location: loc }: { location: string }) => {
            if (loc === 'backups:smb') throw new Error(SMB_REFUSAL)
            uploadSeq += 1
            return { uploadId: `up-${uploadSeq.toString()}` }
          }),
        },
        writeChunk: { mutate: vi.fn(async () => undefined) },
        finalizeUpload: { mutate: vi.fn(async () => undefined) },
        abortUpload: { mutate: vi.fn(async () => undefined) },
        delete: { mutate: vi.fn(async () => undefined) },
        exists: {
          query: vi.fn(async ({ location: loc, relativePath }: Record<string, string>) =>
            blobs.has(key(loc ?? '', relativePath ?? '')),
          ),
        },
        read: {
          query: vi.fn(async ({ location: loc, relativePath }: Record<string, string>) => ({
            dataBase64: blobs.get(key(loc ?? '', relativePath ?? '')) ?? '',
          })),
        },
        write: {
          mutate: vi.fn(async (input: Record<string, unknown>) => {
            const data = input['data']
            const encoded =
              data instanceof Uint8Array
                ? Buffer.from(data).toString('base64')
                : String(input['dataBase64'] ?? '')
            blobs.set(key(String(input['location']), String(input['relativePath'])), encoded)
            return undefined
          }),
        },
      },
    },
  } as unknown as AddonContext
}

describe('a destination that never received an archive is reported as such (D384)', () => {
  let dataDir = ''
  let settings: SqliteSettingsBackend
  let addon: BackupOrchestratorAddon
  let provider: BackupProvider

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-backup-truth-'))
    fs.mkdirSync(path.join(dataDir, 'tls'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'tls', 'x.pem'), 'x')
    settings = new SqliteSettingsBackend(':memory:')
    await settings.initialize()
    addon = new BackupOrchestratorAddon()
    const result = await addon.initialize(
      makeCtx(
        [location('backups:default'), location('backups:smb')],
        dataDir,
        settings,
        (await makeBackupRecords()).records,
      ),
    )
    const registrations = (
      Array.isArray(result) ? result : (result?.providers ?? [])
    ) as ReadonlyArray<{ readonly provider: BackupProvider }>
    const first = registrations[0]
    if (!first) throw new Error('backup-orchestrator registered no provider')
    provider = first.provider
  })

  afterEach(async () => {
    await addon.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('persists WHY the destination refused, so the reason outlives the process', async () => {
    await provider.trigger({ destinations: ['backups:smb'], locations: ['tls'] })

    const smb = (await provider.listDestinations()).find((d) => d.id === 'backups:smb')
    expect(smb?.lastError).toBe(SMB_REFUSAL)
    expect(smb?.lastAttemptAt).toBeGreaterThan(0)
    // An attempt is not an archive: nothing landed, so nothing may claim a
    // successful backup here.
    expect(smb?.lastSuccessAt).toBeUndefined()
  })

  it('reports the run as FAILED when the only destination refused', async () => {
    await provider.trigger({ destinations: ['backups:smb'], locations: ['tls'] })

    const runs = await provider.listRuns()
    expect(runs.map((r) => r.state)).toEqual(['failed'])
  })

  it('clears the recorded failure once a later attempt lands', async () => {
    await provider.trigger({ destinations: ['backups:smb'], locations: ['tls'] })
    await provider.trigger({ destinations: ['backups:default'], locations: ['tls'] })

    const wire = await provider.listDestinations()
    expect(wire.find((d) => d.id === 'backups:smb')?.lastError).toBe(SMB_REFUSAL)
    const def = wire.find((d) => d.id === 'backups:default')
    expect(def?.lastError).toBeUndefined()
    expect(def?.lastAttemptAt).toBeGreaterThan(0)
  })

  it('advertises NO cadence for a destination no enabled schedule targets', async () => {
    // The `backups:default` shape on the hub: a policy row exists (seeded on
    // first listing) and the only schedule pointing at it is switched off.
    await provider.upsertSchedule({
      label: 'nightly',
      cron: '0 3 * * *',
      enabled: false,
      locationIds: ['backups:default'],
      retentionCount: 7,
    })

    const def = (await provider.listDestinations()).find((d) => d.id === 'backups:default')
    expect(def?.cron).toBeUndefined()
    expect(def?.nextRunAt).toBeUndefined()
  })

  it('advertises the cadence of the enabled schedule that actually targets it', async () => {
    await provider.upsertSchedule({
      label: 'Unraid',
      cron: '0 3 * * *',
      enabled: true,
      locationIds: ['backups:smb'],
      retentionCount: 7,
    })

    const wire = await provider.listDestinations()
    const smb = wire.find((d) => d.id === 'backups:smb')
    expect(smb?.cron).toBe('0 3 * * *')
    expect(smb?.nextRunAt).toBeGreaterThan(Date.now())
    // …and the destination the schedule does NOT name stays silent.
    expect(wire.find((d) => d.id === 'backups:default')?.cron).toBeUndefined()
  })
})

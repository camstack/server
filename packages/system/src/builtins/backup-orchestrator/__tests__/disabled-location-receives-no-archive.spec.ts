/**
 * A `backups` location the operator DISABLED receives no archive — D62.
 *
 * ## The defect this pins
 *
 * `StorageLocation.enabled` is the operator-visible write switch on the
 * storage screen. The recorder's placement pool honours it
 * (`recorder/addon/roots.ts`, `placementPool`) and the event-media pick
 * honours it (`pipeline-analytics/media-locations.ts`). The backup fan-out
 * did not: destinations came from `listLocations({ type: 'backups' })` joined
 * with `backup_destination_policies`, whose own `enabled` column is seeded
 * `true` for every newly-seen location. Two switches for one function, and the
 * one the operator can see was the ignored one — a location shown disabled
 * still received tonight's archive.
 *
 * ## Why this drives the REAL addon rather than the pure selector
 *
 * The decision lives in `selectBackupTargets`, and a spec on that function
 * alone would stay green if `resolveTargets` stopped calling it. So the
 * assertions here are on what the addon does to the WIRE: which location ids
 * `storage.beginUpload` is called with. The only fake is the storage cap
 * itself, and it is a recorder, not a decider — it accepts every upload it is
 * offered, so a destination that appears in `uploads` was chosen by production
 * code and by nothing else.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddonContext, IScopedLogger, StorageLocation } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupOrchestratorAddon } from '../backup-orchestrator.addon.js'

interface DestinationWire {
  readonly id: string
  readonly enabled: boolean
  readonly triggerSupported: boolean
}

interface BackupProvider {
  readonly trigger: (input?: {
    destinations?: string[]
    locations?: string[]
  }) => Promise<readonly unknown[]>
  readonly listDestinations: () => Promise<readonly DestinationWire[]>
}

/** Every `beginUpload` the addon issued, in order. */
interface UploadLog {
  readonly locations: string[]
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
  return logger as unknown as IScopedLogger
}

function location(id: string, enabled: boolean | undefined): StorageLocation {
  return {
    id,
    type: 'backups',
    displayName: id,
    providerId: 'filesystem-storage',
    config: {},
    isSystem: false,
    ...(enabled !== undefined ? { enabled } : {}),
    createdAt: 1,
    updatedAt: 1,
  }
}

/**
 * A storage cap that ACCEPTS everything. It has no opinion about `enabled` —
 * that is deliberate: if the assertion below passes it is because production
 * refused, not because the double did.
 */
function makeCtx(
  locations: readonly StorageLocation[],
  dataDir: string,
): { ctx: AddonContext; uploads: UploadLog } {
  const uploads: UploadLog = { locations: [] }
  const blobs = new Map<string, string>()
  const key = (loc: string, rel: string): string => `${loc}::${rel}`
  const ctx = {
    id: 'backup-orchestrator',
    logger: makeLogger(),
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    addonConfig: {},
    dataDir,
    nodeDataDir: dataDir,
    // No capability registry ⇒ no settings backend ⇒ every policy falls back
    // to `enabled: true`. That IS the shipped shape of the defect: the policy
    // says yes for a location the operator turned off.
    kernel: { localNodeId: 'hub' },
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
    },
    api: {
      storage: {
        listLocations: { query: vi.fn(async () => locations) },
        beginUpload: {
          mutate: vi.fn(async ({ location: loc }: { location: string }) => {
            uploads.locations.push(loc)
            return { uploadId: `up-${uploads.locations.length.toString()}` }
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
  return { ctx, uploads }
}

async function bootAddon(
  locations: readonly StorageLocation[],
  dataDir: string,
): Promise<{ provider: BackupProvider; uploads: UploadLog; addon: BackupOrchestratorAddon }> {
  const { ctx, uploads } = makeCtx(locations, dataDir)
  const addon = new BackupOrchestratorAddon()
  const result = await addon.initialize(ctx)
  const registrations = (
    Array.isArray(result) ? result : (result?.providers ?? [])
  ) as ReadonlyArray<{
    readonly provider: BackupProvider
  }>
  const first = registrations[0]
  if (!first) throw new Error('backup-orchestrator registered no provider')
  return { provider: first.provider, uploads, addon }
}

describe('backup fan-out honours StorageLocation.enabled (D62)', () => {
  let dataDir = ''
  let addons: BackupOrchestratorAddon[] = []

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-backup-enabled-'))
    // One small, real archivable location so `createArchive` succeeds without
    // tarring anything large.
    fs.mkdirSync(path.join(dataDir, 'tls'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'tls', 'x.pem'), 'x')
    addons = []
  })

  afterEach(async () => {
    for (const addon of addons) await addon.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('skips a disabled destination in the policy fan-out and still writes the enabled one', async () => {
    const { provider, uploads, addon } = await bootAddon(
      [location('backups:default', true), location('backups:usb', false)],
      dataDir,
    )
    addons.push(addon)

    await provider.trigger({ locations: ['tls'] })

    expect(uploads.locations).toEqual(['backups:default'])
  })

  it('refuses an explicitly requested destination whose location is disabled', async () => {
    const { provider, uploads, addon } = await bootAddon(
      [location('backups:default', true), location('backups:usb', false)],
      dataDir,
    )
    addons.push(addon)

    await expect(
      provider.trigger({ destinations: ['backups:usb'], locations: ['tls'] }),
    ).rejects.toThrow(/backups:usb/)
    expect(uploads.locations).toEqual([])
  })

  it('a flagless legacy location is still a destination — absent means active', async () => {
    const { provider, uploads, addon } = await bootAddon(
      [location('backups:default', undefined), location('backups:usb', false)],
      dataDir,
    )
    addons.push(addon)

    await provider.trigger({ locations: ['tls'] })

    expect(uploads.locations).toEqual(['backups:default'])
  })

  it('reports the disabled destination as not trigger-supported — off must LOOK off', async () => {
    const { provider, addon } = await bootAddon(
      [location('backups:default', true), location('backups:usb', false)],
      dataDir,
    )
    addons.push(addon)

    const wire = await provider.listDestinations()
    const usb = wire.find((d) => d.id === 'backups:usb')
    expect(usb?.triggerSupported).toBe(false)
  })
})

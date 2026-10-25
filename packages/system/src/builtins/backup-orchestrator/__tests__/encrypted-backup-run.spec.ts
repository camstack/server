/**
 * Backup encryption through the real addon (operator decision 2026-10-09):
 * set up on the Backup page, the hub keeps the PUBLIC key, every run uploads
 * ciphertext, and a restore asks for the secret key — refusing a missing or
 * wrong one before any download. Disabling it, or an archive made before it,
 * restores without a key. A setting the store cannot read fails the run
 * rather than shipping a plain archive.
 *
 * The destination is a byte store (the default and SMB destinations both go
 * through the same `storage` chunked protocol; the orchestrator never sees
 * which), so what it holds here is exactly what would sit on the share.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type AddonContext,
  type IScopedLogger,
  type StorageLocation,
  settingsStoreCapability,
} from '@camstack/types'
import * as tar from 'tar'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CapabilityRegistry } from '../../../kernel/capability-registry.js'
import {
  makeAddonContext,
  registrationsOf,
} from '../../device-manager/__tests__/typed-addon-context.js'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import {
  BackupKeyMismatchError,
  readBackupEncryptionHeader,
} from '../../system-backup/backup-encryption.js'
import { BackupOrchestratorAddon } from '../backup-orchestrator.addon.js'
import { MANIFESTS_FILENAME, parseManifestBytes } from '../manifest-store.js'
import { BackupKeyRequiredError } from '../restore-archive.js'

interface Entry {
  readonly id: string
  readonly encryption?: { readonly scheme: string; readonly keyId: string }
}

interface Provider {
  trigger(input?: { destinations?: string[]; locations?: string[] }): Promise<{
    entries: readonly Entry[]
  }>
  listArchives(input: { destinationId: string }): Promise<readonly Entry[]>
  getEntries(input: { destinationId: string; backupId: string }): Promise<unknown>
  restore(input: {
    destinationId: string
    backupId: string
    backupSecretKey?: string
  }): Promise<void>
  getEncryption(): Promise<{
    enabled: boolean
    active: { keyId: string; publicKey: string } | null
    keys: readonly { keyId: string; retiredAt: number | null }[]
  }>
  setupEncryption(): Promise<{
    keyId: string
    secretKey: string
    publicKey: string
    replacedKeyId: string | null
  }>
  disableEncryption(): Promise<{ disabledKeyId: string | null }>
  checkBackupKey(input: { backupSecretKey: string }): Promise<{
    valid: boolean
    keyId: string | null
    known: boolean
    active: boolean
  }>
}

function isProvider(value: unknown): value is Provider {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'setupEncryption') === 'function' &&
    typeof Reflect.get(value, 'trigger') === 'function'
  )
}

function quietLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

const SETTINGS = {
  readAddonStore: async () => ({}),
  writeAddonStore: async () => undefined,
} as unknown as NonNullable<AddonContext['settings']>

const DEST: StorageLocation = {
  id: 'backups:smb',
  type: 'backups',
  displayName: 'NAS share',
  providerId: 'smb-storage',
  config: {},
  enabled: true,
  isSystem: false,
  createdAt: 1,
  updatedAt: 1,
}

const FILES: Record<string, string> = {
  'config.yaml': 'cluster: prod\n',
  'addons-data/export-hap/persist/AccessoryInfo.json': '{"LTSK":"hap-pairing-secret"}',
  'tls/key.pem': 'tls-private-key-secret',
}

describe('encrypted backups through the orchestrator', () => {
  let dataDir = ''
  let settings: SqliteSettingsBackend
  let addon: BackupOrchestratorAddon
  let provider: Provider
  let blobs: Map<string, Uint8Array>
  let downloads: string[]
  const key = (loc: string, rel: string): string => `${loc}::${rel}`

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-enc-run-'))
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true })
      fs.writeFileSync(path.join(dataDir, rel), content)
    }
    settings = new SqliteSettingsBackend(':memory:')
    await settings.initialize()
    const registry = new CapabilityRegistry(quietLogger())
    registry.declareCapability(settingsStoreCapability)
    registry.registerProvider('settings-store', 'storage-orchestrator', settings)

    blobs = new Map()
    downloads = []
    const uploads = new Map<string, { loc: string; rel: string; parts: Uint8Array[] }>()
    const sessions = new Map<string, string>()
    let n = 0
    const api = {
      storage: {
        listLocations: { query: async () => [DEST] },
        beginUpload: {
          mutate: async (input: { location: string; relativePath: string }) => {
            const uploadId = `up-${++n}`
            uploads.set(uploadId, { loc: input.location, rel: input.relativePath, parts: [] })
            return { uploadId }
          },
        },
        writeChunk: {
          mutate: async (input: { uploadId: string; data: Uint8Array }) => {
            uploads.get(input.uploadId)?.parts.push(Buffer.from(input.data))
          },
        },
        finalizeUpload: {
          mutate: async (input: { uploadId: string }) => {
            const u = uploads.get(input.uploadId)
            if (u) blobs.set(key(u.loc, u.rel), Buffer.concat(u.parts))
          },
        },
        abortUpload: { mutate: async () => undefined },
        delete: { mutate: async () => undefined },
        exists: {
          query: async (input: { location: string; relativePath: string }) =>
            blobs.has(key(input.location, input.relativePath)),
        },
        read: {
          query: async (input: { location: string; relativePath: string }) =>
            blobs.get(key(input.location, input.relativePath)) ?? new Uint8Array(),
        },
        write: {
          mutate: async (input: { location: string; relativePath: string; data: Uint8Array }) => {
            blobs.set(key(input.location, input.relativePath), input.data)
          },
        },
        beginDownload: {
          mutate: async (input: { location: string; relativePath: string }) => {
            downloads.push(input.relativePath)
            const k = key(input.location, input.relativePath)
            const data = blobs.get(k)
            if (data === undefined) throw new Error(`missing ${k}`)
            const downloadId = `dl-${++n}`
            sessions.set(downloadId, k)
            return { downloadId, sizeBytes: data.byteLength }
          },
        },
        readChunk: {
          query: async (input: { downloadId: string; offset: number; length: number }) => {
            const data = blobs.get(sessions.get(input.downloadId) ?? '') ?? new Uint8Array()
            return data.slice(input.offset, input.offset + input.length)
          },
        },
        endDownload: { mutate: async () => undefined },
      },
    }
    addon = new BackupOrchestratorAddon()
    const ctx: AddonContext = {
      ...makeAddonContext({
        id: 'backup-orchestrator',
        logger: quietLogger(),
        settings: SETTINGS,
        api,
        kernel: { localNodeId: 'hub', capabilityRegistry: registry },
      }),
      dataDir,
      nodeDataDir: dataDir,
    }
    const found = registrationsOf(await addon.initialize(ctx)).find((r) => isProvider(r.provider))
    if (found === undefined || !isProvider(found.provider)) throw new Error('no backup provider')
    provider = found.provider
  })

  afterEach(async () => {
    await addon.shutdown()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const backUp = async (): Promise<Entry> => {
    const result = await provider.trigger({
      destinations: [DEST.id],
      locations: ['config.yaml', 'addons-data', 'tls'],
    })
    const entry = result.entries[0]
    if (entry === undefined) throw new Error('nothing landed')
    return entry
  }

  const archiveBytes = (entry: Entry): Buffer => {
    const name = [...blobs.keys()].find((k) => k.includes(entry.id))
    return Buffer.from(blobs.get(name ?? '') ?? new Uint8Array())
  }

  const markerArchive = (): string => {
    const marker = JSON.parse(fs.readFileSync(path.join(dataDir, '.pending-restore.json'), 'utf8'))
    return String(marker.archivePath)
  }

  it('off by default: archives are the plain tar.gz they always were', async () => {
    expect((await provider.getEncryption()).enabled).toBe(false)
    const entry = await backUp()
    expect(entry.encryption).toBeUndefined()
    const bytes = archiveBytes(entry)
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
  })

  it('set up: the secret key is returned once and never stored; archives become ciphertext', async () => {
    const setup = await provider.setupEncryption()
    expect(setup.secretKey).toMatch(/^camstack-backup-secret-v1:/)
    expect(setup.replacedKeyId).toBeNull()
    const status = await provider.getEncryption()
    expect(status).toMatchObject({ enabled: true, active: { keyId: setup.keyId } })
    // The hub holds the public key only.
    const body = setup.secretKey.split(':')[1] ?? ''
    const stored = await settings.query({ collection: 'backup_encryption_keys' })
    expect(JSON.stringify(stored)).not.toContain(body)
    expect(JSON.stringify(status)).not.toContain(body)

    const entry = await backUp()
    expect(entry.encryption?.keyId).toBe(setup.keyId)
    const bytes = archiveBytes(entry)
    for (const secret of Object.values(FILES))
      expect(bytes.includes(Buffer.from(secret))).toBe(false)
    const listed = await provider.listArchives({ destinationId: DEST.id })
    expect(listed[0]?.encryption?.keyId).toBe(setup.keyId)
    // The destination's clear-text index carries the outline, not the file list.
    const index = parseManifestBytes(
      blobs.get(key(DEST.id, MANIFESTS_FILENAME)) ?? new Uint8Array(),
    )
    expect(index.archives[0]?.manifest.entries).toEqual([])
    expect(index.archives[0]?.manifest.locations).toEqual(['config.yaml', 'addons-data', 'tls'])
    expect(JSON.stringify(index)).not.toContain('AccessoryInfo')
  })

  it('restore without the key is refused before any download; with it, the archive is restored', async () => {
    const setup = await provider.setupEncryption()
    const entry = await backUp()

    const missing = await provider
      .restore({ destinationId: DEST.id, backupId: entry.id })
      .catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(BackupKeyRequiredError)
    expect(String(missing)).toContain(setup.keyId)
    expect(downloads).toEqual([])
    expect(fs.existsSync(path.join(dataDir, '.pending-restore.json'))).toBe(false)

    await provider.restore({
      destinationId: DEST.id,
      backupId: entry.id,
      backupSecretKey: setup.secretKey,
    })
    const plain = markerArchive()
    expect(await readBackupEncryptionHeader(plain)).toBeNull()
    expect((fs.statSync(plain).mode & 0o777).toString(8)).toBe('600')
    // What the boot-time restore will extract is the original tree.
    const out = path.join(dataDir, '..', `${path.basename(dataDir)}-out`)
    fs.mkdirSync(out)
    try {
      await tar.extract({ file: plain, cwd: out })
      for (const [rel, content] of Object.entries(FILES)) {
        expect(fs.readFileSync(path.join(out, rel), 'utf8')).toBe(content)
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true })
    }
  })

  it('regenerating: new archives need the new key, old ones still need the old key', async () => {
    const first = await provider.setupEncryption()
    const old = await backUp()
    const second = await provider.setupEncryption()
    expect(second.replacedKeyId).toBe(first.keyId)
    const fresh = await backUp()
    expect(fresh.encryption?.keyId).toBe(second.keyId)

    await expect(
      provider.restore({
        destinationId: DEST.id,
        backupId: old.id,
        backupSecretKey: second.secretKey,
      }),
    ).rejects.toBeInstanceOf(BackupKeyMismatchError)
    await provider.restore({
      destinationId: DEST.id,
      backupId: old.id,
      backupSecretKey: first.secretKey,
    })
    expect(fs.existsSync(markerArchive())).toBe(true)

    expect(await provider.checkBackupKey({ backupSecretKey: first.secretKey })).toEqual({
      valid: true,
      keyId: first.keyId,
      known: true,
      active: false,
    })
    expect(await provider.checkBackupKey({ backupSecretKey: second.secretKey })).toMatchObject({
      known: true,
      active: true,
    })
    expect((await provider.checkBackupKey({ backupSecretKey: 'typo' })).valid).toBe(false)
  })

  it('an archive made before encryption restores without a key', async () => {
    const plainEntry = await backUp()
    await provider.setupEncryption()
    await provider.restore({ destinationId: DEST.id, backupId: plainEntry.id })
    expect(await readBackupEncryptionHeader(markerArchive())).toBeNull()
  })

  it('disabling: new archives are plain again', async () => {
    const setup = await provider.setupEncryption()
    expect((await provider.disableEncryption()).disabledKeyId).toBe(setup.keyId)
    expect((await backUp()).encryption).toBeUndefined()
  })

  it('a setting the store cannot read fails the run — nothing is uploaded in clear', async () => {
    await provider.setupEncryption()
    const before = blobs.size
    const original = settings.query.bind(settings)
    settings.query = async (input) => {
      if (input.collection === 'backup_encryption_keys') throw new Error('disk I/O error')
      return original(input)
    }
    await expect(
      provider.trigger({ destinations: [DEST.id], locations: ['config.yaml'] }),
    ).rejects.toThrow(/encryption setting unreadable/)
    expect(blobs.size).toBe(before)
  })
})

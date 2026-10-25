import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BACKUP_LOCATIONS } from '../../system-backup/system-backup.service.js'
import {
  buildKeySourceCandidates,
  defaultKeyFilePath,
  type KeychainKeyConfig,
} from '../key-sources.js'
import { encodeKeyMaterial, generateKey } from '../keychain-crypto.js'
import { KeychainLockedError, KeychainService } from '../keychain-service.js'
import { KEYCHAIN_SECRETS_COLLECTION, KeychainRepository } from '../keychain-store.js'
import { createKeychainUsageCheck } from '../keychain-usage.js'
import { clearPlatformKeychainKey, setPlatformKeychainKey } from '../platform-key-source.js'
import { MemoryDoor } from './memory-door.js'
import { JWT_SIGNING_KEY_REF } from '../../../auth/jwt-signing-key.js'
import { buildSecretRef, recordSecretRef } from '@camstack/types'

// A cluster secret an older hub left in the keychain (D857 removed the feature): the code no
// longer knows it, so it is an ordinary system-owned value the operator deletes by hand.
const LEGACY_CLUSTER_SECRET_REF = buildSecretRef({
  owner: 'system',
  scope: { kind: 'global' },
  fieldPath: 'clusterSecret',
})

const REF = 'secret://cloudflare-tunnel/global/customApiToken'
const OTHER = 'secret://auth-oidc/global/providers[authentik].clientSecret'

interface Harness {
  readonly service: KeychainService
  readonly events: Array<Record<string, unknown>>
}

let dataDir: string
let door: MemoryDoor

function boot(
  config: KeychainKeyConfig = {},
  runnerIdOf: (id: string) => string = (id) => id,
): Harness {
  const events: Array<Record<string, unknown>> = []
  const service = new KeychainService({
    repo: new KeychainRepository(door),
    candidates: async () => buildKeySourceCandidates({ config, dataDir }),
    dataDir,
    events: { emit: (payload) => events.push({ ...payload }) },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    runnerIdOf,
    usage: createKeychainUsageCheck(door),
  })
  return { service, events }
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'keychain-spec-'))
  door = new MemoryDoor()
})

afterEach(async () => {
  clearPlatformKeychainKey()
  await fsp.rm(dataDir, { recursive: true, force: true })
})

describe('first boot and unlock', () => {
  it('generates the default master key 0600 in a 0700 directory, and a restart unlocks with it', async () => {
    const first = boot()
    expect(await first.service.init()).toEqual({ state: 'ready' })
    const file = defaultKeyFilePath(dataDir)
    expect((await fsp.stat(file)).mode & 0o777).toBe(0o600)
    expect((await fsp.stat(path.dirname(file))).mode & 0o777).toBe(0o700)
    await first.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')

    // A restart re-resolves: a fresh service over the same tables and key.
    const second = boot()
    expect(await second.service.init()).toEqual({ state: 'ready' })
    expect((await second.service.resolve('cloudflare-tunnel', [REF]))[REF]).toEqual({
      kind: 'value',
      value: 'token-value-aaaa',
      version: 1,
    })
  })

  it('status reports the path it actually generated, read and unlocked from — the configured one', async () => {
    const first = boot()
    expect(await first.service.init()).toEqual({ state: 'ready' })
    const expected = defaultKeyFilePath(dataDir)
    const before = await first.service.status()
    expect(before.configuredSource.path).toBe(expected)
    expect(before.keySource?.path).toBe(expected)
    await expect(fsp.access(expected)).resolves.toBeUndefined()

    // A restart: a fresh provider instance over the same tables and data dir.
    const restarted = boot()
    expect(await restarted.service.init()).toEqual({ state: 'ready' })
    const after = await restarted.service.status()
    expect(after.keychain).toEqual({ state: 'ready' })
    expect(after.keySource?.path).toBe(expected)
    expect(after.configuredSource.path).toBe(expected)
    expect(after.fingerprint).toBe(before.fingerprint)
  })

  it('a key file that cannot be written fails generation LOUDLY and stores no wrapped key', async () => {
    // chmod(dataDir, 0o500) is NOT enough: the CI runner is root and ignores
    // directory write bits. Force the mkdir of `<dataDir>/.keychain` to fail
    // with EACCES so generation has nowhere to land.
    const realMkdir = fsp.mkdir.bind(fsp)
    const mkdirSpy = vi.spyOn(fsp, 'mkdir').mockImplementation(async (p, opts) => {
      if (String(p).endsWith(`${path.sep}.keychain`) || String(p).endsWith('/.keychain')) {
        throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' })
      }
      return realMkdir(p, opts as never)
    })
    try {
      const h = boot()
      await expect(h.service.init()).rejects.toThrow(defaultKeyFilePath(dataDir))
      // No `keychain:keys` row: a later boot that CAN write starts clean.
      expect(await new KeychainRepository(door).listKeys()).toEqual([])
    } finally {
      mkdirSpy.mockRestore()
    }
    const retry = boot()
    expect(await retry.service.init()).toEqual({ state: 'ready' })
  })

  it('the master key is not in any default backup location', () => {
    const rel = path.relative(dataDir, defaultKeyFilePath(dataDir))
    const top = rel.split(path.sep)[0]
    expect(DEFAULT_BACKUP_LOCATIONS).not.toContain(top)
    for (const loc of DEFAULT_BACKUP_LOCATIONS)
      expect(rel.startsWith(`${loc}${path.sep}`)).toBe(false)
  })

  it('a wrong key is `wrong-key`: put refuses and resolve answers unavailable — never empty', async () => {
    const first = boot()
    await first.service.init()
    await first.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await fsp.writeFile(defaultKeyFilePath(dataDir), encodeKeyMaterial(generateKey()))

    const second = boot()
    expect(await second.service.init()).toEqual({ state: 'locked', reason: 'wrong-key' })
    expect((await second.service.resolve('cloudflare-tunnel', [REF]))[REF]).toEqual({
      kind: 'unavailable',
      reason: 'wrong-key',
    })
    await expect(second.service.put('cloudflare-tunnel', REF, 'x-y-z-1234')).rejects.toBeInstanceOf(
      KeychainLockedError,
    )
  })

  it('a lost key is `key-missing` and does NOT generate a fresh, empty keychain', async () => {
    const first = boot()
    await first.service.init()
    await first.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await fsp.rm(defaultKeyFilePath(dataDir))

    const second = boot()
    expect(await second.service.init()).toEqual({ state: 'locked', reason: 'key-missing' })
    await expect(fsp.access(defaultKeyFilePath(dataDir))).rejects.toThrow()
  })

  it('values with no wrapped data key lock instead of starting over', async () => {
    await door.set({ collection: KEYCHAIN_SECRETS_COLLECTION, key: REF, value: { ref: REF } })
    const h = boot()
    expect(await h.service.init()).toEqual({ state: 'locked', reason: 'key-missing' })
    await expect(fsp.access(defaultKeyFilePath(dataDir))).rejects.toThrow()
  })

  it('a configured key file that does not exist yet is the operator’s to create', async () => {
    const h = boot({ keyFile: path.join(dataDir, 'outside', 'keychain.key') })
    expect(await h.service.init()).toEqual({ state: 'locked', reason: 'key-missing' })
    await expect(fsp.access(defaultKeyFilePath(dataDir))).rejects.toThrow()
  })

  it('an unreadable configured key file is named, not folded into wrong-key', async () => {
    const keyFile = path.join(dataDir, 'k.key')
    await fsp.writeFile(keyFile, 'not a key')
    const h = boot({ keyFile })
    expect(await h.service.init()).toEqual({ state: 'locked', reason: 'key-file-unreadable' })
  })

  it('the desktop OS-keychain key is primary when no key file is configured', async () => {
    setPlatformKeychainKey({ label: 'macOS Keychain', key: generateKey() })
    const h = boot()
    await h.service.init()
    const status = await h.service.status()
    expect(status.keySource?.kind).toBe('platform')
    expect(status.keySource?.sharesBackupWithDatabase).toBe(false)
    await expect(fsp.access(defaultKeyFilePath(dataDir))).rejects.toThrow()
  })
})

describe('the owner rule', () => {
  it('a caller reads and writes only its own refs; an unidentified caller owns nothing', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    expect((await h.service.resolve('auth-oidc', [REF]))[REF]).toEqual({ kind: 'forbidden' })
    expect((await h.service.resolve(null, [REF]))[REF]).toEqual({ kind: 'forbidden' })
    await expect(h.service.put('auth-oidc', REF, 'stolen-value-1')).rejects.toThrow(/does not own/)
    await expect(h.service.put(null, REF, 'stolen-value-1')).rejects.toThrow(/unidentified/)
  })

  it('a grouped runner’s stamp (its group id) owns the refs of the addons it hosts', async () => {
    const h = boot({}, (id) => (id === 'auth-oidc' ? 'auth' : id))
    await h.service.init()
    await h.service.put('auth', OTHER, 'client-secret-value')
    expect((await h.service.resolve('auth', [OTHER]))[OTHER]).toMatchObject({ kind: 'value' })
    expect((await h.service.resolve('notifiers', [OTHER]))[OTHER]).toEqual({ kind: 'forbidden' })
  })

  it('the in-process context id form normalises', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put(
      'addon:loki-logging',
      'secret://loki-logging/global/password',
      'loki-password-1',
    )
    expect(
      (await h.service.resolve('loki-logging', ['secret://loki-logging/global/password']))[
        'secret://loki-logging/global/password'
      ],
    ).toMatchObject({ value: 'loki-password-1' })
  })
})

describe('values', () => {
  it('a ciphertext copied onto another ref does not decrypt (AAD = ref)', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    const row = door.tables.get(KEYCHAIN_SECRETS_COLLECTION)?.get(REF)
    const moved = 'secret://cloudflare-tunnel/global/customTunnelToken'
    door.tables.get(KEYCHAIN_SECRETS_COLLECTION)?.set(moved, { ...row, ref: moved })
    expect((await h.service.resolve('cloudflare-tunnel', [moved]))[moved]).toEqual({
      kind: 'unavailable',
      reason: 'decrypt-failed',
    })
  })

  it('stores ciphertext only — the value is nowhere in the tables', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'canary-plaintext-value')
    expect(
      JSON.stringify([...door.tables.entries()].map(([k, t]) => [k, [...t.entries()]])),
    ).not.toContain('canary-plaintext-value')
  })

  it('re-putting the same value writes nothing and keeps the version', async () => {
    const h = boot()
    await h.service.init()
    expect(await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')).toEqual({
      ref: REF,
      version: 1,
    })
    expect(await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')).toEqual({
      ref: REF,
      version: 1,
    })
    expect(await h.service.put('cloudflare-tunnel', REF, 'token-value-bbbb')).toEqual({
      ref: REF,
      version: 2,
    })
    expect(h.events.filter((e) => e['change'] === 'put')).toHaveLength(2)
  })

  it('events carry ref, owner and version — never the value', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await h.service.delete('cloudflare-tunnel', [REF])
    expect(h.events).toEqual([
      { ref: REF, owner: 'cloudflare-tunnel', version: 1, change: 'put' },
      { ref: REF, owner: 'cloudflare-tunnel', version: null, change: 'delete' },
    ])
    expect(JSON.stringify(h.events)).not.toContain('token-value-aaaa')
  })

  it('writes, deletes and reveals are audited; reads are not', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await h.service.resolve('cloudflare-tunnel', [REF])
    await h.service.reveal('admin-1', REF)
    await h.service.delete('cloudflare-tunnel', [REF])
    const actions = (await h.service.listAudit(50)).map((a) => `${a.action}:${a.actor}`)
    expect(actions.sort()).toEqual(
      [
        'delete:addon:cloudflare-tunnel',
        'initialize:system',
        'put:addon:cloudflare-tunnel',
        'reveal:user:admin-1',
      ].sort(),
    )
  })
})

describe('master-key rotation and recovery', () => {
  it('rotating the default key re-wraps without touching a value; a restart unlocks with the new key', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    const before = (await h.service.status()).fingerprint
    const ciphertextBefore = door.tables.get(KEYCHAIN_SECRETS_COLLECTION)?.get(REF)?.['ciphertext']
    const rotated = await h.service.rotateMasterKey('admin-1')
    expect(rotated.fingerprint).not.toBe(before)
    expect(door.tables.get(KEYCHAIN_SECRETS_COLLECTION)?.get(REF)?.['ciphertext']).toBe(
      ciphertextBefore,
    )
    expect((await h.service.status()).retiredWraps).toBe(1)

    const restarted = boot()
    expect(await restarted.service.init()).toEqual({ state: 'ready' })
    expect((await restarted.service.status()).fingerprint).toBe(rotated.fingerprint)
    expect((await restarted.service.resolve('cloudflare-tunnel', [REF]))[REF]).toMatchObject({
      value: 'token-value-aaaa',
    })
    expect(await restarted.service.purgeRetiredKeys('admin-1')).toBe(1)
  })

  it('moving to an external key file: unlock via previousKeyFile, then rotate onto the configured one', async () => {
    const oldFile = path.join(dataDir, 'old.key')
    const newFile = path.join(dataDir, 'new.key')
    const oldKey = generateKey()
    await fsp.writeFile(oldFile, encodeKeyMaterial(oldKey))
    const a = boot({ keyFile: oldFile })
    await a.service.init()
    await a.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')

    await fsp.writeFile(newFile, encodeKeyMaterial(generateKey()))
    const b = boot({ keyFile: newFile, previousKeyFile: oldFile })
    expect(await b.service.init()).toEqual({ state: 'ready' })
    expect((await b.service.status()).rotationPending).toBe(true)
    await b.service.rotateMasterKey('admin-1')

    await fsp.rm(oldFile)
    const c = boot({ keyFile: newFile })
    expect(await c.service.init()).toEqual({ state: 'ready' })
    expect((await c.service.status()).rotationPending).toBe(false)
    expect((await c.service.resolve('cloudflare-tunnel', [REF]))[REF]).toMatchObject({
      value: 'token-value-aaaa',
    })
  })

  it('the recovery key unlocks a hub that lost its key file', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    const recovery = await h.service.downloadRecoveryKey('admin-1')
    expect((await h.service.status()).recoveryKeyDownloadedAt).not.toBeNull()
    await fsp.rm(defaultKeyFilePath(dataDir))
    const recoveredFile = path.join(dataDir, 'recovered.key')
    await fsp.writeFile(recoveredFile, recovery.key)
    const restored = boot({ keyFile: recoveredFile })
    expect(await restored.service.init()).toEqual({ state: 'ready' })
  })

  it('reset archives every value and starts over: fields read "not set"', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await fsp.rm(defaultKeyFilePath(dataDir))
    const locked = boot()
    expect(await locked.service.init()).toEqual({ state: 'locked', reason: 'key-missing' })
    const result = await locked.service.resetKeychain('admin-1')
    expect(result.archived).toBe(1)
    expect(locked.service.getState()).toEqual({ state: 'ready' })
    expect((await locked.service.resolve('cloudflare-tunnel', [REF]))[REF]).toEqual({
      kind: 'missing',
    })
  })
})

describe('orphans', () => {
  it('a ref no blob points at is an orphan; an unreadable scope is unknown and never deleted', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await h.service.put(
      'cloudflare-tunnel',
      'secret://cloudflare-tunnel/global/customTunnelToken',
      'tunnel-tok-1',
    )
    await door.set({
      collection: 'addon-settings',
      key: 'cloudflare-tunnel.customApiToken',
      value: {
        addonId: 'cloudflare-tunnel',
        key: 'customApiToken',
        value: { $secret: REF, v: 1 },
      },
    })
    const listed = await h.service.listSecrets()
    expect(Object.fromEntries(listed.map((s) => [s.fieldPath, s.usage]))).toEqual({
      customApiToken: 'in-use',
      customTunnelToken: 'orphan',
    })
    door.failReads = true
    const usage = await createKeychainUsageCheck(door)([])
    expect(usage.size).toBe(0)
    door.failReads = false
  })
})

describe('orphans while a migration is incomplete (D870)', () => {
  it('a secret only an OLD per-addon blob still points at is in use, not an orphan', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await door.set({
      namespace: 'cloudflare-tunnel',
      collection: 'addon-settings',
      key: 'root',
      value: { customApiToken: { $secret: REF, v: 1 } },
    })
    const listed = await h.service.listSecrets()
    expect(listed.find((s) => s.ref === REF)?.usage).toBe('in-use')
  })
})

describe('system-held secrets (D797)', () => {
  it('the session signing key is always in use — no blob holds its marker, and it is never an orphan', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('system', JWT_SIGNING_KEY_REF, 'signing-key-aaaa')
    const listed = await h.service.listSecrets()
    expect(listed.find((s) => s.ref === JWT_SIGNING_KEY_REF)?.usage).toBe('in-use')
    const result = await h.service.deleteOrphans('u1', [JWT_SIGNING_KEY_REF])
    expect(result.deleted).toEqual([])
    expect(await h.service.resolve('system', [JWT_SIGNING_KEY_REF])).toEqual({
      [JWT_SIGNING_KEY_REF]: { kind: 'value', value: 'signing-key-aaaa', version: 1 },
    })
  })

  it('a cluster secret left by an older hub is an orphan the operator can delete (D857)', async () => {
    const h = boot()
    await h.service.init()
    await h.service.put('system', LEGACY_CLUSTER_SECRET_REF, 'cluster-secret-1')
    const listed = await h.service.listSecrets()
    expect(listed.find((s) => s.ref === LEGACY_CLUSTER_SECRET_REF)?.usage).toBe('orphan')
    const result = await h.service.deleteOrphans('u1', [LEGACY_CLUSTER_SECRET_REF])
    expect(result.deleted).toEqual([LEGACY_CLUSTER_SECRET_REF])
  })

  it('setSystemSecret stores a named system-held value, audited as the operator', async () => {
    const h = boot()
    await h.service.init()
    const out = await h.service.setSystemSecret('u-op', 'jwt-signing-key', 'imported-key-1')
    expect(out).toEqual({ ref: JWT_SIGNING_KEY_REF, version: 1 })
    expect(await h.service.resolve('system', [JWT_SIGNING_KEY_REF])).toEqual({
      [JWT_SIGNING_KEY_REF]: { kind: 'value', value: 'imported-key-1', version: 1 },
    })
    const audit = await h.service.listAudit(10)
    expect(
      audit.some(
        (a) => a.action === 'put' && a.actor === 'user:u-op' && a.ref === JWT_SIGNING_KEY_REF,
      ),
    ).toBe(true)
    expect(h.events.at(-1)).toMatchObject({
      ref: JWT_SIGNING_KEY_REF,
      owner: 'system',
      change: 'put',
    })
  })

  it('setSystemSecret refuses while the keychain is locked', async () => {
    const h = boot({ keyFile: path.join(dataDir, 'missing.key') })
    await h.service.init()
    await expect(
      h.service.setSystemSecret('u-op', 'jwt-signing-key', 'x-value-123'),
    ).rejects.toBeInstanceOf(KeychainLockedError)
  })

  it('importSecret accepts record row secret refs for migration, audited, no overwrite', async () => {
    const h = boot()
    await h.service.init()
    const ref = recordSecretRef(
      'import-homeassistant',
      'broker-config',
      'ha-main',
      'longLivedToken',
    )
    expect(await h.service.importSecret('u-op', ref, 'plain-token')).toEqual({ ref, version: 1 })
    expect(await h.service.resolve('import-homeassistant', [ref])).toEqual({
      [ref]: { kind: 'value', value: 'plain-token', version: 1 },
    })
    await expect(h.service.importSecret('u-op', ref, 'other')).rejects.toThrow(/already stored/)
  })

  it('importSecret takes broker restream tokens and migration refs, audited, never overwrites', async () => {
    const h = boot()
    await h.service.init()
    const ref = 'secret://stream-broker/device/7/rtspTokens'
    expect(await h.service.importSecret('u-op', ref, '{"a":"b"}')).toEqual({ ref, version: 1 })
    const audit = await h.service.listAudit(10)
    expect(audit.some((a) => a.action === 'put' && a.actor === 'user:u-op' && a.ref === ref)).toBe(
      true,
    )
    await expect(h.service.importSecret('u-op', ref, '{"a":"c"}')).rejects.toThrow(/already stored/)
    await expect(
      h.service.importSecret('u-op', 'secret://recorder/global/apiToken', 'x'),
    ).rejects.toThrow(/not an importable ref/)
    expect(await h.service.resolve('stream-broker', [ref])).toEqual({
      [ref]: { kind: 'value', value: '{"a":"b"}', version: 1 },
    })
  })
})

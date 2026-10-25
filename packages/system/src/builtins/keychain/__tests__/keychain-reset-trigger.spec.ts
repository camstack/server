/**
 * The one-shot `RESET_KEYCHAIN` trigger file (operator decision 2026-10-09).
 *
 * A hub whose master key is lost has no session that could reach System →
 * Secrets (the session signing key is IN the keychain, D797), so recovery is a
 * file the operator creates on the host. It acts only on a LOCKED keychain,
 * is deleted after every attempt, and nothing in the environment arms it.
 */
import { promises as fsp } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSecretRef, KEYCHAIN_RESET_TRIGGER_ACTOR } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JWT_SIGNING_KEY_REF } from '../../../auth/jwt-signing-key.js'
import {
  buildKeySourceCandidates,
  defaultKeyFilePath,
  type KeychainKeyConfig,
} from '../key-sources.js'
import { encodeKeyMaterial, generateKey } from '../keychain-crypto.js'
import { applyKeychainResetTrigger, keychainResetTriggerPath } from '../keychain-reset-trigger.js'
import { KeychainService } from '../keychain-service.js'
import { KeychainRepository } from '../keychain-store.js'
import { createKeychainUsageCheck } from '../keychain-usage.js'
import { MemoryDoor } from './memory-door.js'

// A cluster secret an older hub left in the keychain (D857 removed the feature): the code no
// longer knows it, so it is an ordinary system-owned value the operator deletes by hand.
const LEGACY_CLUSTER_SECRET_REF = buildSecretRef({
  owner: 'system',
  scope: { kind: 'global' },
  fieldPath: 'clusterSecret',
})

const REF = 'secret://cloudflare-tunnel/global/customApiToken'

interface Logged {
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown> | undefined
}

let dataDir: string
let door: MemoryDoor
let logged: Logged[]
let events: Array<Record<string, unknown>>

const logger = {
  info: (message: string, meta?: Record<string, unknown>) =>
    logged.push({ level: 'info', message, meta }),
  warn: (message: string, meta?: Record<string, unknown>) =>
    logged.push({ level: 'warn', message, meta }),
  error: (message: string, meta?: Record<string, unknown>) =>
    logged.push({ level: 'error', message, meta }),
}

function boot(config: KeychainKeyConfig = {}): KeychainService {
  return new KeychainService({
    repo: new KeychainRepository(door),
    candidates: async () => buildKeySourceCandidates({ config, dataDir }),
    dataDir,
    events: { emit: (payload) => events.push({ ...payload }) },
    logger,
    runnerIdOf: (id) => id,
    usage: createKeychainUsageCheck(door),
  })
}

/** A hub that stored values, then lost its default master key. */
async function lockedHubWithValues(): Promise<KeychainService> {
  const first = boot()
  await first.init()
  await first.put('cloudflare-tunnel', REF, 'token-value-aaaa')
  await first.put('system', JWT_SIGNING_KEY_REF, 'signing-key-aaaa-bbbb')
  await first.put('system', LEGACY_CLUSTER_SECRET_REF, 'cluster-secret-1')
  await fsp.writeFile(defaultKeyFilePath(dataDir), encodeKeyMaterial(generateKey()))
  const locked = boot()
  expect(await locked.init()).toEqual({ state: 'locked', reason: 'wrong-key' })
  return locked
}

async function armTrigger(): Promise<string> {
  const file = keychainResetTriggerPath(dataDir)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, '')
  return file
}

async function exists(file: string): Promise<boolean> {
  return fsp.access(file).then(
    () => true,
    () => false,
  )
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'keychain-reset-'))
  door = new MemoryDoor()
  logged = []
  events = []
})

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true })
})

describe('RESET_KEYCHAIN trigger file', () => {
  it('lives in the keychain directory of the data root', () => {
    expect(keychainResetTriggerPath(dataDir)).toBe(
      path.join(dataDir, '.keychain', 'RESET_KEYCHAIN'),
    )
  })

  it('without the file, a locked keychain stays locked and nothing is archived', async () => {
    const locked = await lockedHubWithValues()
    const outcome = await applyKeychainResetTrigger({ service: locked, dataDir, logger })
    expect(outcome.kind).toBe('absent')
    expect(locked.getState()).toEqual({ state: 'locked', reason: 'wrong-key' })
    expect((await locked.status()).secretCount).toBe(3)
  })

  it('locked + file: archives every value, starts a new master and data key, clears the system markers, and removes the file', async () => {
    const locked = await lockedHubWithValues()
    const lostKey = await fsp.readFile(defaultKeyFilePath(dataDir), 'utf8')
    const file = await armTrigger()

    const outcome = await applyKeychainResetTrigger({ service: locked, dataDir, logger })

    expect(outcome.kind).toBe('reset')
    expect(await exists(file)).toBe(false)
    expect(locked.getState()).toEqual({ state: 'ready' })
    // A NEW master key: the default file was replaced, the old one kept aside.
    expect(await fsp.readFile(defaultKeyFilePath(dataDir), 'utf8')).not.toBe(lostKey)
    // Every value archived; every field now reads "not set".
    expect(await locked.resolve('cloudflare-tunnel', [REF])).toEqual({ [REF]: { kind: 'missing' } })
    // The session signing key is missing → local-auth generates a new one.
    expect(await locked.resolve('system', [JWT_SIGNING_KEY_REF])).toEqual({
      [JWT_SIGNING_KEY_REF]: { kind: 'missing' },
    })
    // Keepers reload: one delete event per archived ref.
    expect(events.filter((e) => e['change'] === 'delete').map((e) => e['ref'])).toEqual(
      expect.arrayContaining([REF, JWT_SIGNING_KEY_REF, LEGACY_CLUSTER_SECRET_REF]),
    )
    // Loud: an error-level line names the reset.
    expect(logged.some((l) => l.level === 'error' && /KEYCHAIN RESET/.test(l.message))).toBe(true)
    // The new keychain stores values.
    await locked.put('cloudflare-tunnel', REF, 'new-token-value')
    expect((await locked.resolve('cloudflare-tunnel', [REF]))[REF]).toMatchObject({ kind: 'value' })
  })

  it('the reset is recorded for the Secrets page, with what is left to re-enter', async () => {
    const locked = await lockedHubWithValues()
    await armTrigger()
    await applyKeychainResetTrigger({ service: locked, dataDir, logger })

    const status = await locked.status()
    expect(status.lastReset).toMatchObject({
      actor: KEYCHAIN_RESET_TRIGGER_ACTOR,
      lockedReason: 'wrong-key',
      archived: 3,
      clearedSettingsKeys: [],
      acknowledgedAt: null,
    })
    expect(status.lastReset?.archivedCollection).toMatch(/^keychain:secrets-orphaned-\d+$/)
    expect(status.lastReset?.archivedKeysCollection).toMatch(/^keychain:keys-orphaned-\d+$/)

    // The signing key is the hub's own to regenerate; it is not "to re-enter".
    let report = await locked.resetReport()
    expect(report.pendingReentry.map((m) => m.ref).toSorted()).toEqual(
      [LEGACY_CLUSTER_SECRET_REF, REF].toSorted(),
    )
    await locked.put('cloudflare-tunnel', REF, 'entered-again')
    report = await locked.resetReport()
    expect(report.pendingReentry.map((m) => m.ref)).toEqual([LEGACY_CLUSTER_SECRET_REF])

    const audit = await locked.listAudit(20)
    expect(
      audit.some((a) => a.action === 'reset' && a.actor === KEYCHAIN_RESET_TRIGGER_ACTOR),
    ).toBe(true)

    await locked.acknowledgeReset('admin-1')
    expect((await locked.status()).lastReset?.acknowledgedAt).not.toBeNull()
  })

  it('the archive keeps the old wrapped data key, so a lost key that turns up can still open it', async () => {
    const locked = await lockedHubWithValues()
    await armTrigger()
    await applyKeychainResetTrigger({ service: locked, dataDir, logger })
    const record = (await locked.status()).lastReset
    const keys = await door.query({ collection: record?.archivedKeysCollection ?? '' })
    expect(keys.length).toBe(1)
    expect(typeof keys[0]?.data['wrappedDek']).toBe('string')
  })

  it('unlocked + file: ignored, the file removed, with a warning — a working store is never destroyed', async () => {
    const h = boot()
    await h.init()
    await h.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    const file = await armTrigger()

    const outcome = await applyKeychainResetTrigger({ service: h, dataDir, logger })

    expect(outcome.kind).toBe('ignored-unlocked')
    expect(await exists(file)).toBe(false)
    expect(h.getState()).toEqual({ state: 'ready' })
    expect((await h.resolve('cloudflare-tunnel', [REF]))[REF]).toMatchObject({
      kind: 'value',
      value: 'token-value-aaaa',
    })
    expect(logged.some((l) => l.level === 'warn' && /RESET_KEYCHAIN/.test(l.message))).toBe(true)
    expect((await h.status()).lastReset).toBeNull()
  })

  it('a configured key file that is missing refuses the reset BEFORE archiving anything, and removes the file', async () => {
    const keyFile = path.join(dataDir, 'outside', 'keychain.key')
    await fsp.mkdir(path.dirname(keyFile), { recursive: true })
    await fsp.writeFile(keyFile, encodeKeyMaterial(generateKey()))
    const first = boot({ keyFile })
    await first.init()
    await first.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await fsp.rm(keyFile)
    const locked = boot({ keyFile })
    expect(await locked.init()).toEqual({ state: 'locked', reason: 'key-missing' })
    const file = await armTrigger()

    const outcome = await applyKeychainResetTrigger({ service: locked, dataDir, logger })

    expect(outcome.kind).toBe('refused')
    expect(await exists(file)).toBe(false)
    expect(locked.getState()).toEqual({ state: 'locked', reason: 'key-missing' })
    expect((await locked.status()).secretCount).toBe(1)
    expect(logged.some((l) => l.level === 'error' && l.message.includes(keyFile))).toBe(true)
  })

  it('a configured key file with a NEW key: the reset starts over under it', async () => {
    const keyFile = path.join(dataDir, 'outside', 'keychain.key')
    await fsp.mkdir(path.dirname(keyFile), { recursive: true })
    await fsp.writeFile(keyFile, encodeKeyMaterial(generateKey()))
    const first = boot({ keyFile })
    await first.init()
    await first.put('cloudflare-tunnel', REF, 'token-value-aaaa')
    await fsp.writeFile(keyFile, encodeKeyMaterial(generateKey()))
    const locked = boot({ keyFile })
    expect(await locked.init()).toEqual({ state: 'locked', reason: 'wrong-key' })
    await armTrigger()

    expect((await applyKeychainResetTrigger({ service: locked, dataDir, logger })).kind).toBe(
      'reset',
    )
    expect(locked.getState()).toEqual({ state: 'ready' })
    expect((await locked.status()).keySource?.kind).toBe('config-file')
  })

  it('no environment variable arms it — only the file does', async () => {
    const locked = await lockedHubWithValues()
    const saved = { ...process.env }
    try {
      process.env['RESET_KEYCHAIN'] = '1'
      process.env['CAMSTACK_RESET_KEYCHAIN'] = 'true'
      process.env['CAMSTACK_KEYCHAIN_RESET'] = '1'
      const outcome = await applyKeychainResetTrigger({ service: locked, dataDir, logger })
      expect(outcome.kind).toBe('absent')
      expect(locked.getState()).toEqual({ state: 'locked', reason: 'wrong-key' })
    } finally {
      for (const k of ['RESET_KEYCHAIN', 'CAMSTACK_RESET_KEYCHAIN', 'CAMSTACK_KEYCHAIN_RESET']) {
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = saved[k]
      }
    }
  })

  it('a store that cannot be read leaves the trigger armed: there is nothing to reset yet', async () => {
    await lockedHubWithValues()
    const file = await armTrigger()
    door.failReads = true
    const failing = boot()
    expect(await failing.init()).toEqual({ state: 'locked', reason: 'store-unavailable' })
    // `store-unavailable` is not a lost key: the trigger waits for a boot that can act.
    const outcome = await applyKeychainResetTrigger({ service: failing, dataDir, logger })
    door.failReads = false
    expect(outcome.kind).toBe('deferred')
    expect(await exists(file)).toBe(true)
  })
})

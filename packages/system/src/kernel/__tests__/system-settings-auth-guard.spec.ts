/**
 * The store may NOT answer for the bootstrap `auth` section — D675 — and
 * since D797 neither may env nor config.yaml for a credential.
 *
 * `system-settings` may still hold `auth.jwtSecret`, `auth.adminUsername` and
 * `auth.adminPassword` (written by `local-auth` and by older builds) next to
 * `auth.tokenExpiry`. A pre-D797 container also still sets the retired
 * `CAMSTACK_JWT_SECRET` / `CAMSTACK_ADMIN_USER` / `CAMSTACK_ADMIN_PASS`. None
 * of them may answer: the session signing key is the keychain's and the
 * first-boot admin is fixed. Only `auth.tokenExpiry` may come from the store.
 *
 * Both backends are exercised: the door (production — `local-auth` reads
 * `ctx.settings.getSection('auth')`, and the hub `AuthService` reads
 * `ConfigManager.get('auth.*')`) and a sync store (where this used to be
 * merged "highest priority").
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDataStoreDispatch } from '../../builtins/storage-orchestrator/data-store-dispatch.js'
import { SqliteSettingsBackend } from '../../builtins/sqlite-storage/sqlite-settings-backend.js'
import { ConfigManager } from '../config-manager.js'
import { STORE_READABLE_BOOTSTRAP_KEYS } from '../system-settings-policy.js'

const ENV = {
  CAMSTACK_JWT_SECRET: 'secret-from-env',
  CAMSTACK_ADMIN_USER: 'admin-from-env',
  CAMSTACK_ADMIN_PASS: 'password-from-env',
} as const

/** What a stale DB copy holds. None of it may win except the expiry. */
const STALE_ROWS: Readonly<Record<string, string>> = {
  'auth.jwtSecret': 'secret-from-db',
  'auth.adminUsername': 'admin-from-db',
  'auth.adminPassword': 'password-from-db',
  'auth.tokenExpiry': '2h',
  'server.port': '9999',
}

const NO_CONFIG_FILE = path.join(__dirname, 'no-such-config.yaml')
const tmpDirs: string[] = []
const backends: SqliteSettingsBackend[] = []
const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  for (const [key, value] of Object.entries(ENV)) {
    savedEnv.set(key, process.env[key])
    process.env[key] = value
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()
  for (const b of backends.splice(0)) await b.shutdown()
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function seededBackend(): Promise<SqliteSettingsBackend> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-guard-'))
  tmpDirs.push(dir)
  const backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await backend.initialize()
  backends.push(backend)
  for (const [key, value] of Object.entries(STALE_ROWS)) {
    await backend.set({ collection: 'system-settings', key, value })
  }
  return backend
}

/** Neither the retired env variables nor the stale rows answer. */
function expectNoCredentials(section: Record<string, unknown>): void {
  expect(section['jwtSecret']).toBeUndefined()
  expect(section['adminUsername']).toBeUndefined()
  expect(section['adminPassword']).toBeUndefined()
}

describe('auth answers no credential; only the allow-listed auth keys may come from the store', () => {
  it('door (production): the section local-auth reads carries no credential', async () => {
    const backend = await seededBackend()
    const cm = new ConfigManager(NO_CONFIG_FILE)
    cm.setSettingsDoor(createDataStoreDispatch(() => [backend]))
    await cm.whenSystemSettingsPreloaded()

    const auth = await cm.createSettingsView('local-auth').getSection('auth')
    expectNoCredentials(auth)
    expect(auth['tokenExpiry']).toBe('2h')

    const server = await cm.createSettingsView('local-network').getSection('server')
    expect(server['port']).toBe(4443)
  })

  it('door (production): get() — the hub AuthService — answers no credential, reads the expiry', async () => {
    const backend = await seededBackend()
    const cm = new ConfigManager(NO_CONFIG_FILE)
    cm.setSettingsDoor(createDataStoreDispatch(() => [backend]))
    await cm.whenSystemSettingsPreloaded()

    expect(cm.get('auth.jwtSecret')).toBeUndefined()
    expect(cm.get('auth.adminUsername')).toBeUndefined()
    expect(cm.get('auth.adminPassword')).toBeUndefined()
    expect(cm.get('auth.tokenExpiry')).toBe('2h')
  })

  it('sync store: a stored secret or password never answers either', async () => {
    const backend = await seededBackend()
    const cm = new ConfigManager(NO_CONFIG_FILE)
    cm.setSettingsStore(backend)

    const auth = cm.getSection('auth')
    expectNoCredentials(auth)
    expect(auth['tokenExpiry']).toBe('2h')
    expect(cm.getSection('server')['port']).toBe(4443)
    expect(cm.get('auth.jwtSecret')).toBeUndefined()
    expect(cm.get('auth.tokenExpiry')).toBe('2h')
  })

  it('NO env and a store holding credentials: the allow-list alone keeps them out (L1)', async () => {
    // The bootstrap layer holds no auth key at all, so this case is guarded
    // by `storeMayAnswer` and nothing else.
    for (const key of Object.keys(ENV)) delete process.env[key]
    const backend = await seededBackend()
    await backend.set({ collection: 'system-settings', key: 'auth.oidcClientSecret', value: 'x' })

    const sync = new ConfigManager(NO_CONFIG_FILE)
    sync.setSettingsStore(backend)
    expectNoCredentials(sync.getSection('auth'))
    // A bootstrap-section key the schema does not know reaches the store layer
    // of `get()` — only the allow-list stops it.
    expect(sync.get('auth.oidcClientSecret')).toBeUndefined()
    expect(sync.get('auth.jwtSecret')).toBeUndefined()

    const viaDoor = new ConfigManager(NO_CONFIG_FILE)
    viaDoor.setSettingsDoor(createDataStoreDispatch(() => [backend]))
    await viaDoor.whenSystemSettingsPreloaded()
    const auth = await viaDoor.createSettingsView('local-auth').getSection('auth')
    expectNoCredentials(auth)
    expect(auth['oidcClientSecret']).toBeUndefined()
    expect(auth['tokenExpiry']).toBe('2h')
  })

  it('reading the auth section never FETCHES a refused row — credentials never enter memory (L2)', async () => {
    const backend = await seededBackend()
    const door = createDataStoreDispatch(() => [backend])
    const fetched: string[] = []
    const spied = {
      ...door,
      get: async (input: Parameters<typeof door.get>[0]) => {
        fetched.push(input.key)
        return door.get(input)
      },
    }
    const cm = new ConfigManager(NO_CONFIG_FILE)
    cm.setSettingsDoor(spied)
    await cm.whenSystemSettingsPreloaded()
    await cm.createSettingsView('local-auth').getSection('auth')
    await cm.createSettingsView('local-network').getSection('server')
    const fetchedAuth = fetched.filter(
      (key) => key.startsWith('auth.') || key.startsWith('server.'),
    )
    // Only the allow-listed auth keys are ever fetched — never a credential row.
    expect(fetchedAuth.length).toBeGreaterThan(0)
    for (const key of fetchedAuth) expect(STORE_READABLE_BOOTSTRAP_KEYS.has(key)).toBe(true)
    expect(fetchedAuth).toContain('auth.tokenExpiry')
  })
})

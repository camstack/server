/**
 * `ConfigManager` on an ISOLATED engine — production since D231: hub-main is
 * handed the async `settings-store` door and never a sync `ISettingsStore`.
 *
 * Every read here goes to a REAL `SqliteSettingsBackend` through the REAL
 * storage-orchestrator dispatcher (`createDataStoreDispatch`), which is what
 * `setSettingsDoor` receives on the hub. The rows are written through the
 * production writer (the door-backed settings view), so a reader that looks in
 * the wrong place, or answers without looking, cannot pass.
 *
 * D675: a synchronous reader must never answer `{}` / a default as SUCCESS
 * when it had no store to ask. Before the fix `getAddonConfig` read the
 * bootstrap file and answered `{}` for device-manager's whole row set, and
 * `get('capabilities.…')` skipped the store and answered "unset".
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ISettingsStoreProvider } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDataStoreDispatch } from '../../builtins/storage-orchestrator/data-store-dispatch.js'
import { SqliteSettingsBackend } from '../../builtins/sqlite-storage/sqlite-settings-backend.js'
import { CapabilityRegistry } from '../capability-registry.js'
import { ConfigManager } from '../config-manager.js'
import { isSettingsReadUnavailable, type SettingsReadRefusal } from '../settings-read-error.js'

const NO_CONFIG_FILE = path.join(__dirname, 'no-such-config.yaml')

const tmpDirs: string[] = []
const backends: SqliteSettingsBackend[] = []

beforeEach(() => {
  // ConfigManager's bootstrap console lines are documented residuals.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const b of backends.splice(0)) await b.shutdown()
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

/** A real engine behind the real dispatcher — the hub's `settings-store` door. */
async function realDoor(): Promise<ISettingsStoreProvider> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-door-only-'))
  tmpDirs.push(dir)
  const backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await backend.initialize()
  backends.push(backend)
  return createDataStoreDispatch(() => [backend])
}

/** The same door, with every read failing — a store that cannot answer. */
function failingReads(door: ISettingsStoreProvider): ISettingsStoreProvider {
  return {
    ...door,
    query: async () => {
      throw new Error('settings door timed out')
    },
    get: async () => {
      throw new Error('settings door timed out')
    },
  }
}

/** Assert `fn` throws the typed refusal with `reason`. */
function expectRefusal(fn: () => unknown, reason: SettingsReadRefusal): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (err: unknown) {
    thrown = err
  }
  expect(isSettingsReadUnavailable(thrown), String(thrown)).toBe(true)
  if (isSettingsReadUnavailable(thrown)) expect(thrown.reason).toBe(reason)
}

async function expectRefusalAsync(p: Promise<unknown>, reason: SettingsReadRefusal): Promise<void> {
  const thrown = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(isSettingsReadUnavailable(thrown), String(thrown)).toBe(true)
  if (isSettingsReadUnavailable(thrown)) expect(thrown.reason).toBe(reason)
}

/** A ConfigManager wired exactly as the hub wires it: door only. */
async function doorOnly(): Promise<{ cm: ConfigManager; door: ISettingsStoreProvider }> {
  const door = await realDoor()
  const cm = new ConfigManager(NO_CONFIG_FILE)
  cm.setSettingsDoor(door)
  await cm.whenSystemSettingsPreloaded()
  return { cm, door }
}

describe('addon-scoped sync readers refuse on an isolated engine', () => {
  it('getAddonConfig THROWS (door-only) even though the addon has rows — never `{}`', async () => {
    const { cm } = await doorOnly()
    await cm.createSettingsView('device-manager').writeAddonStore({ nextDeviceId: 4605 })
    expectRefusal(() => cm.getAddonConfig('device-manager'), 'door-only')
  })

  it('getAddonConfig THROWS (not-wired) before any backend exists', () => {
    const cm = new ConfigManager(NO_CONFIG_FILE)
    expectRefusal(() => cm.getAddonConfig('device-manager'), 'not-wired')
  })
})

describe('readAddonGlobalStrict — the three-way read behind addonSettingsRaw.getGlobal', () => {
  it('answers the rows the door holds', async () => {
    const { cm } = await doorOnly()
    const bindings = { '101': { doorbell: { wrapperAddonId: null } } }
    await cm
      .createSettingsView('device-manager')
      .writeAddonStore({ nextDeviceId: 4605, deviceBindings: bindings })
    expect(await cm.readAddonGlobalStrict('device-manager')).toEqual({
      nextDeviceId: 4605,
      deviceBindings: bindings,
    })
  })

  it('answers `{}` for an addon the store answered about and holds nothing for', async () => {
    const { cm } = await doorOnly()
    expect(await cm.readAddonGlobalStrict('never-written')).toEqual({})
  })

  it('THROWS (read-failed) when the door cannot be read — never `{}`', async () => {
    const door = await realDoor()
    const cm = new ConfigManager(NO_CONFIG_FILE)
    cm.setSettingsDoor(failingReads(door))
    await expectRefusalAsync(cm.readAddonGlobalStrict('device-manager'), 'read-failed')
  })

  it('THROWS (not-wired) before any backend exists', async () => {
    const cm = new ConfigManager(NO_CONFIG_FILE)
    await expectRefusalAsync(cm.readAddonGlobalStrict('device-manager'), 'not-wired')
  })

  it('readAddonDeviceStrict answers the device rows, `{}` for none, and throws on a failed door', async () => {
    const { cm, door } = await doorOnly()
    await cm.createSettingsView('recorder').writeDeviceStore(101, { enabled: true })
    expect(await cm.readAddonDeviceStrict('recorder', 101)).toEqual({ enabled: true })
    expect(await cm.readAddonDeviceStrict('recorder', 102)).toEqual({})
    cm.setSettingsDoor(failingReads(door))
    await expectRefusalAsync(cm.readAddonDeviceStrict('recorder', 101), 'read-failed')
  })
})

describe('system-settings readers on an isolated engine', () => {
  it('get() REFUSES a key the store may hold but cannot be read synchronously', async () => {
    const { cm, door } = await doorOnly()
    await door.set({ collection: 'system-settings', key: 'eventBus.ringBufferSize', value: 5 })
    expectRefusal(() => cm.get('eventBus.ringBufferSize'), 'door-only')
  })

  it('get() still answers bootstrap keys, which never come from the store', async () => {
    const { cm } = await doorOnly()
    expect(cm.get('server.port')).toBe(4443)
  })

  it('getSection() REFUSES synchronously; the settings view reads the section through the door', async () => {
    const { cm, door } = await doorOnly()
    await door.set({ collection: 'system-settings', key: 'auth.tokenExpiry', value: '12h' })
    expectRefusal(() => cm.getSection('auth'), 'door-only')
    const section = await cm.createSettingsView('system-config').getSection('auth')
    expect(section['tokenExpiry']).toBe('12h')
  })

  it('the view getSection THROWS when the door cannot be read — the form must not show defaults as saved', async () => {
    const door = await realDoor()
    const cm = new ConfigManager(NO_CONFIG_FILE)
    cm.setSettingsDoor(failingReads(door))
    await expect(cm.createSettingsView('system-config').getSection('auth')).rejects.toThrow(
      'settings door timed out',
    )
  })

  it('features are answered from the defaults — no surface writes them, and system.info must not fail', async () => {
    const { cm } = await doorOnly()
    expect(cm.features.streaming).toBe(true)
  })
})

describe('capability preferences are loaded from the door at boot (D675)', () => {
  it('a preference saved before a reboot is what get() reports after it', async () => {
    const door = await realDoor()
    // Life 1: the operator's choice, persisted the way `setPreference` does.
    const first = new ConfigManager(NO_CONFIG_FILE)
    first.setSettingsDoor(door)
    await first.whenSystemSettingsPreloaded()
    await first.set('capabilities.singleton.decoder', 'decoder-gpu')
    expect(
      await door.get({ collection: 'system-settings', key: 'capabilities.singleton.decoder' }),
    ).toBe('decoder-gpu')

    // Life 2: a fresh process over the same store.
    const second = new ConfigManager(NO_CONFIG_FILE)
    second.setSettingsDoor(door)
    const preload = second.whenSystemSettingsPreloaded()
    expectRefusal(() => second.get('capabilities.singleton.decoder'), 'preload-pending')
    expect(await preload).toMatchObject({ kind: 'loaded' })
    expect(second.get('capabilities.singleton.decoder')).toBe('decoder-gpu')
    // Loaded and never written is `undefined` — an honest "unset".
    expect(second.get('capabilities.singleton.storage')).toBeUndefined()
  })

  it('an unreadable boot read leaves the preference UNKNOWN, not unset', async () => {
    const door = await realDoor()
    const cm = new ConfigManager(NO_CONFIG_FILE)
    cm.setSettingsDoor(failingReads(door))
    expect(await cm.whenSystemSettingsPreloaded()).toMatchObject({ kind: 'failed' })
    expectRefusal(() => cm.get('capabilities.singleton.decoder'), 'preload-failed')
  })

  it('the registry replays the loaded preference onto a provider that registered first', async () => {
    const door = await realDoor()
    await door.set({
      collection: 'system-settings',
      key: 'capabilities.singleton.test-decoder',
      value: 'decoder-gpu',
    })
    const cm = new ConfigManager(NO_CONFIG_FILE)
    const registry = new CapabilityRegistry(silentLogger())
    // Wired exactly as addon-registry.service wires it: a read that cannot
    // answer is "no preference" until the replay.
    registry.setConfigReader((cap) => {
      try {
        return cm.get<string>(`capabilities.singleton.${cap}`) ?? undefined
      } catch {
        return undefined
      }
    })
    registry.declareCapability({
      name: 'test-decoder',
      scope: 'system',
      mode: 'singleton',
      methods: {},
    })
    cm.setSettingsDoor(door)
    const preload = cm.whenSystemSettingsPreloaded()
    registry.registerProvider('test-decoder', 'decoder-cpu', { name: 'cpu' })
    registry.registerProvider('test-decoder', 'decoder-gpu', { name: 'gpu' })
    expect(registry.getSingletonAddonId('test-decoder')).toBe('decoder-cpu')

    await preload
    const replay = registry.applyPersistedPreferences(() => false)
    expect(replay.singletons).toEqual([{ capability: 'test-decoder', addonId: 'decoder-gpu' }])
    expect(registry.getSingletonAddonId('test-decoder')).toBe('decoder-gpu')
  })
})

function silentLogger() {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

describe('ConfigManager.set reports a failed write honestly (L3)', () => {
  it('a door write that fails REJECTS and is not reported back as the value', async () => {
    const door = await realDoor()
    const cm = new ConfigManager(NO_CONFIG_FILE)
    cm.setSettingsDoor({
      ...door,
      set: async () => {
        throw new Error('settings door timed out')
      },
    })
    await cm.whenSystemSettingsPreloaded()
    await expect(cm.set('capabilities.singleton.decoder', 'decoder-gpu')).rejects.toThrow(
      'settings door timed out',
    )
    expect(cm.get('capabilities.singleton.decoder')).toBeUndefined()
  })

  it('rejects with no backend wired', async () => {
    const cm = new ConfigManager(NO_CONFIG_FILE)
    await expect(cm.set('capabilities.singleton.decoder', 'x')).rejects.toThrow('not-wired')
  })
})

describe('getDeviceRuntimeState before any backend (D677 alignment)', () => {
  it('throws the typed refusal rather than answering an empty row', () => {
    const cm = new ConfigManager(NO_CONFIG_FILE)
    expectRefusal(() => cm.getDeviceRuntimeState('101'), 'not-wired')
  })
})

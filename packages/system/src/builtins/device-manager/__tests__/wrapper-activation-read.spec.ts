/**
 * `deviceManager.getWrapperActivation` — the STORED activation, three-way
 * (D675).
 *
 * Written through the production writer (`setWrapperActive`) and read back
 * through the production view (`ConfigManager.createSettingsView` over the REAL
 * storage-orchestrator dispatcher and a REAL SQLite engine — the hub's door),
 * so the three answers are what production answers:
 *   `value`   — the operator activated (id) or deactivated (`null`) the wrapper;
 *   `missing` — the store answered and nobody touched this pair;
 *   `failed`  — the store could not be read. Never folded into `missing`.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddonContext, ISettingsStoreProvider } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigManager } from '../../../kernel/config-manager.js'
import { SqliteSettingsBackend } from '../../sqlite-storage/sqlite-settings-backend.js'
import { createDataStoreDispatch } from '../../storage-orchestrator/data-store-dispatch.js'
import { readWrapperActivation, setWrapperActive } from '../device-source-activation.js'
import { createWriteLock } from '../write-lock.js'
import { makeAddonContext } from './typed-addon-context.js'

const NO_CONFIG_FILE = path.join(__dirname, 'no-such-config.yaml')
const CAMERA = 101
const tmpDirs: string[] = []
const backends: SqliteSettingsBackend[] = []

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const b of backends.splice(0)) await b.shutdown()
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

async function realDoor(): Promise<ISettingsStoreProvider> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrapper-activation-'))
  tmpDirs.push(dir)
  const backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await backend.initialize()
  backends.push(backend)
  return createDataStoreDispatch(() => [backend])
}

const silent = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent,
  withTags: () => silent,
}

function ctxOver(settings: NonNullable<AddonContext['settings']>): AddonContext {
  return makeAddonContext({ id: 'addon:device-manager', logger: silent, settings, api: {} })
}

async function deviceManagerOver(door: ISettingsStoreProvider) {
  const cm = new ConfigManager(NO_CONFIG_FILE)
  cm.setSettingsDoor(door)
  const ctx = ctxOver(cm.createSettingsView('device-manager'))
  const deps = { ctx, capabilityRegistry: undefined, withAddonStoreWriteLock: createWriteLock() }
  return { cm, ctx, deps }
}

describe('getWrapperActivation — value / missing / failed', () => {
  it('value: the wrapper the operator activated', async () => {
    const { deps } = await deviceManagerOver(await realDoor())
    await setWrapperActive(deps, {
      deviceId: CAMERA,
      capName: 'ptz-autotrack',
      wrapperAddonId: 'test-wrapper',
      active: true,
    })
    expect(
      await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' }),
    ).toEqual({
      kind: 'value',
      wrapperAddonId: 'test-wrapper',
    })
  })

  it("value null: the operator's explicit OFF (camera 101)", async () => {
    const { deps } = await deviceManagerOver(await realDoor())
    await setWrapperActive(deps, {
      deviceId: CAMERA,
      capName: 'ptz-autotrack',
      wrapperAddonId: 'test-wrapper',
      active: false,
    })
    expect(
      await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' }),
    ).toEqual({
      kind: 'value',
      wrapperAddonId: null,
    })
  })

  it('missing: the activation map was read and holds nothing for this PAIR', async () => {
    const { deps } = await deviceManagerOver(await realDoor())
    await setWrapperActive(deps, {
      deviceId: 102,
      capName: 'ptz-autotrack',
      wrapperAddonId: 'test-wrapper',
      active: true,
    })
    // No entry for this device at all.
    expect(
      await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' }),
    ).toEqual({
      kind: 'missing',
    })
    await setWrapperActive(deps, {
      deviceId: CAMERA,
      capName: 'snapshot',
      wrapperAddonId: 'snapshot-ffmpeg',
      active: true,
    })
    // An entry for this device, none for this cap.
    expect(
      await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' }),
    ).toEqual({
      kind: 'missing',
    })
  })

  it('failed: a store with NO rows is not evidence of an unbind (D44, M2)', async () => {
    const { deps } = await deviceManagerOver(await realDoor())
    const read = await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' })
    expect(read.kind).toBe('failed')
  })

  it('failed: rows but no deviceBindings key is not evidence of an unbind either', async () => {
    const { cm, deps } = await deviceManagerOver(await realDoor())
    await cm.createSettingsView('device-manager').writeAddonStore({ nextDeviceId: 4605 })
    const read = await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' })
    expect(read.kind).toBe('failed')
  })

  it('reads ONE row — never a range scan of the whole device-manager store (M1)', async () => {
    const door = await realDoor()
    const queries: unknown[] = []
    const gets: unknown[] = []
    const spied: ISettingsStoreProvider = {
      ...door,
      query: async (input) => {
        queries.push(input)
        return door.query(input)
      },
      get: async (input) => {
        gets.push(input)
        return door.get(input)
      },
    }
    const { cm, deps } = await deviceManagerOver(spied)
    await cm.createSettingsView('device-manager').writeAddonStore({ nextDeviceId: 4605 })
    await setWrapperActive(deps, {
      deviceId: CAMERA,
      capName: 'ptz-autotrack',
      wrapperAddonId: 'test-wrapper',
      active: false,
    })
    queries.length = 0
    gets.length = 0
    expect(
      await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' }),
    ).toEqual({
      kind: 'value',
      wrapperAddonId: null,
    })
    expect(queries).toEqual([])
    expect(gets).toEqual([{ collection: 'addon-settings', key: 'device-manager.deviceBindings' }])
  })

  it('failed: a door that cannot be read is never `missing`', async () => {
    const door = await realDoor()
    const failing: ISettingsStoreProvider = {
      ...door,
      get: async () => {
        throw new Error('settings door timed out')
      },
    }
    const { deps } = await deviceManagerOver(failing)
    expect(
      await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' }),
    ).toEqual({
      kind: 'failed',
      error: 'settings door timed out',
    })
  })

  it('failed: no backend wired yet (the D294 window) is never `missing`', async () => {
    const cm = new ConfigManager(NO_CONFIG_FILE)
    const deps = { ctx: ctxOver(cm.createSettingsView('device-manager')) }
    const read = await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' })
    expect(read.kind).toBe('failed')
  })

  it('failed: a stored bindings map that is not a map is not evidence of an unbind', async () => {
    const { cm, deps } = await deviceManagerOver(await realDoor())
    await cm.createSettingsView('device-manager').writeAddonStore({ deviceBindings: 7 })
    const read = await readWrapperActivation(deps, { deviceId: CAMERA, capName: 'ptz-autotrack' })
    expect(read.kind).toBe('failed')
  })
})

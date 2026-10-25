/**
 * `addonSettingsRaw` over a REAL `ConfigService` wired the way the hub wires it
 * since D231: the async settings door only, no sync `ISettingsStore`.
 *
 * The previous spec drove the router with a Map-backed fake ConfigService whose
 * `getAddonConfig` round-tripped whatever `setAddonConfig` stored, so it could
 * never see that the real one, on an isolated engine, read the bootstrap file
 * and answered `{}` for every addon (D675). Here the rows live in a real SQLite
 * engine, written through the production writer, and a door that cannot read
 * is a door that throws — exactly what production does.
 */
import * as path from 'node:path'
import { SqliteSettingsBackend } from '@camstack/system'
import type { ISettingsStoreProvider } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAddonSettingsRouter } from '../api/core/addon-settings.router.js'
import { ConfigService } from '../core/config/config.service.js'
import { makeCtx } from './cap-routers/harness.js'

const NO_CONFIG_FILE = path.join(__dirname, 'no-such-config.yaml')
const engines: SqliteSettingsBackend[] = []

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const engine of engines.splice(0)) await engine.shutdown()
})

async function realEngine(): Promise<SqliteSettingsBackend> {
  const engine = new SqliteSettingsBackend(':memory:')
  await engine.initialize()
  engines.push(engine)
  return engine
}

/**
 * The engine as the `settings-store` door. `failReads` makes every read throw,
 * the way a timed-out UDS hop to the isolated engine does.
 */
function doorOver(engine: SqliteSettingsBackend, failReads = false): ISettingsStoreProvider {
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`settings-store.${name} is not part of this test`)
  }
  const readFailure = async (): Promise<never> => {
    throw new Error('settings door timed out')
  }
  return {
    query: failReads ? readFailure : (input) => engine.query(input),
    get: failReads ? readFailure : (input) => engine.get(input),
    set: (input) => engine.set(input),
    deleteWhere: (input) => engine.deleteWhere(input),
    upsert: refuse('upsert'),
    insert: refuse('insert'),
    insertMany: refuse('insertMany'),
    upsertMany: refuse('upsertMany'),
    transact: (input) => engine.transact(input),
    update: refuse('update'),
    delete: refuse('delete'),
    updateWhere: refuse('updateWhere'),
    count: refuse('count'),
    aggregate: refuse('aggregate'),
    histogram: refuse('histogram'),
    isEmpty: refuse('isEmpty'),
    declareCollection: refuse('declareCollection'),
  }
}

/** A hub-shaped ConfigService: door only, rows written by the production writer. */
async function hubConfig(failReads = false): Promise<ConfigService> {
  const engine = await realEngine()
  const writer = new ConfigService(NO_CONFIG_FILE)
  writer.setSettingsDoor(doorOver(engine))
  await writer.createSettingsView('device-manager').writeAddonStore({
    nextDeviceId: 4605,
    deviceBindings: { '101': { doorbell: { wrapperAddonId: null } } },
  })
  await writer.createSettingsView('recorder').writeDeviceStore(101, { enabled: true })
  const cfg = new ConfigService(NO_CONFIG_FILE)
  cfg.setSettingsDoor(doorOver(engine, failReads))
  return cfg
}

describe('addon-settings router — reads through the door, three-way (D675)', () => {
  it('getGlobal answers the rows the store holds — not `{}`', async () => {
    const caller = createAddonSettingsRouter(await hubConfig()).createCaller(makeCtx('admin'))
    expect(await caller.getGlobal({ addonId: 'device-manager' })).toEqual({
      nextDeviceId: 4605,
      deviceBindings: { '101': { doorbell: { wrapperAddonId: null } } },
    })
  })

  it('getGlobal answers `{}` only for an addon the store answered about and holds nothing for', async () => {
    const caller = createAddonSettingsRouter(await hubConfig()).createCaller(makeCtx('admin'))
    expect(await caller.getGlobal({ addonId: 'never-written' })).toEqual({})
  })

  it('getGlobal THROWS when the store cannot be read — an unanswered read is not `{}`', async () => {
    const caller = createAddonSettingsRouter(await hubConfig(true)).createCaller(makeCtx('admin'))
    await expect(caller.getGlobal({ addonId: 'device-manager' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  })

  it('getGlobal THROWS before any backend is wired', async () => {
    const cfg = new ConfigService(NO_CONFIG_FILE)
    const caller = createAddonSettingsRouter(cfg).createCaller(makeCtx('admin'))
    await expect(caller.getGlobal({ addonId: 'device-manager' })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    })
  })

  it('getDeviceOverrides answers the device rows, `{}` for none, and THROWS on a failed read', async () => {
    const caller = createAddonSettingsRouter(await hubConfig()).createCaller(makeCtx('admin'))
    expect(await caller.getDeviceOverrides({ addonId: 'recorder', deviceId: '101' })).toEqual({
      enabled: true,
    })
    expect(await caller.getDeviceOverrides({ addonId: 'recorder', deviceId: '102' })).toEqual({})
    const failing = createAddonSettingsRouter(await hubConfig(true)).createCaller(makeCtx('admin'))
    await expect(
      failing.getDeviceOverrides({ addonId: 'recorder', deviceId: '101' }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('getDeviceOverrides refuses a non-numeric device id', async () => {
    const caller = createAddonSettingsRouter(await hubConfig()).createCaller(makeCtx('admin'))
    await expect(
      caller.getDeviceOverrides({ addonId: 'recorder', deviceId: 'cam-1' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('offers no write methods — they had no callers and threw on every isolated engine', async () => {
    const router = createAddonSettingsRouter(await hubConfig())
    expect(Object.keys(router._def.procedures).toSorted()).toEqual([
      'getDeviceOverrides',
      'getGlobal',
    ])
  })
})

// SECURITY (F0.2): both methods read RAW addon config (notifier tokens,
// webhook secrets, API keys). Before the gate, `protectedProcedure` let any
// authenticated non-admin token read every addon's config. Neutralisation:
// revert a method to `protectedProcedure` and its expectation flips.
describe('addon-settings router — admin gate (F0.2)', () => {
  it('a non-admin token cannot READ raw global config', async () => {
    const caller = createAddonSettingsRouter(await hubConfig()).createCaller(makeCtx('user'))
    await expect(caller.getGlobal({ addonId: 'device-manager' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('a non-admin token cannot READ raw device overrides', async () => {
    const caller = createAddonSettingsRouter(await hubConfig()).createCaller(makeCtx('user'))
    await expect(
      caller.getDeviceOverrides({ addonId: 'recorder', deviceId: '101' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
/**
 * Google is a multi-instance exporter (planning#422 P2): the real addon booted over in-memory
 * records, driven through the capability providers it registers and its own HTTP routes.
 */
import {
  type AddonContext,
  type IAddonRouteProvider,
  type IDeviceExportProvider,
  type IIntegrationInstancesProvider,
  addonRoutesCapability,
  deviceExportCapability,
  integrationInstancesCapability,
  makeInMemoryRecords,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExportGoogleAddon } from '../export-google.addon.js'
import {
  EMPTY_GOOGLE_EXPORTS,
  GOOGLE_INSTANCE_ID,
  googleExportsKind,
  googleHomesKind,
  googleLinksKind,
} from '../export-records.js'
import { RecordingLogger } from './fakes.js'

const LAMP_FACTS = { id: 101, name: 'Lamp', type: 'light', features: [] }
const LINK_A = { userId: 'user-a', username: 'ann', linkedAt: 1700000000000 }
const SCOPES = [{ type: 'category', target: 'device', access: ['view', 'create'] }]

interface InvokeResult {
  readonly status: number
  readonly body: unknown
}

async function boot(options: { readonly seedHome?: boolean } = {}) {
  const world = makeInMemoryRecords('export-google')
  await world.records.declare({
    'google-homes': googleHomesKind,
    'google-exports': googleExportsKind,
    'google-links': googleLinksKind,
  })
  const homes = world.records.kind(googleHomesKind)
  const exportsHandle = world.records.kind(googleExportsKind)
  const links = world.records.kind(googleLinksKind)
  if (options.seedHome !== false) {
    await homes.put({ id: GOOGLE_INSTANCE_ID, data: { name: 'Google Home' } }, { ifRev: 0 })
    await links.put(
      { id: GOOGLE_INSTANCE_ID, data: { name: 'Google links', linkedAccounts: [LINK_A] } },
      { ifRev: 0 },
    )
    await exportsHandle.put(
      {
        id: GOOGLE_INSTANCE_ID,
        data: { ...EMPTY_GOOGLE_EXPORTS, devices: [{ deviceId: 7, exposedAt: 1 }] },
      },
      { ifRev: 0 },
    )
  }
  const logger = new RecordingLogger()
  const ctx = {
    id: 'export-google',
    logger,
    records: world.records,
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      readAddonStoreResult: vi.fn(async () => ({ kind: 'value' as const, value: {} })),
      writeAddonStore: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId: 'hub' },
    api: {
      migrations: {
        declareOwner: {
          mutate: vi.fn(async () => ({ bootId: 'b', snapshot: 'none', steps: [] })),
        },
        startMigration: { mutate: vi.fn() },
        finishMigration: { mutate: vi.fn() },
      },
      userManagement: {
        oauthVerifyAccessToken: {
          query: vi.fn(async ({ token }: { token: string }) => ({
            userId: token,
            username: `name-${token}`,
            scopes: SCOPES,
          })),
        },
        listUsers: { query: vi.fn(async () => []) },
      },
      deviceManager: {
        getDevice: {
          query: vi.fn(async ({ deviceId }: { deviceId: number }) => ({
            ...LAMP_FACTS,
            id: deviceId,
          })),
        },
        getBindings: { query: vi.fn(async () => ({ entries: [{ capName: 'switch' }] })) },
      },
      localNetwork: {
        getAddresses: {
          query: vi.fn(async () => ({
            roles: { publicEndpoint: { resolved: 'https://hub.example.org' } },
          })),
        },
      },
    },
  } as unknown as AddonContext
  const addon = new ExportGoogleAddon()
  const result = await addon.initialize(ctx)
  const registrations = result && 'providers' in result && result.providers ? result.providers : []
  const pick = (name: string) => registrations.find((r) => r.capability.name === name)?.provider
  const routes = pick(addonRoutesCapability.name) as IAddonRouteProvider & {
    invoke(input: unknown): Promise<InvokeResult>
  }
  const deviceExport = pick(deviceExportCapability.name) as IDeviceExportProvider
  const instances = pick(integrationInstancesCapability.name) as IIntegrationInstancesProvider
  const post = (path: string, token: string, intent: string): Promise<InvokeResult> =>
    routes.invoke({
      method: 'POST',
      path,
      params: {},
      query: {},
      headers: { authorization: `Bearer ${token}` },
      body: { requestId: 'r', inputs: [{ intent }] },
    })
  return { addon, world, homes, exportsHandle, links, logger, deviceExport, instances, post }
}

describe('export-google multi-instance', () => {
  const addons: ExportGoogleAddon[] = []
  afterEach(async () => {
    for (const a of addons.splice(0)) await a.shutdown()
  })

  it('declares itself multiple, mints ids, and lists the migrated instance under export-google', async () => {
    const w = await boot()
    addons.push(w.addon)
    await expect(w.instances.describe()).resolves.toMatchObject({
      instanceMode: 'multiple',
      role: 'services',
      mintsId: true,
    })
    expect((await w.instances.listInstances()).map((i) => i.id)).toEqual([GOOGLE_INSTANCE_ID])
  })

  it('the legacy /fulfillment URL answers for export-google exactly as /fulfillment/export-google', async () => {
    const w = await boot()
    addons.push(w.addon)
    const legacy = await w.post('/fulfillment', 'user-a', 'action.devices.SYNC')
    const named = await w.post(
      `/fulfillment/${GOOGLE_INSTANCE_ID}`,
      'user-a',
      'action.devices.SYNC',
    )
    expect(legacy.status).toBe(200)
    expect(legacy).toEqual(named)
    expect(JSON.stringify(legacy.body)).toContain('"id":"7"')
  })

  it('a second instance has its own exposure and its own links; DISCONNECT touches only its own', async () => {
    const w = await boot()
    addons.push(w.addon)
    const created = await w.instances.createInstance({ name: 'Second home' })
    expect(created.id).not.toBe(GOOGLE_INSTANCE_ID)
    await w.deviceExport.exposeDevice({ instanceId: created.id, deviceId: '101' })

    expect(
      (await w.deviceExport.listExposedDevices({ instanceId: created.id })).map((d) => d.deviceId),
    ).toEqual(['101'])
    expect(
      (await w.deviceExport.listExposedDevices({ instanceId: GOOGLE_INSTANCE_ID })).map(
        (d) => d.deviceId,
      ),
    ).toEqual(['7'])

    // user-b links ONLY the second instance (SYNC is the link signal).
    await w.post(`/fulfillment/${created.id}`, 'user-b', 'action.devices.SYNC')
    const second = (await w.links.get(created.id))?.data.linkedAccounts.map((a) => a.userId)
    expect(second).toEqual(['user-b'])
    expect(
      (await w.links.get(GOOGLE_INSTANCE_ID))?.data.linkedAccounts.map((a) => a.userId),
    ).toEqual(['user-a'])

    // user-a disconnects the FIRST instance: the second ledger is untouched, and vice versa.
    await w.post('/fulfillment', 'user-a', 'action.devices.DISCONNECT')
    expect((await w.links.get(GOOGLE_INSTANCE_ID))?.data.linkedAccounts).toEqual([])
    expect((await w.links.get(created.id))?.data.linkedAccounts).toHaveLength(1)
    await w.post(`/fulfillment/${created.id}`, 'user-b', 'action.devices.DISCONNECT')
    expect((await w.links.get(created.id))?.data.linkedAccounts).toEqual([])
  })

  it('an unknown or disabled instance answers 404 and writes nothing', async () => {
    const w = await boot()
    addons.push(w.addon)
    const unknown = await w.post('/fulfillment/nope', 'user-a', 'action.devices.SYNC')
    expect(unknown).toMatchObject({ status: 404, body: { error: 'unknown_instance' } })
    await w.instances.setInstanceEnabled({ id: GOOGLE_INSTANCE_ID, enabled: false })
    const off = await w.post('/fulfillment', 'user-z', 'action.devices.SYNC')
    expect(off).toMatchObject({ status: 404, body: { error: 'instance_disabled' } })
    expect((await w.links.get(GOOGLE_INSTANCE_ID))?.data.linkedAccounts).toEqual([LINK_A])
  })

  it('deleting an instance removes its google-exports and google-links rows, and only its own', async () => {
    const w = await boot()
    addons.push(w.addon)
    const created = await w.instances.createInstance({ name: 'Temp' })
    await w.deviceExport.exposeDevice({ instanceId: created.id, deviceId: '101' })
    await w.post(`/fulfillment/${created.id}`, 'user-b', 'action.devices.SYNC')
    expect(await w.exportsHandle.get(created.id)).not.toBeNull()
    expect(await w.links.get(created.id)).not.toBeNull()

    await w.instances.deleteInstance({ id: created.id })

    expect(await w.homes.get(created.id)).toBeNull()
    expect(await w.exportsHandle.get(created.id)).toBeNull()
    expect(await w.links.get(created.id)).toBeNull()
    expect(await w.exportsHandle.get(GOOGLE_INSTANCE_ID)).not.toBeNull()
    expect(await w.links.get(GOOGLE_INSTANCE_ID)).not.toBeNull()
    const after = await w.post(`/fulfillment/${created.id}`, 'user-b', 'action.devices.SYNC')
    expect(after.status).toBe(404)
  })

  it('the per-device toggles are keyed per instance and drive only their own instance', async () => {
    const w = await boot()
    addons.push(w.addon)
    const created = await w.instances.createInstance({ name: 'Second' })
    const schema = await w.deviceExport.getDeviceSettingsContribution({ deviceId: 101 })
    const keys = (schema?.sections ?? []).flatMap((s) =>
      s.fields.flatMap((f) => (f.type === 'boolean' ? [f.key] : [])),
    )
    expect(keys.sort()).toEqual(
      [`google:${GOOGLE_INSTANCE_ID}:101:enabled`, `google:${created.id}:101:enabled`].sort(),
    )
    await w.deviceExport.applyDeviceSettingsPatch({
      deviceId: 101,
      patch: { [`google:${created.id}:101:enabled`]: true },
    })
    expect((await w.exportsHandle.get(created.id))?.data.devices.map((d) => d.deviceId)).toEqual([
      101,
    ])
    expect(
      (await w.exportsHandle.get(GOOGLE_INSTANCE_ID))?.data.devices.map((d) => d.deviceId),
    ).toEqual([7])
  })

  it('an unknown instance on a device-export call is a typed refusal', async () => {
    const w = await boot()
    addons.push(w.addon)
    await expect(w.deviceExport.listExposedDevices({ instanceId: 'nope' })).rejects.toMatchObject({
      name: 'ExportInstanceUnknownError',
    })
  })
})

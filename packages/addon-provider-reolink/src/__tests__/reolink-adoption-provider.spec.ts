import { DeviceType, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ReolinkHubConnection } from '../hub-connection.js'
import {
  type AdoptedReolinkCamera,
  type AdoptionSession,
  buildReolinkAdoptionProvider,
  findAdoptedForChannel,
} from '../reolink-adoption-provider.js'
import type { HubChannel } from '../reolink-hub-session.js'

const CONNECTION: ReolinkHubConnection = {
  host: '10.0.0.5',
  port: 9000,
  username: 'admin',
  password: 'pw',
  transport: 'tcp',
  debugGeneral: false,
  debugSocketLogs: [],
}

function logger(): IScopedLogger {
  const l: IScopedLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => l,
    withTags: () => l,
  }
  return l
}

const CH0: HubChannel = {
  childNativeId: 'cam-UID0',
  channel: 0,
  name: 'Front',
  status: 'online',
  uid: 'UID0',
  isBattery: false,
  isDoorbell: false,
  isMultifocal: false,
}
const { uid: _uid, ...CH0_NO_UID } = CH0
const CH1: HubChannel = {
  ...CH0_NO_UID,
  childNativeId: 'channel-1',
  channel: 1,
  name: 'Back',
}

function setup(adopted: AdoptedReolinkCamera[] = []) {
  const session: AdoptionSession = {
    connection: CONNECTION,
    channelSnapshot: () => ({
      channels: [CH0, CH1],
      lastRefreshAt: 1,
      lastError: null,
    }),
    refresh: vi.fn(async () => undefined),
  }
  const adoptCamera = vi.fn(async () => ({
    deviceId: 99,
    accessoryDeviceIds: [100],
  }))
  const removeDevice = vi.fn(async () => undefined)
  const provider = buildReolinkAdoptionProvider({
    getSession: (id) => (id === 'int-1' ? session : null),
    listIntegrations: () => ['int-1'],
    listAdopted: async () => adopted,
    adoptCamera,
    removeDevice,
    findDeviceConfig: async () => null,
    logger: logger(),
  })
  return { provider, session, adoptCamera, removeDevice }
}

describe('findAdoptedForChannel', () => {
  it('recognises a migrated camera by uid even when its stableId carries the old hub prefix', () => {
    const adopted = [{ id: 7, config: { integrationId: 'int-1', uid: 'UID0', channel: 3 } }]
    expect(findAdoptedForChannel(adopted, 'int-1', CH0)).toBe(7)
  })
  it('never matches a camera of another integration', () => {
    const adopted = [{ id: 7, config: { integrationId: 'int-2', uid: 'UID0', channel: 0 } }]
    expect(findAdoptedForChannel(adopted, 'int-1', CH0)).toBeNull()
  })
  it('falls back to the channel when the hub reports no uid', () => {
    const adopted = [{ id: 8, config: { integrationId: 'int-1', channel: 1 } }]
    expect(findAdoptedForChannel(adopted, 'int-1', CH1)).toBe(8)
  })
})

describe('reolink adoption provider', () => {
  it('lists the hub channels as candidates and marks the adopted ones', async () => {
    const { provider } = setup([{ id: 7, config: { integrationId: 'int-1', uid: 'UID0' } }])
    const { candidates, totalCount } = await provider.listCandidates({
      integrationId: 'int-1',
      page: 1,
      pageSize: 50,
    })
    expect(totalCount).toBe(2)
    expect(candidates[0]).toMatchObject({
      childNativeId: 'cam-UID0',
      alreadyAdopted: true,
      adoptedDeviceId: 7,
    })
    expect(candidates[0]?.type).toBe(DeviceType.Camera)
    expect(candidates[1]).toMatchObject({
      childNativeId: 'channel-1',
      alreadyAdopted: false,
    })
  })

  it('adopts a channel as a top-level camera of the integration and re-reads the hub', async () => {
    const { provider, adoptCamera, session } = setup()
    const out = await provider.adopt({
      integrationId: 'int-1',
      childNativeIds: ['channel-1'],
      perCandidate: { 'channel-1': { name: 'Garden' } },
    })
    expect(adoptCamera).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'int-1',
        name: 'Garden',
        channel: CH1,
      }),
    )
    expect(out.adopted).toEqual([
      {
        childNativeId: 'channel-1',
        parentDeviceId: 99,
        accessoryDeviceIds: [100],
      },
    ])
    expect(session.refresh).toHaveBeenCalled()
  })

  it('does not adopt a channel twice', async () => {
    const { provider, adoptCamera } = setup([
      { id: 7, config: { integrationId: 'int-1', uid: 'UID0' } },
    ])
    const out = await provider.adopt({
      integrationId: 'int-1',
      childNativeIds: ['cam-UID0'],
    })
    expect(adoptCamera).not.toHaveBeenCalled()
    expect(out.adopted[0]?.parentDeviceId).toBe(7)
  })

  it('refuses an integration with no live session, and a channel the hub does not list', async () => {
    const { provider } = setup()
    await expect(provider.adopt({ integrationId: 'nope', childNativeIds: ['x'] })).rejects.toThrow(
      /no live NVR session/,
    )
    await expect(
      provider.adopt({ integrationId: 'int-1', childNativeIds: ['ghost'] }),
    ).rejects.toThrow(/all 1 adopt/)
  })

  it('releases by removing the camera', async () => {
    const { provider, removeDevice } = setup()
    await provider.release({ integrationId: 'int-1', camDeviceId: 99 })
    expect(removeDevice).toHaveBeenCalledWith(99)
  })
})

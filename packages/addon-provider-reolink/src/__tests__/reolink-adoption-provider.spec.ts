import { DeviceType, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ReolinkHubConnection } from '../hub-connection.js'
import {
  type AdoptedReolinkCamera,
  type AdoptionSession,
  buildReolinkAdoptionProvider,
  findAdoptedForChannel,
} from '../reolink-adoption-provider.js'
import { type HubChannel, hubGatewayNativeId } from '../reolink-hub-session.js'

const CONNECTION: ReolinkHubConnection = {
  host: '10.0.0.5',
  port: 9000,
  rtspPort: 554,
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

function setup(adopted: AdoptedReolinkCamera[] = [], adoptedGateways: number[] = []) {
  const session: AdoptionSession = {
    connection: CONNECTION,
    name: 'Home Hub',
    isOnline: true,
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
  const adoptGateway = vi.fn(async () => ({ deviceId: 55 }))
  const removeDevice = vi.fn(async () => undefined)
  const provider = buildReolinkAdoptionProvider({
    getSession: (id) => (id === 'int-1' ? session : null),
    listIntegrations: () => ['int-1'],
    listAdopted: async () => adopted,
    adoptCamera,
    listAdoptedGateways: async () => adoptedGateways.map((id) => ({ id, integrationId: 'int-1' })),
    adoptGateway,
    removeDevice,
    findDeviceConfig: async () => null,
    logger: logger(),
  })
  return { provider, session, adoptCamera, adoptGateway, removeDevice }
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
    expect(totalCount).toBe(3)
    expect(candidates[1]).toMatchObject({
      childNativeId: 'cam-UID0',
      alreadyAdopted: true,
      adoptedDeviceId: 7,
    })
    expect(candidates[1]?.type).toBe(DeviceType.Camera)
    expect(candidates[2]).toMatchObject({
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

  describe('the hub as a Gateway candidate', () => {
    const GATEWAY_ID = hubGatewayNativeId('int-1')

    it('lists the hub first, typed Gateway, with reboot and the admin link', async () => {
      const { provider } = setup()
      const { candidates } = await provider.listCandidates({
        integrationId: 'int-1',
        page: 1,
        pageSize: 50,
      })
      expect(candidates[0]).toMatchObject({
        childNativeId: GATEWAY_ID,
        type: DeviceType.Gateway,
        name: 'Home Hub',
        status: 'online',
        alreadyAdopted: false,
      })
      expect(candidates[0]?.capabilities).toEqual(['reboot', 'device-admin-link'])
    })

    it('is a sibling: no channel candidate is nested under it or carries it as parent', async () => {
      const { provider } = setup()
      const { candidates } = await provider.listCandidates({
        integrationId: 'int-1',
        page: 1,
        pageSize: 50,
      })
      const gateway = candidates.find((c) => c.type === DeviceType.Gateway)
      expect(gateway?.children).toBeUndefined()
      const cameras = candidates.filter((c) => c.type === DeviceType.Camera)
      expect(cameras).toHaveLength(2)
      for (const camera of cameras) expect(camera.childNativeId).not.toBe(GATEWAY_ID)
      expect(candidates.flatMap((c) => c.children ?? [])).toEqual([])
    })

    it('marks an adopted hub and adopts it as a top-level device', async () => {
      const adopted = setup([], [31])
      const { candidates } = await adopted.provider.listCandidates({
        integrationId: 'int-1',
        page: 1,
        pageSize: 50,
      })
      expect(candidates[0]).toMatchObject({ alreadyAdopted: true, adoptedDeviceId: 31 })

      const { provider, adoptGateway, adoptCamera } = setup()
      const out = await provider.adopt({ integrationId: 'int-1', childNativeIds: [GATEWAY_ID] })
      expect(adoptGateway).toHaveBeenCalledWith({ integrationId: 'int-1', name: 'Home Hub' })
      expect(adoptCamera).not.toHaveBeenCalled()
      expect(out.adopted).toEqual([
        { childNativeId: GATEWAY_ID, parentDeviceId: 55, accessoryDeviceIds: [] },
      ])
    })
  })
})

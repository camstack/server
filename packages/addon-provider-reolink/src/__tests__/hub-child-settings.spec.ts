/**
 * A camera adopted under an NVR / Home Hub: its settings show the hub and the channel, hide the
 * per-camera connection (and the sections that would rewrite the NVR), refuse a patch on the
 * connection with a typed reason, and never dial or link with its own stored address/credentials.
 */
import { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'
import type { ConfigUISchema } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { judgeHubChildPatch, HubChildPatchRefusedError } from '../hub-child-settings.js'
import { ReolinkCamera } from '../reolink-camera.js'
import { reolinkHubSessions, type HubSessionHandle } from '../reolink-hub-session.js'

const SENTINEL_API: ReolinkBaichuanApi = ReolinkBaichuanApi.prototype

const HUB: HubSessionHandle = {
  name: 'Home Hub',
  isOnline: true,
  reboot: async () => undefined,
  getApi: async () => SENTINEL_API,
  channelSnapshot: () => ({
    channels: [
      {
        channel: 0,
        name: 'Door',
        childNativeId: 'cam-A',
        status: 'online',
        isBattery: false,
        isDoorbell: false,
        isMultifocal: false,
      },
      {
        channel: 3,
        name: 'Yard',
        childNativeId: 'cam-B',
        status: 'online',
        isBattery: false,
        isDoorbell: false,
        isMultifocal: false,
      },
    ],
    lastRefreshAt: 1,
    lastError: null,
  }),
  relayEndpoint: () => ({
    host: '10.0.0.5',
    username: 'hubuser',
    password: 'hubpass',
    port: 554,
  }),
}

function makeCamera(config: Record<string, unknown>) {
  const warn = vi.fn()
  const setAll = vi.fn(async () => undefined)
  const camera = Object.create(ReolinkCamera.prototype)
  Object.defineProperties(camera, {
    id: { value: 21 },
    config: { value: { get: (k: string) => config[k], setAll } },
    ctx: { value: { logger: { warn, info: vi.fn(), debug: vi.fn() } } },
  })
  return { camera, warn, setAll }
}

const CHILD = {
  integrationId: 'int-1',
  channel: 3,
  host: '192.168.1.99',
  port: 9000,
  username: 'stale',
  password: 'WRONG',
}

afterEach(() => reolinkHubSessions.clear())

describe('judgeHubChildPatch', () => {
  it('refuses any connection key, naming them', () => {
    expect(judgeHubChildPatch({ host: 'x', password: 'y', channel: 1 }, [])).toEqual({
      reason: 'connection-owned-by-integration',
      keys: ['host', 'password'],
    })
  })
  it('validates the channel: integer, and within the hub list when known', () => {
    expect(judgeHubChildPatch({ channel: 1.5 }, [])?.reason).toBe('channel-not-an-integer')
    expect(judgeHubChildPatch({ channel: '2' }, [])?.reason).toBe('channel-not-an-integer')
    expect(judgeHubChildPatch({ channel: 7 }, [0, 3])?.reason).toBe('channel-out-of-range')
    expect(judgeHubChildPatch({ channel: 3 }, [0, 3])).toBeNull()
    expect(judgeHubChildPatch({ channel: 7 }, [])).toBeNull()
    expect(judgeHubChildPatch({ motionEnabled: true }, [0])).toBeNull()
  })
})

describe('hub child settings patch', () => {
  it('refuses a connection patch with a logged typed reason and writes nothing', async () => {
    reolinkHubSessions.set('int-1', HUB)
    const { camera, warn, setAll } = makeCamera(CHILD)
    const err = await camera.applySettingsPatch({ password: 'new' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HubChildPatchRefusedError)
    expect(setAll).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      'hub child settings patch refused',
      expect.objectContaining({ tags: { deviceId: 21 } }),
    )
  })

  it('refuses a channel the hub does not list', async () => {
    reolinkHubSessions.set('int-1', HUB)
    const { camera, setAll } = makeCamera(CHILD)
    await expect(camera.applySettingsPatch({ channel: 9 })).rejects.toBeInstanceOf(
      HubChildPatchRefusedError,
    )
    expect(setAll).not.toHaveBeenCalled()
  })

  it('accepts a listed channel', async () => {
    reolinkHubSessions.set('int-1', HUB)
    const { camera, setAll } = makeCamera(CHILD)
    await camera.applySettingsPatch({ channel: 0 })
    expect(setAll).toHaveBeenCalledWith({ channel: 0 })
  })
})

describe('hub child never uses its own stored address or credentials', () => {
  it('dials through the integration session, whatever password it stores', async () => {
    reolinkHubSessions.set('int-1', HUB)
    const { camera } = makeCamera(CHILD)
    await expect(camera.ensureApi()).resolves.toBe(SENTINEL_API)
  })

  it('builds the relay url from the integration credentials, not the stored ones', async () => {
    reolinkHubSessions.set('int-1', HUB)
    const { camera } = makeCamera(CHILD)
    Object.defineProperties(camera, {
      channelCount: { value: () => 4 },
      features: { value: [] },
    })
    const out = await camera.buildHubRelayDescriptors()
    const urls = JSON.stringify(out)
    expect(urls).toContain('hubuser:hubpass@10.0.0.5')
    expect(urls).not.toContain('WRONG')
    expect(urls).not.toContain('192.168.1.99')
  })

  it('has no FLV url of its own, and keys the stills lane / admin link on the hub host', () => {
    reolinkHubSessions.set('int-1', HUB)
    const { camera } = makeCamera(CHILD)
    expect(camera.buildFlvUrl(3, 'main')).toBeNull()
    expect(camera.connectionHost()).toBe('10.0.0.5')
  })

  it('a standalone camera keeps its own host', () => {
    const { camera } = makeCamera({ host: '192.168.1.50' })
    expect(camera.connectionHost()).toBe('192.168.1.50')
  })
})

describe('hub child settings schema', () => {
  function sectionIds(schema: { sections: readonly { id: string }[] }): string[] {
    return schema.sections.map((s) => s.id)
  }
  function fieldKeys(schema: {
    sections: readonly { fields: readonly { key: string }[] }[]
  }): string[] {
    return schema.sections.flatMap((s) => s.fields.map((f) => f.key))
  }
  function build(config: Record<string, unknown>): ConfigUISchema {
    const { camera } = makeCamera(config)
    Object.defineProperties(camera, {
      hasIncompleteSettingsCache: { value: () => false },
      refreshParentSettingsSnapshot: { value: async () => undefined },
      refreshSessionsSnapshot: { value: async () => undefined },
      isBattery: { value: false },
      features: { value: [] },
      hasProbed: { value: () => true },
      getProbeFlags: { value: () => ({}) },
      sessionsSnapshot: { value: null },
      name: { value: 'Yard' },
    })
    return camera.getSettingsUISchema()
  }

  it('shows Hub (hub name + channel) and hides connection, ports and NTP for a hub child', () => {
    reolinkHubSessions.set('int-1', HUB)
    const schema = build(CHILD)
    const ids = sectionIds(schema)
    expect(ids).toContain('hub')
    for (const hidden of ['connection', 'network-ports', 'time-ntp']) {
      expect(ids).not.toContain(hidden)
    }
    const keys = fieldKeys(schema)
    for (const gone of ['host', 'port', 'username', 'password']) expect(keys).not.toContain(gone)
    expect(keys).toEqual(expect.arrayContaining(['hubName', 'channel']))
    const hub = schema.sections.find((s) => s.id === 'hub')
    const hubName = hub?.fields.find((f) => f.key === 'hubName')
    expect(hubName).toMatchObject({ disabled: true, value: 'Home Hub' })
    expect(hub?.fields.find((f) => f.key === 'channel')).toMatchObject({
      value: 3,
    })
  })

  it('keeps the connection section and no Hub section for a standalone camera', () => {
    const schema = build({
      host: '192.168.1.50',
      port: 9000,
      username: 'admin',
      password: 'p',
    })
    const ids = sectionIds(schema)
    expect(ids).toEqual(expect.arrayContaining(['connection', 'network-ports', 'time-ntp']))
    expect(ids).not.toContain('hub')
  })
})

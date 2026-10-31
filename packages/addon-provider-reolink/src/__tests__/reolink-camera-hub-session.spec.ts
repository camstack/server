/**
 * D985, the camera's half: a camera adopted from an NVR / Home Hub integration reaches the hub
 * through the per-integration session registry (never through a parent device), tells the
 * session it exists on activation and leaves it on removal. A standalone camera never consults
 * the registry.
 */
import { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'
import { DeviceType } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import { ReolinkCamera } from '../reolink-camera.js'
import { reolinkHubSessions } from '../reolink-hub-session.js'

/** The class prototype is a ReolinkBaichuanApi-typed identity sentinel; nothing calls it. */
const SENTINEL_API: ReolinkBaichuanApi = ReolinkBaichuanApi.prototype

interface Subject {
  readonly id: number
  readonly stableId: string
  readonly name: string
  readonly online: boolean
  readonly config: { get: (key: string) => unknown }
  readonly isHubChild: () => boolean
  readonly hubIntegrationId: () => string | null
  readonly hubSession: () => ReturnType<typeof reolinkHubSessions.get>
  readonly hubChildHandle: unknown
  readonly ensureApi: () => Promise<ReolinkBaichuanApi>
  readonly attachToHubSession: () => void
  readonly detachFromHubSession: () => void
}

function makeSubject(config: Record<string, unknown>): Subject {
  const subject: Subject = {
    id: 21,
    stableId: 'int-1-cam-UID1',
    name: 'Door',
    online: true,
    config: { get: (key) => config[key] },
    isHubChild: ReolinkCamera.prototype['isHubChild'],
    hubIntegrationId: ReolinkCamera.prototype['hubIntegrationId'],
    hubSession: ReolinkCamera.prototype['hubSession'],
    hubChildHandle: ReolinkCamera.prototype['buildHubChildHandle'].call({
      id: 21,
      stableId: 'int-1-cam-UID1',
      name: 'Door',
      online: true,
      config: { get: (key: string) => config[key] },
    }),
    ensureApi: ReolinkCamera.prototype['ensureApi'],
    attachToHubSession: ReolinkCamera.prototype['attachToHubSession'],
    detachFromHubSession: ReolinkCamera.prototype['detachFromHubSession'],
  }
  return subject
}

const CHILD_CONFIG = { integrationId: 'int-1', channel: 2 }

afterEach(() => reolinkHubSessions.clear())

describe('ReolinkCamera under an NVR integration', () => {
  it('is a hub child only with an integration AND a channel', () => {
    expect(makeSubject(CHILD_CONFIG).isHubChild()).toBe(true)
    expect(makeSubject({ channel: 2 }).isHubChild()).toBe(false)
    expect(makeSubject({ integrationId: 'int-1' }).isHubChild()).toBe(false)
  })

  it('borrows the api of ITS integration session', async () => {
    reolinkHubSessions.set('int-1', {
      getApi: async () => SENTINEL_API,
      relayEndpoint: () => ({
        host: 'h',
        username: 'u',
        password: 'p',
        port: 9000,
      }),
    })
    await expect(makeSubject(CHILD_CONFIG).ensureApi()).resolves.toBe(SENTINEL_API)
  })

  it('names the integration when its session is not up yet, and never logs in alone', async () => {
    await expect(makeSubject(CHILD_CONFIG).ensureApi()).rejects.toThrow(/int-1.*no live session/)
  })

  it('attaches to the session on activation and detaches on removal', () => {
    const subject = makeSubject(CHILD_CONFIG)
    subject.attachToHubSession()
    expect(reolinkHubSessions.childrenOf('int-1')).toHaveLength(1)
    const [handle] = reolinkHubSessions.childrenOf('int-1')
    expect(handle?.channel).toBe(2)
    expect(handle?.type).toBe(DeviceType.Camera)
    subject.detachFromHubSession()
    expect(reolinkHubSessions.childrenOf('int-1')).toHaveLength(0)
  })

  it('a standalone camera attaches to nothing', () => {
    makeSubject({ host: '1.2.3.4' }).attachToHubSession()
    expect(reolinkHubSessions.childrenOf('int-1')).toHaveLength(0)
  })
})

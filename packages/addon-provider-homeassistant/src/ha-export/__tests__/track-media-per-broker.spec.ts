/**
 * Two Home Assistant instances, two roles, two media bases: the track image link each broker
 * receives is minted on THAT broker's role (`mediaRole:<id>`), read from the palette on every
 * event (D986 §5). Disarm: mint one shared base again and both brokers carry the same URL.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { HaExportAddon } from '../ha-export.addon.js'
import { mediaRoleKey } from '../media-url.js'

const silent: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
  withTags: () => silent,
}

const TRACK = {
  deviceId: 101,
  trackId: 'T1',
  phase: 'update',
  classes: ['person'],
  bestClassName: 'person',
  lastSeen: 1_770_000_000_000,
}

function harness(
  store: Record<string, unknown>,
  book: { internal: string; publicEndpoint: string },
) {
  const addon = new HaExportAddon()
  const sent: Record<string, string[]> = { 'lan-ha': [], 'remote-ha': [] }
  const link = (id: string) => ({
    client: {
      publishState: (topic: string, value: string) => {
        if (topic.endsWith('/last_image')) sent[id]?.push(value)
      },
    },
  })
  Reflect.set(addon, '_ctx', {
    logger: silent,
    api: {
      localNetwork: {
        getAddresses: {
          query: async () => ({
            roles: {
              internal: { resolved: book.internal },
              publicEndpoint: { resolved: book.publicEndpoint },
            },
          }),
        },
      },
    },
  })
  Reflect.set(addon, 'resolveGlobalStore', async () => store)
  Reflect.set(addon, 'mediaSecret', 'secret')
  Reflect.set(addon, 'keyByDeviceId', new Map([[101, 'camstack-reolink-101']]))
  Reflect.set(
    addon,
    'exported',
    new Map([['camstack-reolink-101', { brokerIds: ['lan-ha', 'remote-ha'] }]]),
  )
  Reflect.set(
    addon,
    'links',
    new Map([
      ['lan-ha', link('lan-ha')],
      ['remote-ha', link('remote-ha')],
    ]),
  )
  const handler: unknown = Reflect.get(addon, 'onTrackLifecycle')
  if (typeof handler !== 'function') throw new Error('no onTrackLifecycle')
  return { sent, fire: async () => void (await handler.call(addon, TRACK)) }
}

describe('HA export — track image link per broker', () => {
  it('mints each broker on its own role', async () => {
    const h = harness(
      { [mediaRoleKey('remote-ha')]: 'publicEndpoint' },
      { internal: 'http://192.0.2.10:4480', publicEndpoint: 'https://cams.example.org' },
    )
    await h.fire()
    expect(h.sent['lan-ha']?.[0]).toMatch(
      /^http:\/\/192\.0\.2\.10:4480\/addon\/homeassistant-export\/ha-media\//,
    )
    expect(h.sent['remote-ha']?.[0]).toMatch(
      /^https:\/\/cams\.example\.org\/addon\/homeassistant-export\/ha-media\//,
    )
  })
})

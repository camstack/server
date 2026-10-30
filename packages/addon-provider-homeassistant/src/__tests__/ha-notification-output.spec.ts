import { type Notification, prepareNotification, type Target } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  buildNotifyServiceData,
  createHaNotificationOutputProvider,
  HA_NOTIFICATION_KIND,
  HaTargetStore,
  homeassistantTargetKind,
  type NotifyServiceData,
  parseNotifyServices,
} from '../ha-notification-output.js'
import { makeHaRecords } from './fake-records.js'

const ADDON_ID = 'provider-homeassistant'
const CAPS = homeassistantTargetKind(ADDON_ID).caps

/** Degrade a canonical notification for the HA kind, then build the payload. */
function build(n: Notification): NotifyServiceData {
  return buildNotifyServiceData(prepareNotification(CAPS, n))
}

function baseNotification(overrides: Partial<Notification> = {}): Notification {
  return { body: 'hello', format: 'text', priority: 3, ...overrides }
}

describe('buildNotifyServiceData', () => {
  it('builds a plain message/title/data payload', () => {
    const sd = build(baseNotification({ title: 'Cam' }))
    expect(sd.message).toBe('hello')
    expect(sd.title).toBe('Cam')
    // default level → Android default importance + iOS active.
    expect(sd.data['importance']).toBe('default')
    expect(sd.data['push']).toEqual({ 'interruption-level': 'active' })
    expect(sd.data['priority']).toBeUndefined()
  })

  it('omits title when absent', () => {
    const sd = build(baseNotification())
    expect(sd.title).toBeUndefined()
  })

  it('maps a first image attachment url into data.image', () => {
    const sd = build(
      baseNotification({
        attachments: [{ mediaType: 'image', url: 'https://x/snap.jpg' }],
      }),
    )
    expect(sd.data['image']).toBe('https://x/snap.jpg')
  })

  it('maps video / audio / icon attachment urls to their data keys', () => {
    expect(
      build(baseNotification({ attachments: [{ mediaType: 'video', url: 'https://x/v.mp4' }] }))
        .data['video'],
    ).toBe('https://x/v.mp4')
    expect(
      build(baseNotification({ attachments: [{ mediaType: 'audio', url: 'https://x/a.mp3' }] }))
        .data['audio'],
    ).toBe('https://x/a.mp3')
    expect(
      build(baseNotification({ attachments: [{ mediaType: 'icon', url: 'https://x/i.png' }] }))
        .data['notification_icon'],
    ).toBe('https://x/i.png')
  })

  it('maps actions to {action,title,uri} with a capped id/label/url', () => {
    const sd = build(
      baseNotification({
        actions: [
          { id: 'ack', label: 'Acknowledge', url: 'https://x/ack' },
          { id: 'view', label: 'View' },
        ],
      }),
    )
    expect(sd.data['actions']).toEqual([
      { action: 'ack', title: 'Acknowledge', uri: 'https://x/ack' },
      { action: 'view', title: 'View' },
    ])
  })

  it('slices actions to caps.actions (3)', () => {
    const actions = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: `A${i}` }))
    const sd = build(baseNotification({ actions }))
    expect((sd.data['actions'] as unknown[]).length).toBe(3)
  })

  it.each([
    { priority: 3 as const, importance: 'default', il: 'active', hasPriority: false },
    { priority: 4 as const, importance: 'high', il: 'time-sensitive', hasPriority: true },
    { priority: 5 as const, importance: 'high', il: 'critical', hasPriority: true },
  ])('priority $priority → importance $importance / interruption-level $il', ({
    priority,
    importance,
    il,
    hasPriority,
  }) => {
    const sd = build(baseNotification({ priority }))
    expect(sd.data['importance']).toBe(importance)
    expect(sd.data['push']).toEqual({ 'interruption-level': il })
    if (hasPriority) expect(sd.data['priority']).toBe('high')
    else expect(sd.data['priority']).toBeUndefined()
  })

  it('resolves the explicit critical level id (flags.critical)', () => {
    const sd = build(baseNotification({ level: 'critical' }))
    expect(sd.data['push']).toEqual({ 'interruption-level': 'critical' })
    expect(sd.data['importance']).toBe('high')
  })

  it('passes tag through', () => {
    const sd = build(baseNotification({ tag: 'motion-42' }))
    expect(sd.data['tag']).toBe('motion-42')
  })

  it('maps clickUrl to both url (iOS) and clickAction (Android)', () => {
    const sd = build(baseNotification({ clickUrl: 'https://x/open' }))
    expect(sd.data['url']).toBe('https://x/open')
    expect(sd.data['clickAction']).toBe('https://x/open')
  })

  it('passes sound and ttl through', () => {
    const sd = build(baseNotification({ sound: 'US-EN-Alexa', ttl: 60 }))
    expect(sd.data['sound']).toBe('US-EN-Alexa')
    expect(sd.data['ttl']).toBe(60)
  })
})

describe('parseNotifyServices', () => {
  it('returns one candidate per notify.* service, mobile_app_* first', () => {
    const result = {
      notify: {
        persistent_notification: {},
        mobile_app_pixel_7: {},
        alexa_media: {},
      },
      light: { turn_on: {} },
    }
    const candidates = parseNotifyServices(result, 'broker-1')
    expect(candidates.map((c) => c.config['service'])).toEqual([
      'mobile_app_pixel_7',
      'alexa_media',
      'persistent_notification',
    ])
    expect(candidates[0]).toEqual({
      kind: HA_NOTIFICATION_KIND,
      suggestedName: 'Mobile App Pixel 7',
      config: { service: 'mobile_app_pixel_7', brokerId: 'broker-1' },
    })
  })

  it('returns [] for a result without a notify domain', () => {
    expect(parseNotifyServices({ light: {} })).toEqual([])
    expect(parseNotifyServices(null)).toEqual([])
    expect(parseNotifyServices(undefined)).toEqual([])
  })

  it('omits brokerId from config when not supplied', () => {
    const candidates = parseNotifyServices({ notify: { mobile_app_x: {} } })
    expect(candidates[0]?.config).toEqual({ service: 'mobile_app_x' })
  })
})

describe('HaTargetStore CRUD round-trip', () => {
  function makeTarget(overrides: Partial<Target> = {}): Target {
    return {
      id: 't1',
      name: 'Phone',
      kind: HA_NOTIFICATION_KIND,
      addonId: ADDON_ID,
      enabled: true,
      config: { service: 'mobile_app_pixel_7' },
      ...overrides,
    }
  }

  it('upserts, reads, updates, toggles, and deletes', async () => {
    const store = HaTargetStore.of((await makeHaRecords()).records)
    await store.upsert(makeTarget())
    expect((await store.list()).length).toBe(1)
    expect((await store.getById('t1'))?.name).toBe('Phone')

    // Update (upsert existing).
    await store.upsert(makeTarget({ name: 'My Phone' }))
    expect((await store.getById('t1'))?.name).toBe('My Phone')
    expect((await store.list()).length).toBe(1)

    // Toggle enabled.
    const toggled = await store.setEnabled('t1', false)
    expect(toggled?.enabled).toBe(false)
    expect((await store.getById('t1'))?.enabled).toBe(false)

    // Delete.
    await store.delete('t1')
    expect(await store.getById('t1')).toBeNull()
    expect((await store.list()).length).toBe(0)
  })

  it('setEnabled on a missing id returns null', async () => {
    const store = HaTargetStore.of((await makeHaRecords()).records)
    expect(await store.setEnabled('nope', true)).toBeNull()
  })
})

describe('createHaNotificationOutputProvider', () => {
  async function harness() {
    const store = HaTargetStore.of((await makeHaRecords()).records)
    const publish = vi.fn(
      async (
        _brokerId: string,
        _service: string,
        _serviceData: NotifyServiceData,
      ): Promise<void> => {},
    )
    const getServices = vi.fn(async () => ({ notify: { mobile_app_x: {} } }))
    const provider = createHaNotificationOutputProvider({
      addonId: ADDON_ID,
      store,
      publish,
      getServices,
      listBrokerIds: () => ['broker-1'],
    })
    return { store, publish, getServices, provider }
  }

  it('lists exactly the homeassistant kind, addonId-stamped', async () => {
    const { provider } = await harness()
    const kinds = await provider.listTargetKinds({})
    expect(kinds.length).toBe(1)
    expect(kinds[0]?.kind).toBe(HA_NOTIFICATION_KIND)
    expect(kinds[0]?.addonId).toBe(ADDON_ID)
  })

  it('send resolves the target, builds notify service_data, and publishes', async () => {
    const { store, publish, provider } = await harness()
    await store.upsert({
      id: 't1',
      name: 'Phone',
      kind: HA_NOTIFICATION_KIND,
      addonId: ADDON_ID,
      enabled: true,
      config: { service: 'mobile_app_pixel_7' },
    })
    const res = await provider.send({
      targetId: 't1',
      notification: { body: 'Motion', title: 'Cam', format: 'text', priority: 5 },
    })
    expect(res.success).toBe(true)
    expect(publish).toHaveBeenCalledTimes(1)
    const [brokerId, service, serviceData] = publish.mock.calls[0]!
    expect(brokerId).toBe('broker-1')
    expect(service).toBe('mobile_app_pixel_7')
    expect(serviceData.message).toBe('Motion')
    expect(serviceData.data['push']).toEqual({ 'interruption-level': 'critical' })
  })

  it('send on an unknown target returns a typed error, never throws', async () => {
    const { provider, publish } = await harness()
    const res = await provider.send({
      targetId: 'ghost',
      notification: { body: 'x', format: 'text', priority: 3 },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('ghost')
    expect(publish).not.toHaveBeenCalled()
  })

  it('send on a disabled target is skipped', async () => {
    const { store, provider, publish } = await harness()
    await store.upsert({
      id: 't2',
      name: 'Off',
      kind: HA_NOTIFICATION_KIND,
      addonId: ADDON_ID,
      enabled: false,
      config: { service: 'mobile_app_x' },
    })
    const res = await provider.send({
      targetId: 't2',
      notification: { body: 'x', format: 'text', priority: 3 },
    })
    expect(res.success).toBe(false)
    expect(publish).not.toHaveBeenCalled()
  })

  it('a publish failure is captured into SendResult.error (never thrown)', async () => {
    const store = HaTargetStore.of((await makeHaRecords()).records)
    const provider = createHaNotificationOutputProvider({
      addonId: ADDON_ID,
      store,
      publish: async () => {
        throw new Error('WS not ready')
      },
      getServices: async () => ({}),
      listBrokerIds: () => ['broker-1'],
    })
    await store.upsert({
      id: 't3',
      name: 'Phone',
      kind: HA_NOTIFICATION_KIND,
      addonId: ADDON_ID,
      enabled: true,
      config: { service: 'mobile_app_x' },
    })
    const res = await provider.send({
      targetId: 't3',
      notification: { body: 'x', format: 'text', priority: 3 },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('WS not ready')
  })

  it('send fails cleanly when no broker is available', async () => {
    const store = HaTargetStore.of((await makeHaRecords()).records)
    const provider = createHaNotificationOutputProvider({
      addonId: ADDON_ID,
      store,
      publish: async () => {},
      getServices: async () => ({}),
      listBrokerIds: () => [],
    })
    await store.upsert({
      id: 't4',
      name: 'Phone',
      kind: HA_NOTIFICATION_KIND,
      addonId: ADDON_ID,
      enabled: true,
      config: { service: 'mobile_app_x' },
    })
    const res = await provider.send({
      targetId: 't4',
      notification: { body: 'x', format: 'text', priority: 3 },
    })
    expect(res.success).toBe(false)
    expect(res.error).toContain('broker')
  })

  it('discoverTargets issues get_services and parses notify.*', async () => {
    const { provider, getServices } = await harness()
    const discovered = await provider.discoverTargets({ kind: HA_NOTIFICATION_KIND })
    expect(getServices).toHaveBeenCalledWith('broker-1')
    expect(discovered.map((d) => d.config['service'])).toEqual(['mobile_app_x'])
    expect(discovered[0]?.config['brokerId']).toBe('broker-1')
  })

  it('discoverTargets returns [] for a foreign kind', async () => {
    const { provider, getServices } = await harness()
    expect(await provider.discoverTargets({ kind: 'ntfy' })).toEqual([])
    expect(getServices).not.toHaveBeenCalled()
  })

  it('upsertTarget forces the homeassistant kind + addonId', async () => {
    const { provider } = await harness()
    const saved = await provider.upsertTarget({
      target: {
        id: 't5',
        name: 'Phone',
        kind: 'wrong',
        addonId: 'someone-else',
        enabled: true,
        config: { service: 'mobile_app_x' },
      },
    })
    expect(saved.kind).toBe(HA_NOTIFICATION_KIND)
    expect(saved.addonId).toBe(ADDON_ID)
  })

  it('getTarget returns the stored target addonId-stamped, and throws on an unknown id', async () => {
    const { store, provider } = await harness()
    await store.upsert({
      id: 't6',
      name: 'Phone',
      kind: HA_NOTIFICATION_KIND,
      addonId: 'stale',
      enabled: true,
      config: { service: 'mobile_app_x' },
    })
    const target = await provider.getTarget({ targetId: 't6' })
    expect(target.config).toEqual({ service: 'mobile_app_x' })
    expect(target.addonId).toBe(ADDON_ID)
    await expect(provider.getTarget({ targetId: 'ghost' })).rejects.toThrow(/ghost/)
  })
})

/**
 * An owner-only event category never leaves the hub through a public router
 * (D224, D663). The native shadow of a claimed cap (`device.native-shadow-changed`)
 * is for the composer alone; every path of `systemEvents.*`, `live.*` and
 * `eventBusProxy.getRecent` — history and live, admin and scoped, per-device —
 * refuses it, and history is filtered BEFORE the limit so a shadow in the
 * window never costs the caller a public slot. (That the public
 * `device.state-changed` payload carries no `native` key is asserted where it
 * is produced: `device-state-mirror-ownership.spec.ts`.)
 *
 * Neutralisation: drop `isPublicEvent` from any one path below and that path's
 * expectation sees the shadow; pass the limit to the bus instead of cutting
 * after the filter and the "N asked is N answered" expectations lose a row.
 */
import type { SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeCtx } from '../../../__tests__/cap-routers/harness.js'
import { trpcRouter } from '../../trpc/trpc.middleware.js'
import { createEventBusProxyRouter } from '../event-bus-proxy.router.js'
import { createLiveEventsRouter } from '../live-events.router.js'
import { createSystemEventsRouter } from '../system-events.router.js'

const SHADOW: SystemEvent = {
  id: 'shadow-1',
  timestamp: new Date('2026-09-27T10:00:00Z'),
  source: { type: 'device', id: 7, deviceId: 7 },
  category: EventCategory.DeviceNativeShadowChanged,
  data: { deviceId: 7, capName: 'battery', native: { percentage: 41 } },
}
const MERGED: SystemEvent = {
  id: 'state-1',
  timestamp: new Date('2026-09-27T10:00:01Z'),
  source: { type: 'device', id: 7, deviceId: 7 },
  category: EventCategory.DeviceStateChanged,
  data: { deviceId: 7, capName: 'battery', slice: { percentage: 90 } },
}
const SHADOW_2: SystemEvent = {
  ...SHADOW,
  id: 'shadow-2',
  timestamp: new Date('2026-09-27T10:00:02Z'),
}
const MERGED_2: SystemEvent = {
  ...MERGED,
  id: 'state-2',
  timestamp: new Date('2026-09-27T10:00:03Z'),
  data: { deviceId: 7, capName: 'battery', slice: { percentage: 91 } },
}
/** Oldest → newest, as the ring answers; two public rows among two shadows. */
const HISTORY: readonly SystemEvent[] = [SHADOW, MERGED, SHADOW_2, MERGED_2]

type Handler = (evt: SystemEvent) => void

/** A bus whose history is `HISTORY`, honouring `limit` the way the ring does (last N), and whose subscribe hands back its handler. */
function fakeBus(): { eb: FakeBus; handlers: Handler[] } {
  const handlers: Handler[] = []
  const eb: FakeBus = {
    getRecent: (_filter?: unknown, limit?: number) =>
      limit !== undefined ? HISTORY.slice(-limit) : [...HISTORY],
    subscribe: (_filter: unknown, handler: Handler) => {
      handlers.push(handler)
      return () => undefined
    },
  }
  return { eb, handlers }
}

interface FakeBus {
  getRecent: (filter?: unknown, limit?: number) => SystemEvent[]
  subscribe: (filter: unknown, handler: Handler) => () => void
}
const PUBLIC_IDS = ['state-1', 'state-2']

/** Fake → service boundary: the routers take the concrete `EventBusService`. */
const asService = (eb: FakeBus): Parameters<typeof createSystemEventsRouter>[0] =>
  eb as unknown as Parameters<typeof createSystemEventsRouter>[0]
const fakeRegistry = (): Parameters<typeof createLiveEventsRouter>[1] =>
  ({
    getDeviceRegistry: () => ({
      getById: () => ({ id: 7, stableId: 'cam-7' }),
      getAddonId: () => 'provider-x',
    }),
  }) as unknown as Parameters<typeof createLiveEventsRouter>[1]

/** Push the shadow, then the public event; the first item a subscriber yields must be the public one. */
async function firstAfterBoth(iter: AsyncIterable<unknown>, handlers: Handler[]): Promise<unknown> {
  const iterator = iter[Symbol.asyncIterator]()
  const next = iterator.next()
  // The subscription registers its handler on the first pull.
  await Promise.resolve()
  expect(handlers).toHaveLength(1)
  handlers[0]!(SHADOW)
  handlers[0]!(MERGED)
  const first = await next
  await iterator.return?.(undefined)
  return first.value
}

describe('owner-only categories never leave the hub (D224)', () => {
  it('systemEvents.getRecent — admin history omits the shadow', async () => {
    const { eb } = fakeBus()
    const out = (await createSystemEventsRouter(asService(eb))
      .createCaller(makeCtx('admin'))
      .getRecent({})) as { id: string }[]
    expect(out.map((e) => e.id)).toEqual(PUBLIC_IDS)
  })

  it('systemEvents.getRecent — N asked is N PUBLIC rows answered (filter before limit)', async () => {
    const { eb } = fakeBus()
    const out = (await createSystemEventsRouter(asService(eb))
      .createCaller(makeCtx('admin'))
      .getRecent({ limit: 2 })) as { id: string }[]
    expect(out.map((e) => e.id)).toEqual(PUBLIC_IDS)
  })

  it('systemEvents.subscribe — the live stream drops the shadow before the merged event', async () => {
    const { eb, handlers } = fakeBus()
    const iter = await createSystemEventsRouter(asService(eb))
      .createCaller(makeCtx('admin'))
      .subscribe({})
    const first = (await firstAfterBoth(iter, handlers)) as { category: string; data: unknown }
    expect(first.category).toBe(EventCategory.DeviceStateChanged)
    expect(first.data).not.toHaveProperty('native')
  })

  it('live.recentSystemEvents — admin history omits the shadow, and N asked is N public rows', async () => {
    const { eb } = fakeBus()
    const router = createLiveEventsRouter(asService(eb), fakeRegistry())
    const all = (await router
      .createCaller(makeCtx('admin'))
      .recentSystemEvents({})) as SystemEvent[]
    expect(all.map((e) => e.id)).toEqual(PUBLIC_IDS)
    const two = (await router
      .createCaller(makeCtx('admin'))
      .recentSystemEvents({ limit: 2 })) as SystemEvent[]
    expect(two.map((e) => e.id)).toEqual(PUBLIC_IDS)
  })

  it('eventBusProxy.getRecent — the worker-history proxy on the public app router omits the shadow, N asked is N public rows, and a device-scoped token reads only its devices', async () => {
    const { eb } = fakeBus()
    const router = createEventBusProxyRouter(asService(eb))
    const all = (await router.createCaller(makeCtx('admin')).getRecent({})) as { id: string }[]
    expect(all.map((e) => e.id)).toEqual(PUBLIC_IDS)
    const two = (await router.createCaller(makeCtx('admin')).getRecent({ limit: 2 })) as {
      id: string
    }[]
    expect(two.map((e) => e.id)).toEqual(PUBLIC_IDS)
    const other = makeCtx('user', {
      scopes: [{ type: 'device', selector: { kind: 'ids', ids: [9] }, access: ['view'] }],
    })
    expect(await router.createCaller(other).getRecent({})).toEqual([])
    const mine = makeCtx('user', {
      scopes: [{ type: 'device', selector: { kind: 'ids', ids: [7] }, access: ['view'] }],
    })
    const scoped = (await router.createCaller(mine).getRecent({})) as { id: string }[]
    expect(scoped.map((e) => e.id)).toEqual(PUBLIC_IDS)
  })

  it('live.onEvent — admin (unfiltered branch) drops the shadow', async () => {
    const { eb, handlers } = fakeBus()
    const iter = await createLiveEventsRouter(asService(eb), fakeRegistry())
      .createCaller(makeCtx('admin'))
      .onEvent({})
    const first = (await firstAfterBoth(iter, handlers)) as SystemEvent
    expect(first.category).toBe(EventCategory.DeviceStateChanged)
  })

  it('live.onEvent — a device-scoped token (scopedKeep branch) drops the shadow for a device it MAY view', async () => {
    const { eb, handlers } = fakeBus()
    const ctx = makeCtx('user', {
      scopes: [{ type: 'device', selector: { kind: 'ids', ids: [7] }, access: ['view'] }],
    })
    const iter = await createLiveEventsRouter(asService(eb), fakeRegistry())
      .createCaller(ctx)
      .onEvent({})
    const first = (await firstAfterBoth(iter, handlers)) as SystemEvent
    expect(first.category).toBe(EventCategory.DeviceStateChanged)
  })

  it('live.onEvent — a share-view principal (shareScope branch) drops the shadow for an in-scope device', async () => {
    const { eb, handlers } = fakeBus()
    const ctx = makeCtx('user', {
      scopes: [{ type: 'share-view', grant: { kind: 'grid-view', deviceIds: [7] } }],
    })
    // A share-view token passes the allowlist by FULL path (`live.onEvent`), so
    // the router is mounted where the app mounts it.
    const app = trpcRouter({ live: createLiveEventsRouter(asService(eb), fakeRegistry()) })
    const iter = await app.createCaller(ctx).live.onEvent({})
    const first = (await firstAfterBoth(iter, handlers)) as SystemEvent
    expect(first.category).toBe(EventCategory.DeviceStateChanged)
  })

  it('live.onDeviceEvent — the per-device stream drops the shadow', async () => {
    const { eb, handlers } = fakeBus()
    const iter = await createLiveEventsRouter(asService(eb), fakeRegistry())
      .createCaller(makeCtx('admin'))
      .onDeviceEvent({ deviceId: 7 })
    const first = (await firstAfterBoth(iter, handlers)) as SystemEvent
    expect(first.category).toBe(EventCategory.DeviceStateChanged)
  })
})

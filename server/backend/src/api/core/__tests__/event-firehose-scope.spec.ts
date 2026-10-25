/* eslint-disable @typescript-eslint/no-explicit-any -- mock EventBusService crosses a typed boundary */
/**
 * F0.5 — the event firehose is device-projected for scoped tokens.
 *
 * Before this gate, a `device:[5]` scoped token calling `live.recentSystemEvents`
 * / `systemEvents.getRecent` received EVERY camera's motion & detection history.
 * A device-restricted token now sees only events for devices it may view; an
 * admin and a broad `category`-view operator are unfiltered.
 *
 * Neutralisation: drop the `scopedEventVisibility` filter in either router and
 * the "device:[5] sees only device 5" expectation flips to seeing both.
 */
import type { SystemEvent } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { createLiveEventsRouter } from '../live-events.router.js'
import { createSystemEventsRouter } from '../system-events.router.js'
import { makeCtx } from '../../../__tests__/cap-routers/harness.js'

const ev = (deviceId: number): SystemEvent =>
  ({
    id: `e-${deviceId}`,
    timestamp: new Date('2026-08-13T10:00:00Z'),
    source: { type: 'device', id: deviceId },
    category: 'provider.motion',
    data: {},
  }) as SystemEvent

const RECENT: readonly SystemEvent[] = [ev(5), ev(7)]

const eb = { getRecent: () => [...RECENT] } as any
const ar = {} as any

const deviceScopedCtx = (ids: number[]) =>
  makeCtx('user', {
    scopes: [{ type: 'device', selector: { kind: 'ids', ids }, access: ['view'] }],
  })
const categoryViewCtx = () =>
  makeCtx('user', { scopes: [{ type: 'category', target: 'device', access: ['view'] }] })

describe('live.recentSystemEvents — device projection (F0.5)', () => {
  const router = createLiveEventsRouter(eb, ar)

  it('a device:[5] token sees only device-5 events', async () => {
    const out = (await router
      .createCaller(deviceScopedCtx([5]))
      .recentSystemEvents({})) as SystemEvent[]
    expect(out.map((e) => e.source.id)).toEqual([5])
  })

  it('an admin sees every device', async () => {
    const out = (await router
      .createCaller(makeCtx('admin'))
      .recentSystemEvents({})) as SystemEvent[]
    expect(out.map((e) => e.source.id)).toEqual([5, 7])
  })

  it('a broad category:device view operator sees every device', async () => {
    const out = (await router
      .createCaller(categoryViewCtx())
      .recentSystemEvents({})) as SystemEvent[]
    expect(out.map((e) => e.source.id)).toEqual([5, 7])
  })
})

describe('systemEvents.getRecent — device projection (F0.5)', () => {
  const router = createSystemEventsRouter(eb)

  it('a device:[7] token sees only device-7 events', async () => {
    const out = (await router.createCaller(deviceScopedCtx([7])).getRecent({})) as {
      source: { id: number }
    }[]
    expect(out.map((e) => e.source.id)).toEqual([7])
  })

  it('an admin sees every device', async () => {
    const out = (await router.createCaller(makeCtx('admin')).getRecent({})) as {
      source: { id: number }
    }[]
    expect(out.map((e) => e.source.id)).toEqual([5, 7])
  })
})

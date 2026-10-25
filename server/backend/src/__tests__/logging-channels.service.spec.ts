/**
 * The per-component layer and the per-camera scope, at the service that owns
 * the document.
 *
 * Three things are load-bearing here and each is neutralisation-checked:
 *
 *  - **`component` resolves.** It was declared-and-dark in the first slice.
 *    A layer that appears in a schema and is never returned is the shape of a
 *    knob that does nothing (D62), so the point of this slice is that it now
 *    RESOLVES and that `explicit` still says which layer decided.
 *  - **The per-camera scope survives the round trip.** A window armed for 102
 *    comes back saying 102 and reaches the gate saying 102. This is only
 *    possible because every line about a device carries `tags: { deviceId }`
 *    numerically — the repo rule paid for with a 22% thumbnail gap and a
 *    3-hour blackout diagnosed by hand.
 *  - **A channel that is NOT per-device refuses narrowing.** Silently widening
 *    to "every camera" would teach the operator that per-camera filtering
 *    works where it cannot, and they would blame the wrong camera for the
 *    first unrelated line they saw.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogChannelDescriptor, LogChannelWindow } from '@camstack/types'
import { LoggingGate } from '@camstack/system'
import {
  buildLogChannelPlane,
  describeChannelWindows,
  liveChannelWindows,
  LoggingSettingsService,
  mergeChannelWindows,
  mergeLevel,
  resolveLevel,
  validateChannelPatch,
  type LogChannelPlane,
  type LoggingSettingsRecord,
} from '../api/core/logging-settings.js'
import type { RequestCensusService } from '../api/core/request-census-settings.js'
import type { SettingsStoreGateway } from '../api/core/site-location.js'

const WEBRTC: LogChannelDescriptor = {
  name: 'stream-broker.webrtc',
  description: 'x',
  defaultLevel: 'info',
  perDevice: true,
}

const RTP: LogChannelDescriptor = {
  name: 'stream-broker.rtp',
  description: 'y',
  defaultLevel: 'info',
  perDevice: false,
}

const NOW = 1_000_000

/** A store that keeps one row in memory, so a write is readable back. */
function memoryStore(): { store: SettingsStoreGateway; rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>()
  const store: SettingsStoreGateway = {
    get: async ({ key }) => rows.get(key) ?? null,
    set: async ({ key, value }) => {
      rows.set(key, value)
    },
  }
  return { store, rows }
}

function stubCensus(): RequestCensusService {
  const status = {
    armed: false,
    armedUntilMs: 0,
    elapsedMs: 0,
    windowMs: 0,
    httpRequests: 0,
    batchedRequests: 0,
    procedureCalls: 0,
    subscriptions: 0,
    planes: { http: 0, ws: 0, mesh: 0, unknown: 0 },
    planesExplainTotal: true,
    groups: [],
    procedures: [],
    persisted: true,
  }
  const service = {
    status: async () => status,
    set: async () => status,
    restore: async () => {},
  }
  return service as unknown as RequestCensusService
}

function makeService(
  channels: LogChannelPlane,
  store: SettingsStoreGateway,
): LoggingSettingsService {
  return new LoggingSettingsService({
    store,
    gate: new LoggingGate(),
    requestCensus: stubCensus(),
    channels,
    now: () => NOW,
  })
}

describe('the component layer resolves', () => {
  /**
   * Neutralisation: drop the `componentLevel` branch from `resolveLevel` and
   * this fails with `node`. Confirmed 2026-08-27.
   */
  it('a component level wins over the node and the cluster', () => {
    const record: LoggingSettingsRecord = {
      clusterLevel: 'info',
      nodeLevels: { hub: 'warn' },
      componentLevels: { 'stream-broker.webrtc': 'error' },
    }

    expect(resolveLevel(record, 'hub', 'stream-broker.webrtc')).toEqual({
      level: 'error',
      source: 'component',
    })
    // Without the component selector, the node still wins — the layer is
    // addressed, never applied globally by accident.
    expect(resolveLevel(record, 'hub', null)).toEqual({ level: 'warn', source: 'node' })
  })

  it('a component with NO explicit value inherits, and says so', () => {
    const record: LoggingSettingsRecord = { clusterLevel: 'info' }

    expect(resolveLevel(record, 'hub', 'stream-broker.webrtc')).toEqual({
      level: 'info',
      source: 'cluster',
    })
  })

  /**
   * The distinction the Levels page exists for: a row must never show a value
   * that could be either "set here" or "inherited".
   *
   * Neutralisation: make `describeLayers` fall back to the resolved level
   * instead of `null` and this fails. Confirmed 2026-08-27.
   */
  it('reports the component layer as SET or INHERITING, never as a resolved number', () => {
    const service = makeService(
      { declarations: async () => [WEBRTC], apply: async () => {} },
      memoryStore().store,
    )

    return service
      .set({ level: 'error' }, 'hub', 'stream-broker.webrtc')
      .then(async () => service.get('hub', 'stream-broker.webrtc'))
      .then((state) => {
        expect(state.scopeComponent).toBe('stream-broker.webrtc')
        expect(state.effective).toEqual({ level: 'error', levelSource: 'component' })
        expect(state.explicit.layers).toEqual([
          { scope: 'cluster', nodeId: null, component: null, level: null },
          { scope: 'node', nodeId: 'hub', component: null, level: null },
          {
            scope: 'component',
            nodeId: null,
            component: 'stream-broker.webrtc',
            level: 'error',
          },
        ])
      })
  })

  it('clearing a component level makes it inherit again', () => {
    const withLevel = mergeLevel({}, 'hub', 'stream-broker.webrtc', 'error', NOW)
    const cleared = mergeLevel(withLevel, 'hub', 'stream-broker.webrtc', null, NOW)

    expect(resolveLevel(cleared, 'hub', 'stream-broker.webrtc').source).toBe('default')
  })

  it('a component write never touches the node or cluster levels', () => {
    const record: LoggingSettingsRecord = { clusterLevel: 'info', nodeLevels: { hub: 'warn' } }
    const next = mergeLevel(record, 'hub', 'stream-broker.webrtc', 'error', NOW)

    expect(next.clusterLevel).toBe('info')
    expect(next.nodeLevels).toEqual({ hub: 'warn' })
  })
})

describe('the per-camera scope of a channel window', () => {
  /**
   * Neutralisation: make `mergeChannelWindows` store `deviceIds: null`
   * unconditionally and both the round-trip and the push-to-gate assertions
   * fail. Confirmed 2026-08-27.
   */
  it('arms one camera and reaches the gate saying that camera', async () => {
    const pushed: LogChannelWindow[][] = []
    const { store } = memoryStore()
    const service = makeService(
      {
        declarations: async () => [WEBRTC, RTP],
        apply: async (windows) => {
          pushed.push([...windows])
        },
      },
      store,
    )

    const state = await service.set({
      channels: [{ channel: WEBRTC.name, armMs: 120_000, deviceIds: [102] }],
    })

    expect(state.activeChannels).toEqual([
      {
        channel: WEBRTC.name,
        armed: true,
        armedUntilMs: NOW + 120_000,
        remainingMs: 120_000,
        deviceIds: [102],
      },
    ])
    expect(pushed.at(-1)).toEqual([
      { channel: WEBRTC.name, armedUntilMs: NOW + 120_000, deviceIds: [102] },
    ])
  })

  /**
   * The corollary the plan insists be explicit: a channel whose lines carry no
   * `tags: { deviceId }` is not filterable per camera, and saying otherwise is
   * a lie the UI would repeat.
   *
   * Neutralisation: delete the `!descriptor.perDevice` branch from
   * `validateChannelPatch` and this stops throwing. Confirmed 2026-08-27.
   */
  it('REFUSES narrowing a channel declared perDevice: false', async () => {
    const apply = vi.fn(async () => {})
    const service = makeService(
      { declarations: async () => [WEBRTC, RTP], apply },
      memoryStore().store,
    )

    await expect(
      service.set({ channels: [{ channel: RTP.name, armMs: 120_000, deviceIds: [102] }] }),
    ).rejects.toThrow(/perDevice: false/)
    // Refused WHOLE: nothing was armed, so no push went out.
    expect(apply).not.toHaveBeenCalled()
  })

  it('accepts the same channel armed for EVERY camera', async () => {
    const service = makeService(
      { declarations: async () => [WEBRTC, RTP], apply: async () => {} },
      memoryStore().store,
    )

    const state = await service.set({ channels: [{ channel: RTP.name, armMs: 60_000 }] })

    expect(state.activeChannels[0]).toMatchObject({ channel: RTP.name, deviceIds: null })
  })

  it('REFUSES an undeclared channel instead of arming a typo', () => {
    const reasons = validateChannelPatch([{ channel: 'stream-broker.webrtx', armMs: 1 }], [WEBRTC])

    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('stream-broker.webrtx')
    // Names the real ones, so the typo is diagnosable rather than merely denied.
    expect(reasons[0]).toContain('stream-broker.webrtc')
  })

  it('refuses the WHOLE patch when one entry is bad — never a partial arm', () => {
    const reasons = validateChannelPatch(
      [
        { channel: WEBRTC.name, armMs: 60_000, deviceIds: [102] },
        { channel: 'nope.thing', armMs: 60_000 },
      ],
      [WEBRTC],
    )

    expect(reasons).toHaveLength(1)
  })
})

describe('a channel window is a deadline, not a flag', () => {
  it('an expired window is neither reported armed nor pushed to a gate', () => {
    const record = mergeChannelWindows({}, [{ channel: WEBRTC.name, armMs: 1_000 }], NOW)

    expect(liveChannelWindows(record, NOW + 2_000)).toEqual([])
    expect(describeChannelWindows(record, NOW + 2_000)).toEqual([
      { channel: WEBRTC.name, armed: false, armedUntilMs: 0, remainingMs: 0, deviceIds: null },
    ])
  })

  it('clamps an absurd window rather than trusting it', () => {
    const record = mergeChannelWindows({}, [{ channel: WEBRTC.name, armMs: 99 * 60_000 }], NOW)

    expect(record.channelWindows?.[WEBRTC.name]?.armedUntilMs).toBe(NOW + 30 * 60_000)
  })

  it('armMs 0 disarms, and leaves every other channel alone', () => {
    const armed = mergeChannelWindows(
      {},
      [
        { channel: WEBRTC.name, armMs: 60_000 },
        { channel: RTP.name, armMs: 60_000 },
      ],
      NOW,
    )
    const next = mergeChannelWindows(armed, [{ channel: WEBRTC.name, armMs: 0 }], NOW)

    expect(Object.keys(next.channelWindows ?? {})).toEqual([RTP.name])
  })

  it('restore pushes the REMAINDER and drops what expired', async () => {
    const pushed: LogChannelWindow[][] = []
    const { store, rows } = memoryStore()
    rows.set('logging-settings', {
      channelWindows: {
        [WEBRTC.name]: { armedUntilMs: NOW + 60_000, deviceIds: [102] },
        [RTP.name]: { armedUntilMs: NOW - 1, deviceIds: null },
      },
    })

    await makeService(
      {
        declarations: async () => [WEBRTC, RTP],
        apply: async (windows) => {
          pushed.push([...windows])
        },
      },
      store,
    ).restore()

    expect(pushed.at(-1)).toEqual([
      { channel: WEBRTC.name, armedUntilMs: NOW + 60_000, deviceIds: [102] },
    ])
  })
})

describe('a failed read changes nothing (D49)', () => {
  let throwing: SettingsStoreGateway

  beforeEach(() => {
    throwing = {
      get: async () => {
        throw new Error('store down')
      },
      set: async () => {
        throw new Error('store down')
      },
    }
  })

  it('never pushes an empty armed set just because the store could not be read', async () => {
    const apply = vi.fn(async () => {})
    await makeService({ declarations: async () => [WEBRTC], apply }, throwing).restore()

    // A read that fails is "unknown", never "disarm everything": the gates keep
    // whatever mirror they have. A doorbell in this repo rang 0/3 because one
    // bad read looked exactly like a real off.
    expect(apply).not.toHaveBeenCalled()
  })

  it('reports the channel roster as EMPTY when the plane throws, and does not crash the read', async () => {
    const state = await makeService(
      {
        declarations: async () => {
          throw new Error('runner offline')
        },
        apply: async () => {},
      },
      memoryStore().store,
    ).get()

    expect(state.channels).toEqual([])
  })
})

describe('the plane over the capability registry', () => {
  it('keeps going when ONE provider fails, and names the one that did', async () => {
    const errors: string[] = []
    const plane = buildLogChannelPlane(
      {
        entries: () => [
          [
            'broken',
            {
              list: async () => {
                throw new Error('runner gone')
              },
              apply: async () => ({ armed: 0, unknown: [] }),
            },
          ],
          [
            'stream-broker',
            {
              list: async () => [WEBRTC],
              apply: async () => ({ armed: 1, unknown: [] }),
            },
          ],
        ],
      },
      (addonId, phase) => {
        errors.push(`${addonId}:${phase}`)
      },
    )

    expect(await plane.declarations()).toEqual([WEBRTC])
    expect(errors).toEqual(['broken:list'])
  })

  it('dedupes a name two providers both claim rather than showing two rows', async () => {
    const plane = buildLogChannelPlane({
      entries: () => [
        ['a', { list: async () => [WEBRTC], apply: async () => ({ armed: 0, unknown: [] }) }],
        ['b', { list: async () => [WEBRTC], apply: async () => ({ armed: 0, unknown: [] }) }],
      ],
    })

    expect(await plane.declarations()).toHaveLength(1)
  })
})

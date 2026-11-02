/**
 * The hub's debug watch: held in memory, pushed to every node as ONE full set
 * with the document's own windows, refused when it names nothing real.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEBUG_WATCH_WINDOW_MS,
  __resetDebugInterestForTests,
  getDebugInterest,
  type LogChannelDescriptor,
  type LogChannelWindow,
} from '@camstack/types'
import { LoggingGate } from '@camstack/server/system'
import { LoggingSettingsService, type LogChannelPlane } from '../api/core/logging-settings.js'
import type { RequestCensusService } from '../api/core/request-census-settings.js'
import type { SettingsStoreGateway } from '../api/core/site-location.js'

const PTZ: LogChannelDescriptor = {
  name: 'debug.ptz',
  description: 'ptz dump',
  defaultLevel: 'info',
  perDevice: true,
  kind: 'debug',
}
const RTP: LogChannelDescriptor = {
  name: 'stream-broker.rtp',
  description: 'rtp',
  defaultLevel: 'info',
  perDevice: false,
  kind: 'diagnostic',
}

const census = {
  status: async () => ({ armed: false, armedUntilMs: 0, persisted: true }),
  set: async () => ({}),
  restore: async () => {},
}

function setup(): {
  service: LoggingSettingsService
  pushes: (readonly LogChannelWindow[])[]
  clock: { now: number }
} {
  const rows = new Map<string, unknown>()
  const store: SettingsStoreGateway = {
    get: async ({ key }) => rows.get(key) ?? null,
    set: async ({ key, value }) => {
      rows.set(key, value)
    },
  }
  const pushes: (readonly LogChannelWindow[])[] = []
  // Stands for the remote nodes: whatever the plane is handed is what every
  // node's `log-channels` provider receives.
  const channels: LogChannelPlane = {
    declarations: async () => [PTZ, RTP],
    apply: async (windows) => {
      pushes.push(windows)
    },
  }
  const clock = { now: 1_000_000 }
  const service = new LoggingSettingsService({
    store,
    gate: new LoggingGate(),
    requestCensus: Object.assign(Object.create(null), census) as RequestCensusService,
    channels,
    now: () => clock.now,
  })
  return { service, pushes, clock }
}

afterEach(() => {
  __resetDebugInterestForTests()
})

describe('debugWatch', () => {
  it('pushes the interest to every node and the hub mirror', async () => {
    const { service, pushes } = setup()
    await service.debugWatch({ action: 'start', channels: ['debug.ptz'], deviceIds: [7] })
    expect(pushes.at(-1)).toEqual([
      { channel: 'debug.ptz', armedUntilMs: 1_000_000 + DEBUG_WATCH_WINDOW_MS, deviceIds: [7] },
    ])
    expect(getDebugInterest().wants('debug.ptz', 7)).toBe(true)
    expect(getDebugInterest().wants('debug.ptz', 8)).toBe(false)
  })

  it('refuses an undeclared or non-debug channel, and a start with no device', async () => {
    const { service, pushes } = setup()
    await expect(
      service.debugWatch({ action: 'start', channels: ['debug.nope'], deviceIds: [7] }),
    ).rejects.toThrow(/not a declared debug channel/)
    await expect(
      service.debugWatch({ action: 'start', channels: ['stream-broker.rtp'], deviceIds: [7] }),
    ).rejects.toThrow(/not a declared debug channel/)
    await expect(
      service.debugWatch({ action: 'start', channels: ['debug.ptz'], deviceIds: [] }),
    ).rejects.toThrow(/at least one device/)
    expect(pushes).toHaveLength(0)
  })

  it('a re-arm extends, a lapse drops the interest, and a lapsed one is not revived', async () => {
    const { service, pushes, clock } = setup()
    await service.debugWatch({ action: 'start', channels: ['debug.ptz'], deviceIds: [7] })
    clock.now += 4 * 60_000
    const rearmed = await service.debugWatch({
      action: 'rearm',
      channels: ['debug.ptz'],
      deviceIds: [],
    })
    expect(rearmed.watches[0]?.untilMs).toBe(clock.now + DEBUG_WATCH_WINDOW_MS)
    clock.now += DEBUG_WATCH_WINDOW_MS
    const after = await service.debugWatch({
      action: 'rearm',
      channels: ['debug.ptz'],
      deviceIds: [],
    })
    expect(after.lapsed).toEqual(['debug.ptz'])
    expect(after.watches).toHaveLength(0)
    expect(pushes.at(-1)).toEqual([])
    expect(getDebugInterest().wants('debug.ptz', 7)).toBe(false)
  })

  it('a debug channel cannot be armed through the document, which would skip the cap', async () => {
    const { service, pushes } = setup()
    await expect(
      service.set({ channels: [{ channel: 'debug.ptz', armMs: 600_000 }] }),
    ).rejects.toThrow(/debug channel/)
    expect(pushes).toHaveLength(0)
  })

  it('a stop closes it at once', async () => {
    const { service, pushes } = setup()
    await service.debugWatch({ action: 'start', channels: ['debug.ptz'], deviceIds: [7] })
    await service.debugWatch({ action: 'stop', channels: ['debug.ptz'], deviceIds: [] })
    expect(pushes.at(-1)).toEqual([])
  })

  it('a document write does not disarm a live watch', async () => {
    const { service, pushes } = setup()
    await service.debugWatch({ action: 'start', channels: ['debug.ptz'], deviceIds: [7] })
    await service.set({ channels: [{ channel: 'stream-broker.rtp', armMs: 60_000 }] })
    const last = pushes.at(-1) ?? []
    expect(last.map((w) => w.channel).sort()).toEqual(['debug.ptz', 'stream-broker.rtp'])
  })
})

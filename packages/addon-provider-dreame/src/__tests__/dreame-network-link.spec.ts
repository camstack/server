import { describe, expect, it } from 'vitest'
import { networkLinkFromBars } from '../devices/dreame-network-link.js'

describe('networkLinkFromBars', () => {
  it('bars 1..4 are a wifi link at 25..100 %', () => {
    expect(networkLinkFromBars(4, 10)).toEqual({
      type: 'wifi',
      signal: 100,
      lastUpdated: 10,
    })
    expect(networkLinkFromBars(1, 10)).toEqual({ type: 'wifi', signal: 25, lastUpdated: 10 })
  })

  it('0 (unreached) is wifi with an unknown strength, never 0 %', () => {
    expect(networkLinkFromBars(0, 10)).toEqual({
      type: 'wifi',
      signal: null,
      lastUpdated: 10,
    })
  })

  it('null teaches nothing — the previous slice stays', () => {
    expect(networkLinkFromBars(null, 10)).toBeNull()
  })
})

import { NETWORK_LINK_UNKNOWN } from '@camstack/types'
import { DreameNetworkLinkMonitor, NETWORK_LINK_CAP_NAME } from '../devices/dreame-network-link.js'

function fakeStore() {
  const map = new Map<string, unknown>()
  return {
    map,
    getCapState<T>(cap: string): T | null {
      return (map.get(cap) as T | undefined) ?? null
    },
    setCapState(cap: string, value: unknown) {
      map.set(cap, value)
    },
  }
}

function fakeLogger() {
  const lines: string[] = []
  const log = (level: string) => (message: string) => {
    lines.push(`${level}:${message}`)
  }
  // The full IScopedLogger surface: the monitor takes the shared type now, not
  // a bespoke three-method one (the repo forbids re-declaring it).
  const self = {
    lines,
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: () => self,
    withTags: () => self,
  }
  return self
}

describe('DreameNetworkLinkMonitor — one reader for every device of the robot', () => {
  it('answers unknown before a read and the bars after one', async () => {
    const store = fakeStore()
    const m = new DreameNetworkLinkMonitor({
      deviceId: 4374,
      logger: fakeLogger(),
      runtimeState: store,
      readBars: async () => 3,
      now: () => 99,
    })
    m.seed()
    expect(await m.provider().getStatus()).toEqual(NETWORK_LINK_UNKNOWN)
    await m.refresh('activate')
    expect(store.getCapState(NETWORK_LINK_CAP_NAME)).toEqual({
      type: 'wifi',
      signal: 75,
      lastUpdated: 99,
    })
  })

  it('keeps the last slice on a failed read, warns once, then debugs', async () => {
    const store = fakeStore()
    const logger = fakeLogger()
    let fail = false
    const m = new DreameNetworkLinkMonitor({
      deviceId: 4374,
      logger,
      runtimeState: store,
      readBars: async () => {
        if (fail) throw new Error('cloud down')
        return 2
      },
      now: () => 1,
    })
    await m.refresh('activate')
    fail = true
    await m.refresh('periodic')
    await m.refresh('periodic')
    expect(store.getCapState(NETWORK_LINK_CAP_NAME)).toEqual({
      type: 'wifi',
      signal: 50,
      lastUpdated: 1,
    })
    expect(logger.lines.filter((l) => l.startsWith('warn:'))).toHaveLength(1)
    expect(logger.lines.filter((l) => l.startsWith('debug:network link read failed'))).toHaveLength(
      1,
    )
  })

  it('does nothing while the robot has no handle', async () => {
    const store = fakeStore()
    const m = new DreameNetworkLinkMonitor({
      deviceId: 1,
      logger: fakeLogger(),
      runtimeState: store,
      readBars: () => null,
    })
    await m.refresh('activate')
    expect(store.map.size).toBe(0)
  })
})

import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  UNSUPPORTED_ADDON_SETTLE_MS,
  UnsupportedAddonTracker,
  type UnsupportedAddonFacts,
} from '../unsupported-addon-tracker.js'

interface Captured {
  readonly category: string
  readonly data: Record<string, unknown>
}

function harness(settleMs = 0) {
  const events: Captured[] = []
  const now = 1_000
  const tracker = new UnsupportedAddonTracker({
    eventBus: {
      emit: (e) => {
        events.push({ category: e.category, data: e.data })
      },
    },
    nodeId: 'hub',
    log: () => undefined,
    settleMs,
    now: () => now,
  })
  return { tracker, events }
}

const OLD: UnsupportedAddonFacts = {
  packageName: '@camstack/addon-ml',
  addonId: 'ml',
  installedVersion: '1.0.0',
  serverVersion: '1.2.721',
  requiredMinimum: '2.0.0',
  unmet: ['requires @camstack/addon-ml >= 2.0.0, installed 1.0.0'],
}

describe('UnsupportedAddonTracker', () => {
  it('raises once with both versions, however often the gate re-judges the same facts', () => {
    const { tracker, events } = harness()
    tracker.observe([OLD.packageName], [OLD])
    tracker.observe([OLD.packageName], [OLD])
    tracker.observe([OLD.packageName], [OLD])
    expect(events).toHaveLength(1)
    expect(events[0]?.category).toBe(EventCategory.AddonUnsupportedVersion)
    expect(events[0]?.data).toMatchObject({
      packageName: '@camstack/addon-ml',
      addonId: 'ml',
      nodeId: 'hub',
      installedVersion: '1.0.0',
      requiredMinimum: '2.0.0',
      serverVersion: '1.2.721',
    })
  })

  it('emits the resolve edge when the package is judged supported, and never again', () => {
    const { tracker, events } = harness()
    tracker.observe([OLD.packageName], [OLD])
    tracker.observe([OLD.packageName], [])
    tracker.observe([OLD.packageName], [])
    expect(events.map((e) => e.category)).toEqual([
      EventCategory.AddonUnsupportedVersion,
      EventCategory.AddonUnsupportedResolved,
    ])
    expect(events[1]?.data).toMatchObject({ packageName: '@camstack/addon-ml', nodeId: 'hub' })
  })

  it('a package this run did not judge keeps its streak', () => {
    const { tracker, events } = harness()
    tracker.observe([OLD.packageName], [OLD])
    tracker.observe(['@camstack/addon-other'], [])
    expect(events.map((e) => e.category)).toEqual([EventCategory.AddonUnsupportedVersion])
  })

  it('an update that is still below the minimum raises a new streak with the new installed version', () => {
    const { tracker, events } = harness()
    tracker.observe([OLD.packageName], [OLD])
    tracker.observe([OLD.packageName], [{ ...OLD, installedVersion: '1.5.0' }])
    expect(events.map((e) => e.data['installedVersion'])).toEqual(['1.0.0', '1.5.0'])
  })

  it('holds the alert through the settle window, then emits it once', () => {
    vi.useFakeTimers()
    try {
      const events: Captured[] = []
      const tracker = new UnsupportedAddonTracker({
        eventBus: { emit: (e) => void events.push({ category: e.category, data: e.data }) },
        nodeId: 'hub',
        log: () => undefined,
      })
      tracker.observe([OLD.packageName], [OLD])
      expect(events).toEqual([])
      vi.advanceTimersByTime(UNSUPPORTED_ADDON_SETTLE_MS - 1)
      expect(events).toEqual([])
      vi.advanceTimersByTime(1)
      expect(events.map((e) => e.category)).toEqual([EventCategory.AddonUnsupportedVersion])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a fix inside the settle window raises nothing and resolves nothing', () => {
    const { tracker, events } = harness(UNSUPPORTED_ADDON_SETTLE_MS)
    tracker.observe([OLD.packageName], [OLD])
    tracker.observe([OLD.packageName], [])
    tracker.stop()
    expect(events).toEqual([])
  })
})

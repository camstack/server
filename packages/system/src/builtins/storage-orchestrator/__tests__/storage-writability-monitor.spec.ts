/**
 * "No writable location for a declared type" is an alert, through the existing
 * alert centre (liveness findings), and only from an ANSWERED state (D315).
 */
import type { StorageLocation, StorageLocationDeclarer } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  StorageWritabilityMonitor,
  type WritabilityEmission,
} from '../storage-writability-monitor.js'

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never
const EVENT_MEDIA = { id: 'eventMedia', displayName: 'Event media', cardinality: 'multi' } as const

function loc(mode: StorageLocation['mode'], id = 'eventMedia:default'): StorageLocation {
  return {
    id,
    type: 'eventMedia',
    displayName: 'x',
    providerId: 'filesystem-storage',
    config: {},
    isSystem: false,
    createdAt: 1,
    updatedAt: 1,
    mode,
  }
}

const loaded: StorageLocationDeclarer = {
  addonId: 'pipeline-analytics',
  packageName: '@camstack/addon-post-analysis',
  loaded: true,
  declarations: [EVENT_MEDIA],
}
const failedLoad: StorageLocationDeclarer = { ...loaded, loaded: false }

function harness() {
  const emitted: WritabilityEmission[] = []
  const monitor = new StorageWritabilityMonitor({
    emit: (e) => emitted.push(e),
    logger,
  })
  return { monitor, emitted }
}

describe('StorageWritabilityMonitor', () => {
  it('raises one finding naming the type, the addons and what stops working', () => {
    const { monitor, emitted } = harness()
    monitor.evaluate({ authoritative: true, declarers: [loaded], locations: [] })
    expect(emitted).toHaveLength(1)
    const e = emitted[0]!
    expect(e.category).toBe(EventCategory.SystemLivenessFailed)
    expect(e.data['findingId']).toBe('storage:no-writable-location:eventMedia')
    expect(e.data['href']).toBe('/system/storage')
    expect(String(e.data['message'])).toContain('pipeline-analytics')
    expect(String(e.data['message'])).toContain('no thumbnails or track photos are saved')
  })

  it('raises when every location of the type is readonly, drain or disabled', () => {
    for (const mode of ['readonly', 'drain', 'disabled'] as const) {
      const { monitor, emitted } = harness()
      monitor.evaluate({ authoritative: true, declarers: [loaded], locations: [loc(mode)] })
      expect(emitted.map((e) => e.category)).toEqual([EventCategory.SystemLivenessFailed])
    }
  })

  it('resolves on its own once a writable location exists, once', () => {
    const { monitor, emitted } = harness()
    monitor.evaluate({ authoritative: true, declarers: [loaded], locations: [] })
    monitor.evaluate({ authoritative: true, declarers: [loaded], locations: [loc('active')] })
    monitor.evaluate({ authoritative: true, declarers: [loaded], locations: [loc('active')] })
    expect(emitted.map((e) => e.category)).toEqual([
      EventCategory.SystemLivenessFailed,
      EventCategory.SystemLivenessRecovered,
    ])
    expect(emitted[1]!.data['findingId']).toBe('storage:no-writable-location:eventMedia')
  })

  it('a healthy first pass clears a stale card left by a dropped recovery event', () => {
    const { monitor, emitted } = harness()
    monitor.evaluate({ authoritative: true, declarers: [loaded], locations: [loc('active')] })
    expect(emitted.map((e) => e.category)).toEqual([EventCategory.SystemLivenessRecovered])
  })

  it('raises nothing while the state is unknown (store not answered)', () => {
    const { monitor, emitted } = harness()
    monitor.evaluate({ authoritative: false, declarers: [loaded], locations: [] })
    expect(emitted).toEqual([])
  })

  it('raises nothing for a type whose only declarer failed to load', () => {
    const { monitor, emitted } = harness()
    monitor.evaluate({ authoritative: true, declarers: [failedLoad], locations: [] })
    expect(emitted).toEqual([])
  })

  it('raises nothing when a package could not be read (declarations unknown)', () => {
    const { monitor, emitted } = harness()
    const unreadable: StorageLocationDeclarer = {
      addonId: null,
      packageName: 'broken',
      loaded: false,
      declarations: [],
    }
    monitor.evaluate({ authoritative: true, declarers: [loaded, unreadable], locations: [] })
    expect(emitted).toEqual([])
  })
})

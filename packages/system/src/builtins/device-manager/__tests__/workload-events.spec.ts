/**
 * The `workload` cap's events (#585) are raised by the mirror from the PUBLIC
 * slice, like `running-state`: a provider only writes its state, and started /
 * stopped / crashed / recovered follow from the transitions.
 */
import { describe, expect, it } from 'vitest'
import { EventCategory, runtimeStatePolicyFor } from '@dominevo/types'
import { harness, type Harness } from './mirror-harness.js'

const WORKLOAD_CATEGORIES: ReadonlySet<string> = new Set([
  EventCategory.WorkloadStarted,
  EventCategory.WorkloadStopped,
  EventCategory.WorkloadCrashed,
  EventCategory.WorkloadRecovered,
])

function workloadEvents(h: Harness): readonly string[] {
  return h.categories.filter((c) => WORKLOAD_CATEGORIES.has(c))
}

function slice(state: string | null, at: number): Record<string, unknown> {
  return { state, since: at, lastFetchedAt: at }
}

describe('workload events from the mirror', () => {
  it('a first state is a seed; each settled move afterwards is one event', () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.applySingleCapUpdate(5, 'workload', slice('running', 1))
    expect(workloadEvents(h)).toEqual([])

    h.mirror.applySingleCapUpdate(5, 'workload', slice('crashed', 2))
    h.mirror.applySingleCapUpdate(5, 'workload', slice('starting', 3))
    h.mirror.applySingleCapUpdate(5, 'workload', slice('running', 4))
    h.mirror.applySingleCapUpdate(5, 'workload', slice('stopping', 5))
    h.mirror.applySingleCapUpdate(5, 'workload', slice('stopped', 6))
    h.mirror.applySingleCapUpdate(5, 'workload', slice('running', 7))
    expect(workloadEvents(h)).toEqual([
      EventCategory.WorkloadCrashed,
      EventCategory.WorkloadRecovered,
      EventCategory.WorkloadStopped,
      EventCategory.WorkloadStarted,
    ])
  })

  it('another cap with a `state` field raises no workload event', () => {
    const h = harness(runtimeStatePolicyFor)
    h.mirror.applySingleCapUpdate(6, 'media-player', { state: 'off', lastFetchedAt: 1 })
    h.mirror.applySingleCapUpdate(6, 'media-player', { state: 'stopped', lastFetchedAt: 2 })
    h.mirror.applySingleCapUpdate(6, 'media-player', { state: 'running', lastFetchedAt: 3 })
    expect(workloadEvents(h)).toEqual([])
  })
})

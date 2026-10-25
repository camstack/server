/**
 * `runTrackCascadeBatch` — the widened batch runner shared by the three
 * retention entry points (design §5): deleteTracks (operator), pruneTracksBefore
 * (time), wipeAllAnalytics (clean slate). Wraps the extensible
 * `cascadeDeleteTracks(registry, trackStore, [id])` per track so that:
 *  - every registered TrackScopedStore runs for each track (widened cascade),
 *  - a per-track failure is ISOLATED (one bad id never aborts the batch),
 *  - `onTrackCleanup` fires ONLY for tracks whose cascade succeeded.
 *
 * D683 review N6: `expandLeafIdsGrouped` resolves ONCE for the whole batch
 * (same round-trip count L3 shipped), but GROUPED by survivor — each
 * track's own cascade sees only ITS OWN aliases, never a sibling's, and a
 * throwing resolve fails every id in the batch through the SAME per-track
 * `onFailure`/`failed` reporting every other failure uses (not a rejection
 * before the loop runs).
 */
import { describe, it, expect, vi } from 'vitest'
import {
  runTrackCascadeBatch,
  type TrackScopedStore,
  type TrackRootStore,
} from '../delete-track-cascade.js'

describe('runTrackCascadeBatch', () => {
  it('runs the full registry per track and fires cleanup for each success', async () => {
    const calls: string[] = []
    const registry: readonly TrackScopedStore[] = [
      {
        deleteByTracks: async (ids) => {
          calls.push(`events:${ids.join(',')}`)
          return [{ family: 'events', rows: ids.length, bytes: 0 }]
        },
      },
      {
        deleteByTracks: async (ids) => {
          calls.push(`faces:${ids.join(',')}`)
          return [{ family: 'faces', rows: ids.length, bytes: 0 }]
        },
      },
    ]
    const trackStore: TrackRootStore = {
      deletePersisted: async (id) => void calls.push(`root:${id}`),
    }
    const cleaned: Array<{ deviceId: number; trackId: string }> = []

    const result = await runTrackCascadeBatch(
      {
        registry,
        trackStore,
        deviceId: 7,
        onTrackCleanup: (deviceId, trackId) => cleaned.push({ deviceId, trackId }),
      },
      ['t-1', 't-2'],
    )

    expect(result.deleted).toBe(2)
    expect(result.failed).toEqual([])
    // The receipt the ops log reports — one events row + one faces row per track.
    expect(result.tally.tracks).toBe(2)
    expect(result.tally.events).toBe(2)
    expect(result.tally.faces).toBe(2)
    // Each track flows through the WHOLE registry, root last, before the next.
    expect(calls).toEqual([
      'events:t-1',
      'faces:t-1',
      'root:t-1',
      'events:t-2',
      'faces:t-2',
      'root:t-2',
    ])
    expect(cleaned).toEqual([
      { deviceId: 7, trackId: 't-1' },
      { deviceId: 7, trackId: 't-2' },
    ])
  })

  it('isolates a per-track failure — cleanup only for successes, failed collected', async () => {
    const registry: readonly TrackScopedStore[] = [
      {
        deleteByTracks: async (ids) => {
          if (ids.includes('bad')) throw new Error('boom')
          return [{ family: 'events', rows: ids.length, bytes: 0 }]
        },
      },
    ]
    const trackStore: TrackRootStore = { deletePersisted: vi.fn(async () => {}) }
    const cleaned: string[] = []
    const failures: string[] = []

    const result = await runTrackCascadeBatch(
      {
        registry,
        trackStore,
        deviceId: 1,
        onTrackCleanup: (_d, trackId) => cleaned.push(trackId),
        onFailure: (trackId) => failures.push(trackId),
      },
      ['good', 'bad', 'good-2'],
    )

    expect(result.deleted).toBe(2)
    expect(result.failed).toEqual(['bad'])
    expect(cleaned).toEqual(['good', 'good-2'])
    expect(failures).toEqual(['bad'])
    // The failing track never reaches the root delete.
    expect(trackStore.deletePersisted).not.toHaveBeenCalledWith('bad')
  })

  it('resolves `expandLeafIdsGrouped` ONCE per batch, but gives each track only its OWN aliases (review N6)', async () => {
    const seen: string[][] = []
    const registry: readonly TrackScopedStore[] = [
      {
        deleteByTracks: async (ids) => {
          seen.push([...ids])
          return [{ family: 'events', rows: ids.length, bytes: 0 }]
        },
      },
    ]
    const trackStore: TrackRootStore = { deletePersisted: async () => {} }
    let expandCalls = 0
    const result = await runTrackCascadeBatch(
      {
        registry,
        trackStore,
        deviceId: 1,
        onTrackCleanup: () => {},
        expandLeafIdsGrouped: async (ids) => {
          expandCalls += 1
          // A fake alias table: every id in the BATCH names one straggler,
          // grouped by survivor.
          return new Map(ids.map((id): [string, readonly string[]] => [id, [`${id}-alias`]]))
        },
      },
      ['t-1', 't-2', 't-3'],
    )
    expect(result.deleted).toBe(3)
    expect(expandCalls, 'one resolve for the whole batch').toBe(1)
    // Each track's OWN cascade sees only ITS OWN widened alias — never a
    // sibling's. Over-inclusive across siblings is NOT harmless: a sibling
    // whose own cascade later fails must not have already lost its rows to
    // an earlier track's widened delete.
    expect(seen).toEqual([
      ['t-1', 't-1-alias'],
      ['t-2', 't-2-alias'],
      ['t-3', 't-3-alias'],
    ])
  })

  it('a throwing `expandLeafIdsGrouped` fails every id in the batch, per-track (review N6), with ONE batch-level report (review L-R3)', async () => {
    const registry: readonly TrackScopedStore[] = [
      { deleteByTracks: async (ids) => [{ family: 'events', rows: ids.length, bytes: 0 }] },
    ]
    const trackStore: TrackRootStore = { deletePersisted: vi.fn(async () => {}) }
    const cleaned: string[] = []
    const failures: string[] = []
    const batchFailures: Array<{ failedIds: readonly string[]; err: unknown }> = []

    const result = await runTrackCascadeBatch(
      {
        registry,
        trackStore,
        deviceId: 1,
        onTrackCleanup: (_d, trackId) => cleaned.push(trackId),
        onFailure: (trackId) => failures.push(trackId),
        onExpandBatchFailure: (failedIds, err) => batchFailures.push({ failedIds, err }),
        expandLeafIdsGrouped: async () => {
          throw new Error('alias store unreachable')
        },
      },
      ['t-1', 't-2', 't-3'],
    )

    expect(result.deleted).toBe(0)
    expect(result.failed).toEqual(['t-1', 't-2', 't-3'])
    expect(failures).toEqual(['t-1', 't-2', 't-3'])
    expect(cleaned).toEqual([])
    expect(trackStore.deletePersisted).not.toHaveBeenCalled()
    // Review L-R3: a persistently failing alias store must be ANSWERABLE —
    // one batch-level report naming how many ids it cost, not just three
    // individually-sunk per-track failures an operator has to count.
    expect(batchFailures, 'one batch-level report, not one per id').toHaveLength(1)
    expect(batchFailures[0]?.failedIds).toEqual(['t-1', 't-2', 't-3'])
    expect(batchFailures[0]?.err).toBeInstanceOf(Error)
  })
})

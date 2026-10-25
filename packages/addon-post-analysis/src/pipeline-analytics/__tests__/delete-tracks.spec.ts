/**
 * Whole-track deletion cascade (Task 4).
 *
 * Verifies `cascadeDeleteTrack` runs its stores in spec order:
 *   events ids → their media + track media → track row
 * and that an empty event-id set skips `deleteForEvents` but still runs the
 * track-media + track-row legs.
 */
import { describe, it, expect, vi } from 'vitest'
import type { EventOwnedMediaIds } from '../store/event-store.js'
import { cascadeDeleteTrack, type TrackDeletionStores } from '../pipeline/delete-track-cascade.js'

interface RecordingStores extends TrackDeletionStores {
  readonly calls: string[]
}

function makeStores(eventIds: readonly string[]): RecordingStores {
  const calls: string[] = []
  return {
    calls,
    eventStore: {
      deleteByTrack: vi.fn(async (trackId: string) => {
        calls.push(`deleteByTrack:${trackId}`)
        return eventIds
      }),
    },
    mediaStore: {
      deleteForEvents: vi.fn(async (ids: EventOwnedMediaIds) => {
        const objectIds = ids.object ?? []
        calls.push(`deleteForEvents:${objectIds.join(',')}`)
        return objectIds.length
      }),
      deleteForTracks: vi.fn(async (ids: readonly string[]) => {
        calls.push(`deleteForTracks:${ids.join(',')}`)
        return ids.length
      }),
    },
    trackStore: {
      deletePersisted: vi.fn(async (trackId: string) => {
        calls.push(`deletePersisted:${trackId}`)
      }),
    },
  }
}

describe('cascadeDeleteTrack', () => {
  it('cascades events → their media → track media → track row, in order', async () => {
    const stores = makeStores(['e1', 'e2'])

    await cascadeDeleteTrack(stores, 't-1')

    expect(stores.calls).toEqual([
      'deleteByTrack:t-1',
      'deleteForEvents:e1,e2',
      'deleteForTracks:t-1',
      'deletePersisted:t-1',
    ])
    expect(stores.eventStore.deleteByTrack).toHaveBeenCalledWith('t-1')
    expect(stores.mediaStore.deleteForEvents).toHaveBeenCalledWith({ object: ['e1', 'e2'] })
    expect(stores.mediaStore.deleteForTracks).toHaveBeenCalledWith(['t-1'])
    expect(stores.trackStore.deletePersisted).toHaveBeenCalledWith('t-1')
  })

  it('skips deleteForEvents when no events matched, still deletes track media + row', async () => {
    const stores = makeStores([])

    await cascadeDeleteTrack(stores, 't-9')

    expect(stores.mediaStore.deleteForEvents).not.toHaveBeenCalled()
    expect(stores.calls).toEqual([
      'deleteByTrack:t-9',
      'deleteForTracks:t-9',
      'deletePersisted:t-9',
    ])
  })
})

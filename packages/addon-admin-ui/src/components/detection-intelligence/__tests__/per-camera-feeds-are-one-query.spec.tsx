/**
 * Three per-camera feeds, and what ONE refresh of each costs.
 *
 * `useStationaryObjects` (15 s), `useKeyEventsFeed` (30 s) and `useScenesFeed`
 * (30 s) each drove a `useQueries` fan-out: one React Query, one tRPC
 * operation, one browser → hub → post-analysis round trip PER CAMERA, on a
 * timer. On the reference fleet that is 29 requests every 15 seconds to read
 * an in-memory map, and 58 more every 30 seconds.
 *
 * The polls stay — these are live-status surfaces and an operator wanting them
 * live is right. What changes is the size of the question: each owner answers
 * for the SET in one call, doing exactly the same per-device work it did
 * before, in the process that already holds the data.
 *
 * These assert the OPERATIONS ISSUED, never wall clock. A test that checked the
 * rendered rows would have passed against the fan-out version — the rows were
 * never wrong, the number of requests to produce them was. And each asserts the
 * singular method is no longer reached at all, because a batch that ran BESIDE
 * the fan-out would satisfy a "the batch was called" assertion while costing
 * strictly more.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Every tRPC procedure the hook under test reached, in order. */
let issued: string[] = []
/** The input each of those procedures was given, in the same order. */
let inputs: unknown[] = []
/** What each procedure answers, keyed by path. */
const answers = new Map<string, unknown>()

function record(path: string): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    issued.push(path)
    inputs.push(input)
    if (!answers.has(path)) throw new Error(`no answer wired for ${path}`)
    return answers.get(path)
  }
}

/** The input the given procedure was called with, first call. */
function inputTo(path: string): Record<string, unknown> {
  const at = issued.indexOf(path)
  if (at < 0) throw new Error(`${path} was never called; saw: ${issued.join(', ')}`)
  return { ...(inputs[at] as object) }
}

function countOf(path: string): number {
  return issued.filter((p) => p === path).length
}

const trpcClient = {
  zoneAnalytics: {
    getCurrentSnapshot: { query: record('zoneAnalytics.getCurrentSnapshot') },
    getCurrentSnapshotBatch: { query: record('zoneAnalytics.getCurrentSnapshotBatch') },
  },
  pipelineAnalytics: {
    getKeyEvents: { query: record('pipelineAnalytics.getKeyEvents') },
    getKeyEventsBatch: { query: record('pipelineAnalytics.getKeyEventsBatch') },
  },
  sceneMonitor: {
    listScenes: { query: record('sceneMonitor.listScenes') },
    listScenesBatch: { query: record('sceneMonitor.listScenesBatch') },
  },
}

vi.mock('@camstack/ui-library', () => ({
  useSystem: () => ({ trpcClient }),
}))

import { useScenesFeed } from '../../../hooks/use-scenes-feed.js'
import { useKeyEventsFeed } from '../use-key-events-feed.js'
import { useStationaryObjects } from '../use-stationary-objects.js'

const DEVICE_IDS: readonly number[] = [101, 102, 108, 616, 619]

function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

describe('per-camera feeds cost ONE query per refresh, not one per camera', () => {
  beforeEach(() => {
    issued = []
    inputs = []
    answers.clear()
  })

  it('useStationaryObjects asks zone-analytics once for the whole selection', async () => {
    answers.set(
      'zoneAnalytics.getCurrentSnapshotBatch',
      DEVICE_IDS.map((deviceId) => ({
        deviceId,
        read: 'read' as const,
        snapshot: { stationaryObjects: [] },
      })),
    )
    const { result } = renderHook(() => useStationaryObjects(DEVICE_IDS), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(countOf('zoneAnalytics.getCurrentSnapshotBatch')).toBe(1)
    expect(countOf('zoneAnalytics.getCurrentSnapshot')).toBe(0)
  })

  it('useKeyEventsFeed asks pipeline-analytics once for the whole selection', async () => {
    answers.set(
      'pipelineAnalytics.getKeyEventsBatch',
      DEVICE_IDS.map((deviceId) => ({ deviceId, events: [] })),
    )
    const { result } = renderHook(
      () => useKeyEventsFeed({ deviceIds: DEVICE_IDS, since: 0, until: 1_000 }),
      { wrapper },
    )
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(countOf('pipelineAnalytics.getKeyEventsBatch')).toBe(1)
    expect(countOf('pipelineAnalytics.getKeyEvents')).toBe(0)
    // The one thing collapsing N queries into one could quietly change: the
    // page size. `limit` is PER CAMERA on both methods — as a total across the
    // set it would let a busy camera starve a quiet one of its rows, which
    // changes what the merged feed CONTAINS and not only what it costs.
    const sent = inputTo('pipelineAnalytics.getKeyEventsBatch')
    expect(sent['limit']).toBe(200)
    expect(sent['deviceIds']).toEqual([...DEVICE_IDS])
  })

  it('useScenesFeed asks scene-monitor once for the whole selection', async () => {
    answers.set(
      'sceneMonitor.listScenesBatch',
      DEVICE_IDS.map((deviceId) => ({
        deviceId,
        status: { monitors: [], lastFetchedAt: 0 },
      })),
    )
    const { result } = renderHook(() => useScenesFeed(DEVICE_IDS), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(countOf('sceneMonitor.listScenesBatch')).toBe(1)
    expect(countOf('sceneMonitor.listScenes')).toBe(0)
  })

  it('an empty selection asks NOTHING — a batch floor of one id is not a request for all', async () => {
    // `deviceIds.min(1)` on the cap means an empty selection has no legal
    // batch call. The fan-out expressed that by rendering zero queries; the
    // batch must not express it by sending `[]` and being answered with the
    // fleet.
    renderHook(() => useStationaryObjects([]), { wrapper })
    renderHook(() => useScenesFeed([]), { wrapper })
    renderHook(() => useKeyEventsFeed({ deviceIds: [], since: 0, until: 1_000 }), { wrapper })
    await waitFor(() => {
      expect(issued).toEqual([])
    })
  })

  it('still reports a camera the owner could not read — it is not a camera with no scenes', async () => {
    // The fan-out counted per-camera failures (`unreachableCount`), and that
    // number is what tells an operator "pipeline-analytics is not deployed"
    // apart from "nothing is configured". A batch that dropped the row, or
    // gave it `monitors: []`, would erase the distinction silently.
    answers.set('sceneMonitor.listScenesBatch', [
      { deviceId: 101, status: { monitors: [], lastFetchedAt: 0 } },
      { deviceId: 616, status: null },
      { deviceId: 102, status: null },
    ])
    const { result } = renderHook(() => useScenesFeed([101, 616, 102]), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.unreachableCount).toBe(2)
    expect(result.current.results.map((r) => r.deviceId)).toEqual([101])
  })

  it('an UNREADABLE occupancy row never renders as a camera with nothing parked', async () => {
    answers.set('zoneAnalytics.getCurrentSnapshotBatch', [
      {
        deviceId: 101,
        read: 'read' as const,
        snapshot: {
          stationaryObjects: [{ id: 'p1', className: 'car', becameStationaryAt: 10 }],
        },
      },
      { deviceId: 616, read: 'unreadable' as const, snapshot: null },
    ])
    const { result } = renderHook(() => useStationaryObjects([101, 616]), { wrapper })
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })
    expect(result.current.rows.map((r) => r.deviceId)).toEqual([101])
    expect(result.current.unreadableCount).toBe(1)
  })
})

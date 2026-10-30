// @vitest-environment jsdom
/**
 * `useClusterTopology` shows the NEWER of the pushed snapshot and the query.
 *
 * Renaming a node invalidates `nodes.topology`; the refetch carries the new
 * name, but no `cluster.topology-snapshot` is pushed until the next heartbeat.
 * A snapshot that always won kept the old name on screen until a reload.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const topologyQuery = vi.hoisted(() => ({
  current: { data: undefined as unknown, dataUpdatedAt: 0, isLoading: false, isError: false },
}))
const snapshotState = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../../trpc-react', () => ({
  trpc: { nodes: { topology: { useQuery: () => topologyQuery.current } } },
}))
vi.mock('../use-event-stream', () => ({
  useEventStreamLatest: () => snapshotState.current,
}))

import { useClusterTopology } from '../use-cluster-nodes'

const node = (name: string) => ({ id: 'agent-1', name, isHub: false, isOnline: true })

describe('useClusterTopology freshness', () => {
  beforeEach(() => {
    topologyQuery.current = { data: undefined, dataUpdatedAt: 0, isLoading: false, isError: false }
    snapshotState.current = null
  })

  it('prefers a query refetched AFTER the snapshot arrived (rename → invalidate)', () => {
    snapshotState.current = { nodes: [node('old name')], timestamp: 1 }
    topologyQuery.current = {
      data: [node('new name')],
      dataUpdatedAt: Date.now() + 60_000,
      isLoading: false,
      isError: false,
    }
    const { result } = renderHook(() => useClusterTopology())
    expect(result.current.nodes?.[0]?.name).toBe('new name')
  })

  it('prefers a snapshot pushed after the query was fetched', () => {
    snapshotState.current = { nodes: [node('pushed')], timestamp: 1 }
    topologyQuery.current = {
      data: [node('bootstrap')],
      dataUpdatedAt: 1,
      isLoading: false,
      isError: false,
    }
    const { result } = renderHook(() => useClusterTopology())
    expect(result.current.nodes?.[0]?.name).toBe('pushed')
  })

  it('falls back to the query when no snapshot has arrived', () => {
    topologyQuery.current = {
      data: [node('bootstrap')],
      dataUpdatedAt: 5,
      isLoading: false,
      isError: false,
    }
    const { result } = renderHook(() => useClusterTopology())
    expect(result.current.nodes?.[0]?.name).toBe('bootstrap')
  })
})

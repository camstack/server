/**
 * useConnectionHealth — React binding for the connection-health store
 * (`lib/connection-health.ts`). Replaces the old `useConnectionStatus`
 * raw 3-state mirror of the SDK WS state: the store verifies hub
 * liveness with a hub-only probe before ever reporting the hub as
 * unreachable, so a frozen cluster node no longer renders a misleading
 * "Server unreachable" banner.
 */
import { useSyncExternalStore } from 'react'
import { type ConnectionHealth, getConnectionHealthStore } from '../lib/connection-health'

export function useConnectionHealth(): ConnectionHealth {
  const store = getConnectionHealthStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

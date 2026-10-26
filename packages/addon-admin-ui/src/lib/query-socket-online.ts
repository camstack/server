/**
 * React Query's "online" is the hub socket, not the browser's network flag.
 * A tab focus (or an invalidate) while the socket is still reconnecting must
 * not fetch: the ws link fails those calls with no server payload. They run
 * once the socket is connected again (`refetchOnReconnect`).
 */
import { onlineManager } from '@tanstack/react-query'
import type { SdkConnectionState } from './connection-health'

export function queryTransportOnline(state: SdkConnectionState): boolean {
  return state === 'connected'
}

export function applyQueryTransportOnline(state: SdkConnectionState): void {
  onlineManager.setOnline(queryTransportOnline(state))
}

/**
 * useDoorbellEvents — subscribe to doorbell.onPressed across the cluster.
 *
 * Returns the most recent press (latest event) and a list of recent
 * presses (ring-buffer, capped). The hook is event-driven (no polling),
 * relying on the typed `EventCategory.DoorbellOnPressed` stream that
 * every device with the `doorbell` cap emits.
 *
 * Filter by `deviceId` to scope to one camera; pass `null` to listen
 * cluster-wide (used by the global toast/notifier).
 */
import { useEffect, useState } from 'react'
import { useEventStreamLatest } from './use-event-stream'

export interface DoorbellPressEvent {
  readonly deviceId: number
  readonly timestamp: number
}

export interface UseDoorbellEventsResult {
  /** Most recent press, or null if none observed since mount. */
  readonly latest: DoorbellPressEvent | null
  /** Recent presses, newest-first. Capped at `historyLimit`. */
  readonly history: readonly DoorbellPressEvent[]
}

export interface UseDoorbellEventsOptions {
  /**
   * Scope the subscription to a specific deviceId. Pass `null` (or
   * omit) to receive every press across the cluster.
   */
  readonly deviceId?: number | null
  /** Max history entries kept in memory. Defaults to 20. */
  readonly historyLimit?: number
}

export function useDoorbellEvents(options?: UseDoorbellEventsOptions): UseDoorbellEventsResult {
  const deviceId = options?.deviceId ?? null
  const historyLimit = options?.historyLimit ?? 20

  // Filter applied at the source so cluster-wide listeners can scope
  // to a device without re-rendering on every cam's press.
  const event = useEventStreamLatest<DoorbellPressEvent>(
    'doorbell.onPressed',
    deviceId !== null ? (data) => data.deviceId === deviceId : undefined,
  )

  const [history, setHistory] = useState<readonly DoorbellPressEvent[]>([])

  useEffect(() => {
    if (!event) return
    setHistory((prev) => {
      // De-dup on (deviceId, timestamp): the typed event stream may
      // replay the latest payload on subscribe, which would otherwise
      // double-insert the same press.
      if (
        prev.length > 0 &&
        prev[0]!.deviceId === event.deviceId &&
        prev[0]!.timestamp === event.timestamp
      ) {
        return prev
      }
      const next = [event, ...prev]
      return next.length > historyLimit ? next.slice(0, historyLimit) : next
    })
  }, [event, historyLimit])

  return {
    latest: event ?? null,
    history,
  }
}

/**
 * useLiveBuffer — capped FIFO buffer for live-pushed entries.
 *
 * The Log/Event/StateValues streams each accumulate WebSocket-pushed
 * entries into a ring. By default each component owns its own
 * `useState` ring, but those streams sit inside a tabbed panel
 * (`DeviceActivityPanel`) where switching away unmounts the active
 * stream — and with it, the local ring. Even though the server's
 * recent-events query repopulates initial history on remount, the
 * global event ring evicts low-volume `device.state-changed` entries
 * fast, so the panel looked "reset" every time.
 *
 * Callers that need the buffer to survive across mounts host this
 * hook in a parent and pass the returned handle into the stream
 * component as a controlled `liveBuffer` prop. The stream still
 * owns its tRPC subscription (so subscriptions only fire while the
 * inner component is mounted), but it appends into the parent-owned
 * array — preserving the visible list across tab switches without
 * keeping idle subscriptions alive.
 */
import { useCallback, useMemo, useState } from 'react'

export interface LiveBuffer<T> {
  readonly entries: readonly T[]
  /** Append one entry; oldest is evicted past `max`. */
  readonly append: (entry: T) => void
  /** Replace all entries — used by Clear / scope-change resets. */
  readonly reset: () => void
}

export function useLiveBuffer<T>(max: number): LiveBuffer<T> {
  const [entries, setEntries] = useState<readonly T[]>([])

  const append = useCallback(
    (entry: T) => {
      setEntries((prev) => {
        const next = [...prev, entry]
        return next.length > max ? next.slice(-max) : next
      })
    },
    [max],
  )

  const reset = useCallback(() => {
    setEntries([])
  }, [])

  return useMemo(() => ({ entries, append, reset }), [entries, append, reset])
}

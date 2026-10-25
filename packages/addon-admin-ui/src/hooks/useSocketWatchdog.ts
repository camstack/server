/**
 * useSocketWatchdog — watches browser-platform signals that suggest
 * the WebSocket may have gone stale (tab woken from background,
 * network reconnect, BFCache restore) and calls `reconnect()` so the
 * next-stage transport can re-handshake.
 *
 * Complements tRPC v11's application-layer keep-alive (ping/pong with
 * `pongTimeoutMs`): keep-alive catches silent half-open sockets while
 * the tab is foregrounded; the watchdog catches the cases where the
 * browser/OS suspended the timer entirely (Chrome background tab
 * throttling, macOS sleep, Wi-Fi drop with no in-flight traffic).
 *
 * Web-only: React Native consumers should mirror this hook with
 * `AppState` (active vs background) + `NetInfo` rather than DOM
 * events, but reuse the same SDK-side `System.reconnect()` rebuild
 * primitive.
 *
 * Listeners are removed on unmount, and the latest `reconnect`
 * callback is captured via a ref so the effect's dependency list
 * stays empty (no re-binding on every render).
 */
import { useEffect, useRef } from 'react'

const HIDDEN_RECONNECT_THRESHOLD_MS = 30_000

type ReconnectFn = () => void | Promise<void>

export function useSocketWatchdog(reconnect: ReconnectFn): void {
  const reconnectRef = useRef<ReconnectFn>(reconnect)
  reconnectRef.current = reconnect

  useEffect(() => {
    let lastHiddenAt: number | null = null

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') {
        lastHiddenAt = Date.now()
        return
      }
      if (document.visibilityState === 'visible' && lastHiddenAt !== null) {
        const hiddenForMs = Date.now() - lastHiddenAt
        lastHiddenAt = null
        if (hiddenForMs >= HIDDEN_RECONNECT_THRESHOLD_MS) {
          void reconnectRef.current()
        }
      }
    }

    const onOnline = (): void => {
      void reconnectRef.current()
    }

    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) void reconnectRef.current()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('online', onOnline)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])
}

/**
 * useEventInvalidation — subscribe to one or more EventBus categories
 * over the unified `System.subscribeEvent` push channel and invalidate
 * a React Query cache prefix when any of them fires.
 *
 * Lets callers drop their `refetchInterval` polling: the cache is kept
 * fresh by server-pushed events instead of timer-driven refetches. The
 * hook is a no-op when the WebSocket isn't available (e.g. during
 * initial reconnection) — the caller is free to keep a long
 * `staleTime` so React Query still serves the last good snapshot.
 *
 * Input shape — pass the tRPC procedure path directly:
 *   ✔ `['integrations']`              → invalidates every `integrations.*`
 *   ✔ `['deviceManager', 'listAll']`  → invalidates that one query
 *
 * The hook wraps the path into the `[[...path], ...]` form that
 * @tanstack/react-query + @trpc/react-query use under the hood —
 * passing a flat `['integrations']` to `invalidateQueries` directly
 * would never match the actual tRPC key
 * `[['integrations', 'list'], { input, type }]`. Caller doesn't have
 * to know about the wrap.
 *
 * Reconnect resilience: when `System.reconnect()` rebuilds the
 * underlying wsClient + tRPC client, the System reference doesn't
 * change — but `connectionVersion` bumps. We listen via
 * `subscribeConnectionEvents` so the subscription effect re-runs
 * against the freshly-rebuilt tRPC client.
 *
 * Lives in `@camstack/ui-library` (not in admin-ui's hooks folder)
 * because addon widget bundles reach for it through the shared library
 * — the original admin-ui copy stayed put for backward compatibility
 * but new consumers should import from here.
 */
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSystem } from '../contexts/system-context.js'

/** Trailing coalesce for event-driven invalidation — see the comment inside. */
const EVENT_INVALIDATION_COALESCE_MS = 1_000

export function useEventInvalidation(
  queryKey: readonly unknown[],
  categories: readonly string[],
): void {
  const system = useSystem()
  const queryClient = useQueryClient()
  // Mirrors the SDK's `connectionVersion` — bump on every new
  // `'connected'` transition so the subscription effect below re-runs
  // and re-binds to the freshly-rebuilt tRPC client.
  const [tick, setTick] = useState<number>(system.connectionVersion)

  useEffect(() => {
    return system.subscribeConnectionEvents((state, version) => {
      if (state === 'connected') setTick(version)
    })
  }, [system])

  // Stable joined key so the effect only re-subscribes when the category
  // set actually changes — passing a new array literal each render
  // (common in callers) shouldn't tear down + rebuild the subscription.
  const key = categories.join('|')
  // Stable JSON of queryKey for the same reason.
  const keyJson = JSON.stringify(queryKey)
  useEffect(() => {
    const subs: Array<() => void> = []
    // COALESCE WINDOW. The stream-broker emits metrics-snapshot at ~1 Hz PER
    // BROKER — 60-80 events/s on a 27-camera fleet — and this hook used to
    // invalidate (→ refetch) once per event: ~70 refetches/s of listClients
    // while the panel was open. Warm, the runner answers in ms and it merely
    // wasted cycles; during a boot it cannot answer, every refetch parked
    // 60 s server-side, and ONE open admin tab produced 2 028 UDS timeouts in
    // 5 minutes (measured, 2026-08-19) — a self-feeding storm that also
    // queued unrelated boot reads for 131 s. Trailing, so the last event of a
    // burst still lands; the UI freshness cost is ≤ the window.
    let pending: ReturnType<typeof setTimeout> | null = null
    const refreshNow = (): void => {
      // Wrap once: tRPC keys queries as `[[<router>, <proc>], {input, type}]`
      // so the React-Query prefix we need is `[[<router>, ...]]`. Idempotent —
      // a caller that already wrapped (`[['x']]`) would end up with
      // `[[['x']]]` which still prefix-matches nothing, so we detect that
      // shape and pass-through.
      const raw = JSON.parse(keyJson) as unknown[]
      const alreadyWrapped = raw.length === 1 && Array.isArray(raw[0])
      const queryKeyToInvalidate = alreadyWrapped ? raw : [raw]
      void queryClient.invalidateQueries({ queryKey: queryKeyToInvalidate })
    }
    const refresh = (): void => {
      if (pending !== null) return
      pending = setTimeout(() => {
        pending = null
        refreshNow()
      }, EVENT_INVALIDATION_COALESCE_MS)
    }

    // Trigger an initial invalidation so the cache refetches the
    // moment the subscription is established. Without this, server
    // events fired between the page mount and the WS subscribe (or
    // during a post-login client recreation) leave the cache stale —
    // the operator sees old data until a fresh event eventually fires.
    // Immediate on purpose: mount freshness must not pay the window.
    refreshNow()

    for (const category of key.split('|')) {
      if (!category) continue
      try {
        subs.push(system.subscribeEvent(category, refresh))
      } catch {
        // WS not available or transient subscription failure — skip.
      }
    }
    return () => {
      if (pending !== null) clearTimeout(pending)
      for (const unsub of subs) unsub()
    }
    // `tick` in deps: a System internal reconnect bumps the version,
    // the connection-events listener flips `tick`, this effect re-runs
    // and subscribes against the fresh trpc client.
  }, [system, queryClient, key, keyJson, tick])
}

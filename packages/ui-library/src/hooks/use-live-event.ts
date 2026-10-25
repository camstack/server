/**
 * useLiveEvent — single-call subscription to the `live.onEvent` push
 * stream by category.
 *
 * Wraps `System.subscribeEvent` in a React-friendly shape: stable
 * callback ref so the consumer doesn't have to memoise, automatic
 * cleanup at unmount, and a tick on connection reset so subscriptions
 * re-bind to the freshly-rebuilt tRPC client after a forced reconnect
 * (login/logout, BFCache resume).
 */
import { useEffect, useRef, useState } from 'react'
import type { SystemLiveEvent } from '@camstack/sdk'
import { useSystem } from '../contexts/system-context.js'

export type LiveEventCallback<TData = unknown> = (event: SystemLiveEvent<TData>) => void

export function useLiveEvent<TData = unknown>(
  category: string,
  cb: LiveEventCallback<TData>,
): void {
  const system = useSystem()
  // Latest-callback ref pattern — the effect captures the ref, not the
  // callback identity, so callers don't need to memoise their handler.
  const cbRef = useRef<LiveEventCallback<TData>>(cb)
  cbRef.current = cb

  // Bump on every fresh `'connected'` so the subscription rebuilds
  // against the new tRPC client after a reconnect.
  const [tick, setTick] = useState<number>(system.connectionVersion)
  useEffect(() => {
    return system.subscribeConnectionEvents((state, version) => {
      if (state === 'connected') setTick(version)
    })
  }, [system])

  useEffect(() => {
    const unsub = system.subscribeEvent<TData>(category, (evt) => {
      cbRef.current(evt)
    })
    return unsub
  }, [system, category, tick])
}

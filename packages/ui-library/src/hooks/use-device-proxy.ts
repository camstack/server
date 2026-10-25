/**
 * useDeviceProxy — canonical React entry point for a device.
 *
 * Symmetric with the server's `ctx.fetchDevice(id)` and the SDK's
 * `BackendClient.fetchDevice(id)` — same `DeviceProxy` shape, same
 * routing semantics (cap-method calls go through the wrapper chain;
 * `state.<cap>.value` reads the kernel's mirrored snapshot, never
 * the provider).
 *
 * What you can do with the returned proxy:
 *
 *   const dev = useDeviceProxy(trpc, deviceId)
 *
 *   // Reactive runtime state — re-renders when the slice changes.
 *   const battery = useDeviceStateSlice(dev?.state.battery)
 *
 *   // Imperative cap-method calls — through the wrapper chain.
 *   await dev?.snapshot?.getSnapshot({ streamId: 'high' })
 *   await dev?.ptz?.move({ direction: 'left', steps: 1 })
 *
 * Lifecycle: the hook resolves bindings via `deviceManager.getBindings`
 * the first time `deviceId` becomes valid, and refreshes them on
 * `capability.binding-changed` events for that device. Returns `null`
 * until the first resolution completes (the proxy is not constructible
 * without a binding).
 *
 * Works in both admin-ui (`BackendClient.trpc`) and addon pages
 * (`AddonPageProps.trpc`) — parametrized by a minimal vanilla tRPC
 * proxy shape (matches both at runtime).
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { DeviceBinding, DeviceProxy } from '@camstack/types'
import { createDeviceProxy } from '@camstack/types'

/**
 * Reactive runtime-state read handle as exposed by the codegen
 * `DeviceProxy` factory. Same shape useDeviceStateSlice expects —
 * defined here so the combinator's selector parameter has a tight
 * type without re-importing the codegen file.
 */
interface StateSliceHandle<T> {
  readonly value: T | undefined
  subscribe(cb: (slice: T | undefined) => void): () => void
}

interface QueryFn<I, O> {
  query(input: I): Promise<O>
}

interface SubscribeFn<I, T> {
  subscribe(
    input: I,
    opts: { onData: (evt: { data: T }) => void; onError?: (err: unknown) => void },
  ): { unsubscribe: () => void }
}

/**
 * Minimal vanilla tRPC proxy shape. Same contract `useDeviceWebrtc`,
 * `useDeviceBattery` etc. use — both `BackendClient.trpc` and an
 * addon page's injected `trpc` satisfy this structurally.
 *
 * The proxy is also passed (cast) into `createDeviceProxy` as the
 * `AddonApi` argument — the cap-method dispatchers structurally
 * match `client.<cap>.<method>.{query|mutate|subscribe}`.
 */
export interface UseDeviceProxyTrpc {
  readonly deviceManager: {
    readonly getBindings: QueryFn<{ deviceId: number }, DeviceBinding>
  }
  readonly live?: {
    readonly onEvent: SubscribeFn<
      { category: string },
      { category?: string; data?: unknown; source?: { type: string; id: string | number } }
    >
  }
}

const BINDING_CHANGED_CATEGORY = 'capability.binding-changed'

/**
 * @returns the proxy, or `null` while bindings are still loading or
 * when `deviceId` is null. Re-rendered when bindings change.
 */
export function useDeviceProxy(
  trpc: UseDeviceProxyTrpc,
  deviceId: number | null,
): DeviceProxy | null {
  const [binding, setBinding] = useState<DeviceBinding | null>(null)

  useEffect(() => {
    if (deviceId === null) {
      setBinding(null)
      return
    }
    let cancelled = false

    const refresh = async (): Promise<void> => {
      try {
        const next = await trpc.deviceManager.getBindings.query({ deviceId })
        if (!cancelled) setBinding(next)
      } catch {
        // Binding fetch failures leave the previous proxy in place —
        // a transient tRPC error shouldn't tear down active subscriptions.
        if (!cancelled) setBinding((prev) => prev)
      }
    }

    void refresh()

    // Live invalidation on binding changes — wrapper toggles, cap
    // (un)registrations etc. emit `capability.binding-changed` so we
    // re-fetch and rebuild the proxy fields the device exposes.
    const sub = trpc.live?.onEvent.subscribe(
      { category: BINDING_CHANGED_CATEGORY },
      {
        onData: (evt) => {
          const src = evt.data?.source
          if (!src) {
            void refresh()
            return
          }
          if (src.type === 'device' && src.id === deviceId) void refresh()
        },
      },
    )

    return () => {
      cancelled = true
      sub?.unsubscribe()
    }
  }, [trpc, deviceId])

  // The proxy is a thin closure over (trpc, binding) — rebuilding it
  // on every render is cheap, but memoising keeps `===` identity stable
  // for downstream effects/callbacks that depend on the proxy.
  return useMemo(() => {
    if (!binding) return null
    return createDeviceProxy(
      // Cast: the vanilla tRPC client is structurally compatible with
      // the AddonApi shape that `createDeviceProxy` expects (matching
      // <cap>.<method>.{query|mutate|subscribe} surface).
      trpc as Parameters<typeof createDeviceProxy>[0],
      binding,
    )
  }, [trpc, binding])
}

/**
 * Companion hook — reads a `SliceHandle` reactively, returning the
 * current value and re-rendering on every push from the kernel
 * mirror. Pass `dev?.state.battery` etc. as the handle.
 *
 *   const dev = useDeviceProxy(trpc, deviceId)
 *   const battery = useDeviceStateSlice(dev?.state.battery)
 *
 * Why a hook (and not just `dev.state.battery.subscribe(...)` inline)?
 * React doesn't observe external mutations on its own — a bare
 * subscribe call inside a render would fire on every render (memory
 * leak), wouldn't trigger a re-render on slice change, and wouldn't
 * clean up at unmount. The hook bridges the imperative
 * `(value, subscribe)` pair into React's declarative lifecycle via
 * `useSyncExternalStore` (the canonical React 18 primitive for
 * external stores — handles tearing in concurrent rendering and
 * de-dups identical pushes).
 */
export function useDeviceStateSlice<T>(handle: StateSliceHandle<T> | undefined): T | undefined {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!handle) return () => undefined
      return handle.subscribe(() => notify())
    },
    [handle],
  )
  const getSnapshot = useCallback(() => handle?.value, [handle])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * One-line combinator — collapse the common
 * `useDeviceProxy + useDeviceStateSlice(dev?.state.<cap>)` pair into a
 * single hook. The selector receives the live `DeviceProxy['state']`
 * bag (typed against the codegen, so `s.battery` etc. autocomplete)
 * and returns one slice handle. Returns the slice value, undefined
 * while the binding resolves OR when the slice has no cached push yet.
 *
 * Idiomatic call-site:
 *
 *   const battery = useDeviceState(trpc, deviceId, (s) => s.battery)
 *   const zones = useDeviceState(trpc, deviceId, (s) => s.zones)
 *
 * vs. the manual pair:
 *
 *   const dev = useDeviceProxy(trpc, deviceId)
 *   const battery = useDeviceStateSlice(dev?.state.battery)
 *   const zones = useDeviceStateSlice(dev?.state.zones)
 *
 * Use the manual pair when:
 *   - you also need the proxy's cap method bag (`dev.zones?.addZone(...)`)
 *   - you want to share the proxy across multiple slice reads with a
 *     single binding fetch (the combinator calls useDeviceProxy
 *     internally, which dedups bindings via React Query in practice
 *     but spawns one extra subscription per call site)
 *
 * Use the combinator when reading just one slice — most common case.
 */
export function useDeviceState<T>(
  trpc: UseDeviceProxyTrpc,
  deviceId: number | null,
  select: (state: DeviceProxy['state']) => StateSliceHandle<T>,
): T | undefined {
  const dev = useDeviceProxy(trpc, deviceId)
  const handle = dev ? select(dev.state) : undefined
  return useDeviceStateSlice(handle)
}

/**
 * Reactive read handle for one cap-keyed slice of a device's
 * runtime state. Returned by `createDeviceProxy(...).state[capName]`.
 *
 * Three pieces:
 *   - `value`: last-known slice. `undefined` until something has
 *     populated it (an active subscription, an explicit `refresh()`,
 *     or — in the case of the SystemManager mirror source — a
 *     warm-boot `getAllSnapshots` payload). Read sync.
 *   - `refresh()`: one-shot pull from the underlying source. For
 *     the lazy tRPC source this is `deviceState.getCapSlice`; for
 *     the SystemManager mirror it's a no-op (the mirror is push-only).
 *   - `subscribe(cb)`: hooks into the source's notification channel,
 *     filtered by `(deviceId, capName)`. Refcounted — the underlying
 *     subscription closes when the last caller unsubscribes.
 *
 * Cross-environment: the same API works in browser (admin-ui via the
 * tRPC client) and on the server (in-process AddonApi). The transport
 * is whatever the supplied source exposes.
 */
export interface SliceHandle<T> {
  /** Latest cached slice. Reflects the most recent `refresh()` or
   *  push event. `undefined` if neither has happened. */
  readonly value: T | undefined
  /** Force a re-fetch from the hub mirror. Updates `value` + notifies
   *  every active subscriber. No-op for the SystemManager mirror
   *  source (it's already push-driven). */
  refresh(): Promise<void>
  /** Subscribe to slice changes. Returns the unsubscribe fn.
   *  Auto-fires the callback once with the current value (or
   *  `undefined`) so the caller sees a snapshot immediately. */
  subscribe(cb: (slice: T | undefined) => void): () => void
  /**
   * Replace the slice on the hub. Routes through
   * `device-state.setCapSlice` — the canonical cross-layer write
   * entrypoint. The local mirror updates via the `onChanged` event
   * (round-trip), so callers should treat the write as eventually
   * consistent and read the new value via `subscribe` rather than
   * synchronously after `await`.
   */
  set(slice: T): Promise<void>
  /**
   * Shallow-merge `partial` into the current slice on the hub.
   * Implemented as read-modify-write client-side: pulls `value`
   * (or refreshes), merges, calls `set()`. Single-writer
   * conventions on each cap make atomic-merge semantics
   * unnecessary — concurrent patches on the same slice from
   * different processes are undefined and should be avoided.
   */
  patch(partial: Partial<T>): Promise<void>
}

/**
 * Minimal tRPC API surface used by the lazy source. Both `AddonApi`
 * (server) and the tRPC client proxy (browser) satisfy it structurally
 * — we don't import either to avoid pulling them in from a leaf type
 * module.
 */
export interface SliceHandleApi {
  readonly deviceState: {
    readonly getCapSlice: {
      query(input: { deviceId: number; capName: string }): Promise<Record<string, unknown> | null>
    }
    readonly setCapSlice: {
      mutate(input: {
        deviceId: number
        capName: string
        slice: Record<string, unknown>
      }): Promise<void>
    }
  }
  readonly live?: {
    readonly onEvent: {
      subscribe(
        input: { category: string },
        opts: { onData: (evt: { data: unknown }) => void; onError?: (err: unknown) => void },
      ): { unsubscribe: () => void }
    }
  }
}

/**
 * Pluggable state-source contract. `createSliceHandle` is now a thin
 * adapter over this interface — every implementation produces an
 * identical `SliceHandle<T>` shape. Two impls today:
 *
 *   - `createLazyTrpcSource(api)`: per-handle local cache, refresh
 *     via `deviceState.getCapSlice`, subscribe via `live.onEvent`.
 *     Default for browser / SDK clients. A forked addon child MUST NOT
 *     use this: `api.live.onEvent` is a hub-main tRPC subscription and
 *     never declares UDS `eventPatterns`, so `device.state-changed` never
 *     arrives. Use {@link createEventBusSliceSource} there.
 *   - `createEventBusSliceSource({ eventBus, api })`: same cache + RPC
 *     refresh, but the push channel is `ctx.eventBus.subscribe`. That is
 *     what reports `device.state-changed` to the parent, so the UDS fan-out
 *     actually delivers it.
 *   - `createMirrorSource(mirror, listeners)`: reads from a shared
 *     `Map<deviceId, Map<capName, slice>>` populated by a
 *     `SystemManager` warm-boot. Refresh is a no-op; subscribe
 *     registers in a shared listener set that the SystemManager
 *     fans out to on every push event.
 *
 * Both produce the same `SliceHandle<T>` API; consumers don't see
 * which source is behind the handle.
 */
export interface SliceHandleSource {
  /** Sync read of the last-known slice for `(deviceId, capName)`. */
  read(deviceId: number, capName: string): unknown | undefined
  /** Force a re-fetch (where applicable). No-op when the source is
   *  push-only (e.g. the SystemManager mirror). */
  refresh(deviceId: number, capName: string): Promise<void>
  /** Register a listener for slice changes. Returns the unsubscribe
   *  fn. Implementations should fan out the latest cached slice to
   *  the callback synchronously when seeding is desired (the handle
   *  always seeds via a separate `cb(read(...))` call). */
  watch(deviceId: number, capName: string, cb: (slice: unknown | undefined) => void): () => void
  /** Write the slice for `(deviceId, capName)` to the hub via the
   *  canonical `device-state.setCapSlice` entrypoint. Throws if the
   *  source has no write transport (e.g. a mirror source built
   *  without an api reference). */
  write(deviceId: number, capName: string, slice: Record<string, unknown>): Promise<void>
}

const DEVICE_STATE_EVENT_CATEGORY = 'device.state-changed'

/**
 * Minimal bus surface the event-bus slice source needs. Structural so a test
 * fake (and `IEventBus`) both satisfy it without importing the payload map.
 */
export interface SliceEventBus {
  subscribe(
    filter: { readonly category: string },
    handler: (event: { readonly data: unknown }) => void,
  ): () => void
}

/**
 * Lazy tRPC source — the default behavior. Maintains a per-key local
 * cache (`{deviceId}:{capName}` → last slice), one shared
 * `live.onEvent` bridge that fans out into the listener map, and
 * `refresh` round-trips through `deviceState.getCapSlice`.
 *
 * The bridge is opened on first `watch()` and closed when the last
 * watcher unsubscribes — keeps idle handles cheap.
 */
export function createLazyTrpcSource(api: SliceHandleApi): SliceHandleSource {
  const cache = new Map<string, unknown>()
  const listeners = new Map<string, Set<(slice: unknown | undefined) => void>>()
  let bridge: { unsubscribe: () => void } | null = null

  const keyOf = (deviceId: number, capName: string): string => `${deviceId}:${capName}`

  const ensureBridge = (): void => {
    if (bridge) return
    if (!api.live?.onEvent) return
    bridge = api.live.onEvent.subscribe(
      { category: DEVICE_STATE_EVENT_CATEGORY },
      {
        onData: (evt) => {
          const data = evt.data as { deviceId?: number; capName?: string; slice?: unknown } | null
          if (!data || typeof data.deviceId !== 'number' || typeof data.capName !== 'string') return
          const k = keyOf(data.deviceId, data.capName)
          cache.set(k, data.slice)
          const set = listeners.get(k)
          if (!set) return
          for (const cb of set) {
            try {
              cb(data.slice)
            } catch {
              /* listener errors don't break the bridge */
            }
          }
        },
      },
    )
  }

  const closeBridgeIfIdle = (): void => {
    if (!bridge) return
    if (listeners.size > 0) return
    bridge.unsubscribe()
    bridge = null
  }

  return {
    read(deviceId, capName) {
      return cache.get(keyOf(deviceId, capName))
    },
    async refresh(deviceId, capName) {
      const slice = await api.deviceState.getCapSlice.query({ deviceId, capName })
      const k = keyOf(deviceId, capName)
      cache.set(k, slice ?? undefined)
      const set = listeners.get(k)
      if (set) {
        for (const cb of set) {
          try {
            cb(slice ?? undefined)
          } catch {
            /* listener errors don't break refresh */
          }
        }
      }
    },
    watch(deviceId, capName, cb) {
      const k = keyOf(deviceId, capName)
      let set = listeners.get(k)
      if (!set) {
        set = new Set()
        listeners.set(k, set)
      }
      set.add(cb)
      ensureBridge()
      return () => {
        set!.delete(cb)
        if (set!.size === 0) listeners.delete(k)
        closeBridgeIfIdle()
      }
    },
    async write(deviceId, capName, slice) {
      await api.deviceState.setCapSlice.mutate({ deviceId, capName, slice })
    },
  }
}

/**
 * Addon-process slice source — the one that actually reaches a forked child.
 *
 * Identical cache/refresh/write to {@link createLazyTrpcSource}. The push
 * channel is `eventBus.subscribe({ category: 'device.state-changed' })`
 * instead of `api.live.onEvent`. On a UDS child that subscribe is what
 * populates `RegisterMessage.eventPatterns`, which is what the parent's
 * `broadcastEventToChildren` filters on. Without it the child never
 * declares interest and the 30 s `refresh()` timer was the only path a
 * zone edit took to analytics (live, device 102, 2026-07-16).
 */
export function createEventBusSliceSource(deps: {
  readonly eventBus: SliceEventBus
  readonly api: SliceHandleApi
}): SliceHandleSource {
  const { eventBus, api } = deps
  const cache = new Map<string, unknown>()
  const listeners = new Map<string, Set<(slice: unknown | undefined) => void>>()
  let offBus: (() => void) | null = null

  const keyOf = (deviceId: number, capName: string): string => `${deviceId}:${capName}`

  const fanOut = (deviceId: number, capName: string, slice: unknown): void => {
    const k = keyOf(deviceId, capName)
    cache.set(k, slice)
    const set = listeners.get(k)
    if (!set) return
    for (const cb of set) {
      try {
        cb(slice)
      } catch {
        /* listener errors don't break the bridge */
      }
    }
  }

  const ensureBridge = (): void => {
    if (offBus) return
    offBus = eventBus.subscribe({ category: DEVICE_STATE_EVENT_CATEGORY }, (event) => {
      const data = event.data
      if (typeof data !== 'object' || data === null) return
      const deviceId = Reflect.get(data, 'deviceId')
      const capName = Reflect.get(data, 'capName')
      if (typeof deviceId !== 'number' || typeof capName !== 'string') return
      fanOut(deviceId, capName, Reflect.get(data, 'slice'))
    })
  }

  const closeBridgeIfIdle = (): void => {
    if (offBus === null) return
    if (listeners.size > 0) return
    offBus()
    offBus = null
  }

  return {
    read(deviceId, capName) {
      return cache.get(keyOf(deviceId, capName))
    },
    async refresh(deviceId, capName) {
      const slice = await api.deviceState.getCapSlice.query({ deviceId, capName })
      fanOut(deviceId, capName, slice ?? undefined)
    },
    watch(deviceId, capName, cb) {
      const k = keyOf(deviceId, capName)
      let set = listeners.get(k)
      if (!set) {
        set = new Set()
        listeners.set(k, set)
      }
      set.add(cb)
      ensureBridge()
      return () => {
        set!.delete(cb)
        if (set!.size === 0) listeners.delete(k)
        closeBridgeIfIdle()
      }
    },
    async write(deviceId, capName, slice) {
      await api.deviceState.setCapSlice.mutate({ deviceId, capName, slice })
    },
  }
}

/**
 * Mirror source — reads from a shared map populated by a
 * `SystemManager` warm-boot + push event handler. Refresh is a no-op
 * (the SystemManager owns the update loop). `watch()` registers in a
 * shared listener set — the SystemManager calls these from its single
 * `device.state-changed` subscription.
 *
 * The mirror map and listener map are passed in by reference so the
 * SystemManager can mutate both as events arrive.
 */
export function createMirrorSource(
  mirror: ReadonlyMap<number, ReadonlyMap<string, unknown>>,
  listeners: Map<string, Set<(slice: unknown | undefined) => void>>,
  api?: SliceHandleApi,
): SliceHandleSource {
  const keyOf = (deviceId: number, capName: string): string => `${deviceId}:${capName}`
  return {
    read(deviceId, capName) {
      return mirror.get(deviceId)?.get(capName)
    },
    async refresh() {
      // No-op: the mirror is fed by `device.state-changed` events at
      // the SystemManager level. Forcing a re-fetch from a single
      // handle would race with the global update loop and is never
      // what the caller wants.
    },
    watch(deviceId, capName, cb) {
      const k = keyOf(deviceId, capName)
      let set = listeners.get(k)
      if (!set) {
        set = new Set()
        listeners.set(k, set)
      }
      set.add(cb)
      return () => {
        set!.delete(cb)
        if (set!.size === 0) listeners.delete(k)
      }
    },
    async write(deviceId, capName, slice) {
      if (!api) {
        throw new Error(
          'createMirrorSource: write requires an api reference — pass it as the third argument when constructing the source',
        )
      }
      await api.deviceState.setCapSlice.mutate({ deviceId, capName, slice })
    },
  }
}

/**
 * Build a `SliceHandle<T>` bound to `(deviceId, capName)`. Caller
 * provides the type parameter — codegen passes
 * `InferRuntimeState<typeof <cap>>` so consumers see the cap's typed
 * shape:
 *
 *   const dev = createDeviceProxy(api, binding)
 *   dev.state.battery.value           // BatteryStatus | undefined
 *   dev.state.battery.value?.percentage
 *
 * Two-arg form (deprecated path, kept for spec compatibility):
 * passes the api directly, builds a per-handle lazy source. New
 * code should pre-build a single source and reuse it across handles
 * via the explicit `source` form.
 */
export function createSliceHandle<T>(
  source: SliceHandleSource | SliceHandleApi,
  deviceId: number,
  capName: string,
): SliceHandle<T> {
  // Discriminate between source and api by structure: a source has
  // a `read` method, an api has a `deviceState` namespace. Spec-style
  // tests still pass `api`; production codegen passes a source.
  const src: SliceHandleSource = isSource(source) ? source : createLazyTrpcSource(source)

  return {
    get value() {
      return src.read(deviceId, capName) as T | undefined
    },
    refresh() {
      return src.refresh(deviceId, capName)
    },
    subscribe(cb) {
      const unwatch = src.watch(deviceId, capName, (slice) => {
        try {
          cb(slice as T | undefined)
        } catch {
          /* listener errors are isolated */
        }
      })
      // Seed the listener with the current cached read — sync,
      // deterministic, no transport. Mirror sources serve the
      // canonical value here; lazy sources serve their per-key
      // cache (undefined on cold start).
      try {
        cb(src.read(deviceId, capName) as T | undefined)
      } catch {
        /* ignore */
      }
      // Cold-start kick: when the read returned nothing AND the
      // source has a meaningful refresh path (lazy tRPC), pull once
      // in the background. Fan-out via `watch` delivers the result
      // to the same listener — no double-seeding. The mirror
      // source's refresh is a no-op, so this is a cheap miss for
      // SystemManager-backed handles.
      if (src.read(deviceId, capName) === undefined) {
        void src.refresh(deviceId, capName).catch(() => undefined)
      }
      return unwatch
    },
    async set(slice) {
      await src.write(deviceId, capName, slice as Record<string, unknown>)
    },
    async patch(partial) {
      const current = src.read(deviceId, capName) as Record<string, unknown> | undefined
      const next = { ...current, ...(partial as Record<string, unknown>) }
      await src.write(deviceId, capName, next)
    },
  }
}

function isSource(x: SliceHandleSource | SliceHandleApi): x is SliceHandleSource {
  return (
    typeof (x as SliceHandleSource).read === 'function' &&
    typeof (x as SliceHandleSource).watch === 'function'
  )
}

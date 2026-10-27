/**
 * SystemMirror — system-wide reactive view of every device. One
 * warm-boot fetches the
 * full bindings + runtime-state snapshot + device metadata; live
 * `device.state-changed`, `capability.binding-changed`,
 * `device.registered`, `device.unregistered`, and `device.updated`
 * events keep the in-memory mirrors fresh. Subsequent
 * `getDeviceById(id)` calls are sync.
 *
 * Renamed from `SystemManager` (and its file `system-manager.ts`) when
 * the SDK introduced a top-level `System` facade. The cluster-wide
 * mirror is one of `System`'s collaborators — calling it a "mirror"
 * disambiguates from the new public class. The old export name is
 * still available as a deprecated alias from this file.
 *
 * Cap-agnostic by construction: the state mirror is `Map<deviceId,
 * Map<capName, slice>>` and the proxies are produced by the
 * codegen'd `createDeviceProxy` we already use everywhere — so a
 * brand-new cap with `runtimeState:` lights up here without a single
 * line of additional code.
 *
 * Two transports today, same shape:
 *   - tRPC client (browser, Electron, SDK consumers).
 *   - In-process AddonApi (server REPL, addons that want a global view).
 *
 * Boot:
 *
 *   const sm = new SystemMirror(api)
 *   await sm.init()
 *
 *   const dev = sm.getDeviceById(8)            // sync
 *   dev?.state.battery.value?.sleeping         // sync read from mirror
 *   await dev?.snapshot?.getSnapshot({...})    // method dispatch via cap-router
 *
 *   sm.query({ addonId: 'reolink', online: true })
 *   sm.whereState('battery', s => s.level < 20)
 *   sm.listenCap('motion', (id, slice) => …)
 *   await sm.waitForState(8, 'battery', s => !s.sleeping, 30_000)
 *
 * Lifecycle: caller is responsible for `dispose()` when done — closes
 * the live event subscriptions.
 */

import type { DeviceBinding } from './device-binding.js'
import { createDeviceProxy, type DeviceProxy } from '../generated/device-proxy.js'
import type { AddonApi } from '../generated/addon-api.js'
import type { DeviceInfo } from '../capabilities/device-manager.cap.js'
import { DeviceType } from './device-type.js'
import {
  createMirrorSource,
  type SliceHandleApi,
  type SliceHandleSource,
} from './device-state-handle.js'

const STATE_CHANGED_CATEGORY = 'device.state-changed'
const BINDING_CHANGED_CATEGORY = 'capability.binding-changed'
const DEVICE_REGISTERED_CATEGORY = 'device.registered'
const DEVICE_UNREGISTERED_CATEGORY = 'device.unregistered'
const DEVICE_UPDATED_CATEGORY = 'device.updated'

/**
 * Minimal subset of `AddonApi` the SystemMirror needs.
 *
 * The SystemMirror is always constructed with the real tRPC client (see
 * the SDK's `System`), so `getDeviceById` widens it to the full `AddonApi`
 * at a documented boundary for the structural-dispatch `createDeviceProxy`.
 */
export interface SystemMirrorApi extends SliceHandleApi {
  readonly deviceManager: {
    /**
     * Whole-fleet binding dump. WARM BOOT ONLY — 903 ms and 373 KB on a
     * 524-device hub. Anything on the event path uses `getBindings`.
     *
     * `init` gives this 15 s, and on 2026-08-30 it took longer than 240 s on a
     * 1 019-device hub: the server-side resolver read the wrapper-activation
     * blob once PER DEVICE, so answering cost 1 020 settings-door RPCs. Fixed
     * in `device-bindings-store.ts` (two reads for the whole fleet). Worth
     * knowing here because the symptom is always this timeout, and the cause
     * is never in this file.
     */
    readonly getAllBindings: {
      query(input: Record<string, never>): Promise<ReadonlyArray<DeviceBinding>>
    }
    /**
     * Single-device binding read. Required — `refreshBinding` runs once
     * per `capability.binding-changed` and once per `device.registered`,
     * and a full-fleet fetch there is what turned a 20-device Home
     * Assistant adoption into 166 fleet sweeps (see `refreshBinding`).
     */
    readonly getBindings: {
      query(input: { deviceId: number }): Promise<DeviceBinding>
    }
    readonly listAll: {
      query(input: { addonId?: string }): Promise<ReadonlyArray<DeviceInfo>>
    }
    /**
     * Single-device metadata read. Required — `refreshDeviceMetadata`
     * runs once per `device.registered` / `device.updated` event, and a
     * full-catalog fetch there is what melts the hub during a
     * deploy/restart storm (see `refreshDeviceMetadata`).
     */
    readonly getDevice: {
      query(input: { deviceId: number }): Promise<DeviceInfo | null>
    }
  }
  readonly deviceState: SliceHandleApi['deviceState'] & {
    readonly getAllSnapshots: {
      query(
        input: Record<string, never>,
      ): Promise<Record<string, Record<string, Record<string, unknown>>>>
    }
  }
}

export type SystemMirrorListener = (
  deviceId: number,
  capName: string,
  slice: Record<string, unknown> | undefined,
) => void

export type DeviceCapListener = (
  deviceId: number,
  slice: Record<string, unknown> | undefined,
) => void

export type DeviceLifecycleListener = (deviceId: number, info: DeviceInfo | null) => void

/**
 * Match shape — `string` is exact match, `RegExp` is regex match,
 * `{ contains }` is case-insensitive substring, `{ exact }` is the
 * verbose form of plain string. Useful for `query({ name: ... })`
 * where the same field accepts multiple match modes.
 */
export type StringMatch =
  | string
  | RegExp
  | { readonly exact: string }
  | { readonly contains: string }

/**
 * Filter set for `query()`. All fields are optional and ANDed
 * together. Array values are ORed within a single field
 * (`addonId: ['a', 'b']` matches devices owned by either). The
 * `where` escape hatch runs LAST so the structured filters do the
 * cheap rejection first.
 */
export interface DeviceQueryFilters {
  /** Match by exact deviceId. Single value or array (OR'd). */
  readonly id?: number | readonly number[]
  /** Match by exact stableId. Single value or array. */
  readonly stableId?: string | readonly string[]
  /** Match by owning addonId. Single value or array. */
  readonly addonId?: string | readonly string[]
  /** Match by `DeviceType` enum value. Single value or array. */
  readonly type?: DeviceType | readonly DeviceType[]
  /** Match devices that bind ALL listed caps. Single capName or array. */
  readonly caps?: string | readonly string[]
  /** Match devices that bind ANY of the listed caps. Mutually exclusive
   *  with `caps`. */
  readonly anyCap?: string | readonly string[]
  /** Match by device name. */
  readonly name?: StringMatch
  /** Match the `online` flag. */
  readonly online?: boolean
  /** Match by parent device id. Pass `null` for top-level devices. */
  readonly parentDeviceId?: number | null
  /** Match devices that expose a feature (e.g. `'BatteryOperated'`). */
  readonly feature?: string | readonly string[]
  /** Match `isCamera` flag. */
  readonly isCamera?: boolean
  /** Custom predicate. Runs last; receives both metadata and proxy. */
  readonly where?: (info: DeviceInfo, proxy: DeviceProxy) => boolean
}

export class SystemMirror {
  /** deviceId → capName → slice (push-driven mirror). */
  private readonly stateMirror: Map<number, Map<string, Record<string, unknown>>> = new Map()
  /** deviceId → binding (warm-boot + binding-changed events). */
  private readonly bindings: Map<number, DeviceBinding> = new Map()
  /** deviceId → metadata (warm-boot + lifecycle events). */
  private readonly devices: Map<number, DeviceInfo> = new Map()
  /** Listener map for individual `(deviceId, capName)` watches —
   *  shared with every `MirrorSource` we hand out. */
  private readonly handleListeners = new Map<string, Set<(slice: unknown | undefined) => void>>()
  /** Global state-change listeners registered via `listen()`. */
  private readonly globalStateListeners = new Set<SystemMirrorListener>()
  /** Per-cap state listeners registered via `listenCap(capName, …)`. */
  private readonly capListeners = new Map<string, Set<DeviceCapListener>>()
  /** Per-device state listeners registered via `listenDevice(id, …)`. */
  private readonly deviceListeners = new Map<number, Set<SystemMirrorListener>>()
  /** Lifecycle listeners. */
  private readonly addedListeners = new Set<DeviceLifecycleListener>()
  private readonly removedListeners = new Set<DeviceLifecycleListener>()
  /** waitForState pending requests — keyed by an internal counter. */
  private readonly pendingWaits = new Set<{ check: () => boolean; resolve: () => void }>()
  /** Memoised state source — every proxy shares it. */
  private readonly stateSource: SliceHandleSource
  /** Live event bridges — closed in `dispose()`. */
  private bridges: Array<{ unsubscribe: () => void }> = []
  private initialized = false
  private initPromise: Promise<void> | null = null

  constructor(private readonly api: SystemMirrorApi) {
    this.stateSource = createMirrorSource(this.stateMirror, this.handleListeners, this.api)
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Warm-boot: three round-trips (bindings + snapshots + listAll) and
   * then the live event subscriptions. Idempotent — concurrent callers
   * await the same in-flight Promise.
   *
   * Each warm-boot query is wrapped in a 15s timeout so a missing
   * endpoint or stuck broker poll surfaces as a clear error instead
   * of silently hanging the caller forever. The default is generous
   * enough for cluster-wide setups but short enough for ops to
   * notice and fix the underlying transport issue.
   */
  async init(timeoutMs: number = 15_000): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      const withTimeout = <T>(p: Promise<T>, label: string): Promise<T> => {
        if (!Number.isFinite(timeoutMs)) return p
        return new Promise<T>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`SystemMirror.init: '${label}' timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
          p.then(
            (v) => {
              clearTimeout(timer)
              resolve(v)
            },
            (err) => {
              clearTimeout(timer)
              reject(err as Error)
            },
          )
        })
      }

      const [allBindings, allSnapshots, allDevices] = await Promise.all([
        withTimeout(
          this.api.deviceManager.getAllBindings.query({}),
          'deviceManager.getAllBindings',
        ),
        withTimeout(this.api.deviceState.getAllSnapshots.query({}), 'deviceState.getAllSnapshots'),
        // FULL projection, deliberately. `projection: 'slim'` would halve this
        // leg (5.6 s → 2.9 s on a 1 019-device hub) and no consumer reads the
        // fields it drops — but `refreshDeviceMetadata` re-seeds THIS SAME map
        // from `getDevice`, which has no projection parameter and always
        // answers full. A slim warm-boot therefore makes the map
        // heterogeneous: a device that has since emitted `device.registered` /
        // `device.updated` carries its `config`, one that has not carries `{}`,
        // and `dump(id)` hands whichever it happens to hold to the REPL. The
        // cure for the cost was to stop BLOCKING on the warm-boot — see
        // `addon-admin-ui/src/hooks/useBootGate.ts` and D311 — not to shrink
        // one of its three legs.
        withTimeout(this.api.deviceManager.listAll.query({}), 'deviceManager.listAll'),
      ])

      for (const b of allBindings) this.bindings.set(b.deviceId, b)

      for (const [deviceIdStr, perCap] of Object.entries(allSnapshots)) {
        const deviceId = Number(deviceIdStr)
        if (!Number.isFinite(deviceId)) continue
        const capMap = new Map<string, Record<string, unknown>>()
        for (const [capName, slice] of Object.entries(perCap)) capMap.set(capName, slice)
        this.stateMirror.set(deviceId, capMap)
      }

      for (const info of allDevices) this.devices.set(info.id, info)

      // Subscriptions are best-effort — `live.onEvent` may not be
      // wired in some environments (e.g. when the api is a partial
      // adapter). Catch errors so init still completes; the mirror
      // just stops getting live updates instead of hanging the
      // entire REPL/SDK boot.
      try {
        this.subscribeBus()
      } catch (err) {
        // Swallow — `subscribeBus` itself is safe (it checks
        // `api.live?.onEvent`), but defend against transport
        // wrappers that throw on subscribe.
        void err
      }
      this.initialized = true
    })()

    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  /** True after `init()` resolves. */
  isReady(): boolean {
    return this.initialized
  }

  /** Promise that resolves once `init()` has completed. */
  async awaitReady(): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise
    return this.init()
  }

  /**
   * Tear down the event bridges + clear listener registries. Existing
   * proxy references become inert (slice reads keep working off the
   * stale mirror, but no further updates arrive).
   */
  dispose(): void {
    for (const b of this.bridges) {
      try {
        b.unsubscribe()
      } catch {
        /* ignore */
      }
    }
    this.bridges = []
    this.handleListeners.clear()
    this.globalStateListeners.clear()
    this.capListeners.clear()
    this.deviceListeners.clear()
    this.addedListeners.clear()
    this.removedListeners.clear()
    this.pendingWaits.clear()
    this.initialized = false
  }

  // ── Lookup ─────────────────────────────────────────────────────────

  /** Sync lookup by numeric id. `null` if unknown. */
  getDeviceById(deviceId: number): DeviceProxy | null {
    const binding = this.bindings.get(deviceId)
    if (!binding) return null
    // `this.api` is a deliberately MINIMAL subset of `AddonApi` (see
    // `SystemMirrorApi` docs); at runtime it is the full tRPC client (the
    // SDK constructs `SystemMirror` with the real client). `createDeviceProxy`
    // dispatches purely structurally, so widen to `AddonApi` here at the
    // documented boundary (via `unknown` — the Zod-derived AddonApi no longer
    // structurally overlaps the minimal slice enough for a two-leg `as`).
    return createDeviceProxy(this.api as AddonApi, binding, {
      stateSource: this.stateSource,
    })
  }

  /** Sync lookup by display name (exact match). `null` if unknown. */
  getDeviceByName(name: string): DeviceProxy | null {
    for (const info of this.devices.values()) {
      if (info.name === name) return this.getDeviceById(info.id)
    }
    return null
  }

  /** Sync lookup by stableId (the addon-scoped external id). */
  getDeviceByStableId(stableId: string): DeviceProxy | null {
    for (const info of this.devices.values()) {
      if (info.stableId === stableId) return this.getDeviceById(info.id)
    }
    return null
  }

  /** All devices owned by an addon. */
  getDevicesByAddon(addonId: string): readonly DeviceProxy[] {
    return this.query({ addonId })
  }

  /** All devices of a given `DeviceType`. */
  getDevicesByType(type: DeviceType): readonly DeviceProxy[] {
    return this.query({ type })
  }

  /**
   * Live metadata snapshot for a device. Same shape as
   * `deviceManager.getDevice(id)`; sync from the mirror.
   */
  getDeviceInfo(deviceId: number): DeviceInfo | null {
    return this.devices.get(deviceId) ?? null
  }

  /** Snapshot of every known device as a typed proxy. */
  getAllDevices(): readonly DeviceProxy[] {
    const out: DeviceProxy[] = []
    for (const id of this.bindings.keys()) {
      const proxy = this.getDeviceById(id)
      if (proxy) out.push(proxy)
    }
    return out
  }

  /** Filter devices by cap presence — shorthand for `query({caps: capName})`. */
  filterByCap(capName: string): readonly DeviceProxy[] {
    return this.query({ caps: capName })
  }

  // ── Unified query ──────────────────────────────────────────────────

  /**
   * Filter the fleet against a structured filter set. All fields ANDed,
   * arrays ORed within a single field. Returns proxies — chain with
   * cap-method calls or state reads as needed.
   *
   * Examples:
   *
   *   sm.query({ addonId: 'reolink', online: true })
   *   sm.query({ type: DeviceType.Camera, caps: ['snapshot', 'motion'] })
   *   sm.query({ id: [1, 2, 3] })
   *   sm.query({ name: { contains: 'sala' } })
   *   sm.query({ name: /^cam-\d+$/ })
   *   sm.query({ parentDeviceId: 8 })  // accessories of cam 8
   *   sm.query({ where: (info, dev) => dev.state.battery.value?.sleeping })
   */
  query(filters: DeviceQueryFilters = {}): readonly DeviceProxy[] {
    const out: DeviceProxy[] = []
    for (const [deviceId, binding] of this.bindings) {
      const info = this.devices.get(deviceId)
      // Most filters need DeviceInfo. If we don't have it, only `id` /
      // `caps` / `anyCap` filters can resolve — for everything else
      // skip the device. (This window is brief: warm-boot races
      // bindings vs metadata for a few ms.)
      if (filters.id !== undefined && !inSet(deviceId, filters.id)) continue
      if (filters.stableId !== undefined) {
        if (!info) continue
        if (!inSet(info.stableId, filters.stableId)) continue
      }
      if (filters.addonId !== undefined) {
        if (!info) continue
        if (!inSet(info.addonId, filters.addonId)) continue
      }
      if (filters.type !== undefined) {
        if (!info) continue
        if (!inSet(info.type, filters.type)) continue
      }
      if (filters.caps !== undefined) {
        const required = toArray(filters.caps)
        const bound = new Set(binding.entries.map((e) => e.capName))
        if (!required.every((c) => bound.has(c))) continue
      }
      if (filters.anyCap !== undefined) {
        const wanted = toArray(filters.anyCap)
        const bound = new Set(binding.entries.map((e) => e.capName))
        if (!wanted.some((c) => bound.has(c))) continue
      }
      if (filters.name !== undefined) {
        if (!info) continue
        if (!matchesString(info.name, filters.name)) continue
      }
      if (filters.online !== undefined) {
        if (!info) continue
        if (info.online !== filters.online) continue
      }
      if (filters.parentDeviceId !== undefined) {
        if (!info) continue
        const want = filters.parentDeviceId
        const got = info.parentDeviceId ?? null
        if (got !== want) continue
      }
      if (filters.feature !== undefined) {
        if (!info) continue
        const want = toArray(filters.feature)
        if (!want.every((f) => info.features.includes(f))) continue
      }
      if (filters.isCamera !== undefined) {
        if (!info) continue
        if (info.isCamera !== filters.isCamera) continue
      }
      const proxy = this.getDeviceById(deviceId)
      if (!proxy) continue
      if (filters.where && info) {
        if (!filters.where(info, proxy)) continue
      } else if (filters.where && !info) {
        continue
      }
      out.push(proxy)
    }
    return out
  }

  // ── State-driven queries ───────────────────────────────────────────

  /**
   * Return every proxy whose runtime-state slice for `capName` matches
   * `predicate`. Devices without the cap or without a slice are
   * skipped. The predicate receives a typed slice reference — pass
   * the typed cap (e.g. `'battery'`) and TypeScript widens to
   * `Record<string, unknown>`; cast inside the predicate body if the
   * caller knows the cap shape.
   */
  whereState<T extends Record<string, unknown> = Record<string, unknown>>(
    capName: string,
    predicate: (slice: T, deviceId: number) => boolean,
  ): readonly DeviceProxy[] {
    const out: DeviceProxy[] = []
    for (const [deviceId, perCap] of this.stateMirror) {
      const slice = perCap.get(capName) as T | undefined
      if (!slice) continue
      if (!predicate(slice, deviceId)) continue
      const proxy = this.getDeviceById(deviceId)
      if (proxy) out.push(proxy)
    }
    return out
  }

  /** Map every device's slice for `capName` to a derived value. Devices
   *  without the cap or without a slice are skipped. */
  mapState<T extends Record<string, unknown> = Record<string, unknown>, R = unknown>(
    capName: string,
    mapper: (slice: T, deviceId: number) => R,
  ): readonly R[] {
    const out: R[] = []
    for (const [deviceId, perCap] of this.stateMirror) {
      const slice = perCap.get(capName) as T | undefined
      if (!slice) continue
      out.push(mapper(slice, deviceId))
    }
    return out
  }

  /** First device whose slice matches `predicate`, or null. */
  findState<T extends Record<string, unknown> = Record<string, unknown>>(
    capName: string,
    predicate: (slice: T, deviceId: number) => boolean,
  ): DeviceProxy | null {
    for (const [deviceId, perCap] of this.stateMirror) {
      const slice = perCap.get(capName) as T | undefined
      if (!slice) continue
      if (!predicate(slice, deviceId)) continue
      return this.getDeviceById(deviceId)
    }
    return null
  }

  /** Count devices that bind a cap. Faster than `filterByCap(...).length`. */
  countByCap(capName: string): number {
    let n = 0
    for (const binding of this.bindings.values()) {
      if (binding.entries.some((e) => e.capName === capName)) n++
    }
    return n
  }

  /** Count devices whose slice for `capName` matches `predicate`. */
  countByState<T extends Record<string, unknown> = Record<string, unknown>>(
    capName: string,
    predicate: (slice: T, deviceId: number) => boolean,
  ): number {
    let n = 0
    for (const [deviceId, perCap] of this.stateMirror) {
      const slice = perCap.get(capName) as T | undefined
      if (!slice) continue
      if (predicate(slice, deviceId)) n++
    }
    return n
  }

  // ── Listeners ──────────────────────────────────────────────────────

  /**
   * Global listener — fires for every `device.state-changed` event the
   * mirror absorbs.
   */
  listen(cb: SystemMirrorListener): () => void {
    this.globalStateListeners.add(cb)
    return () => {
      this.globalStateListeners.delete(cb)
    }
  }

  /**
   * Per-cap listener — fires only for state changes on `capName`,
   * across every device. The callback receives the deviceId so the
   * caller can route.
   */
  listenCap(capName: string, cb: DeviceCapListener): () => void {
    let set = this.capListeners.get(capName)
    if (!set) {
      set = new Set()
      this.capListeners.set(capName, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.capListeners.delete(capName)
    }
  }

  /**
   * Per-device listener — fires for every cap change on `deviceId`.
   */
  listenDevice(deviceId: number, cb: SystemMirrorListener): () => void {
    let set = this.deviceListeners.get(deviceId)
    if (!set) {
      set = new Set()
      this.deviceListeners.set(deviceId, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
      if (set!.size === 0) this.deviceListeners.delete(deviceId)
    }
  }

  /** Fires when `device.registered` lands. Receives the new metadata. */
  onDeviceAdded(cb: DeviceLifecycleListener): () => void {
    this.addedListeners.add(cb)
    return () => {
      this.addedListeners.delete(cb)
    }
  }

  /** Fires when `device.unregistered` lands. `info` is the LAST-known
   *  metadata (or null if the device was never seen). */
  onDeviceRemoved(cb: DeviceLifecycleListener): () => void {
    this.removedListeners.add(cb)
    return () => {
      this.removedListeners.delete(cb)
    }
  }

  // ── Wait primitives ────────────────────────────────────────────────

  /**
   * Resolve when `predicate` over the runtime-state slice for
   * `(deviceId, capName)` becomes true. Resolves immediately if the
   * current slice already matches. Rejects with `Error('timeout')`
   * after `timeoutMs` (default 30s; pass `Infinity` to wait forever).
   *
   * Returns the matching slice — caller can read it directly without
   * a second mirror lookup.
   */
  waitForState<T extends Record<string, unknown> = Record<string, unknown>>(
    deviceId: number,
    capName: string,
    predicate: (slice: T) => boolean,
    timeoutMs: number = 30_000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = (): T | null => {
        const slice = this.stateMirror.get(deviceId)?.get(capName) as T | undefined
        if (slice && predicate(slice)) return slice
        return null
      }
      const initial = check()
      if (initial) {
        resolve(initial)
        return
      }

      let timer: ReturnType<typeof setTimeout> | null = null
      const off = this.listenDevice(deviceId, (_id, cap, slice) => {
        if (cap !== capName) return
        if (!slice) return
        if (predicate(slice as T)) {
          if (timer) clearTimeout(timer)
          off()
          resolve(slice as T)
        }
      })
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          off()
          reject(
            new Error(
              `waitForState timed out after ${timeoutMs}ms (deviceId=${deviceId}, capName=${capName})`,
            ),
          )
        }, timeoutMs)
      }
    })
  }

  /**
   * Resolve when a device with `deviceId` becomes available (a
   * binding exists). Resolves immediately if already known. Rejects
   * with timeout.
   */
  waitForDevice(deviceId: number, timeoutMs: number = 30_000): Promise<DeviceProxy> {
    return new Promise<DeviceProxy>((resolve, reject) => {
      const existing = this.getDeviceById(deviceId)
      if (existing) {
        resolve(existing)
        return
      }
      let timer: ReturnType<typeof setTimeout> | null = null
      const off = this.onDeviceAdded((id) => {
        if (id !== deviceId) return
        const proxy = this.getDeviceById(id)
        if (!proxy) return
        if (timer) clearTimeout(timer)
        off()
        resolve(proxy)
      })
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          off()
          reject(new Error(`waitForDevice timed out after ${timeoutMs}ms (deviceId=${deviceId})`))
        }, timeoutMs)
      }
    })
  }

  // ── Batch actions ──────────────────────────────────────────────────

  /**
   * Iterate every device that binds `capName`. Awaits each callback
   * sequentially — for parallel use `invokeCap` with explicit
   * parallelism.
   */
  async forEachCap(
    capName: string,
    cb: (proxy: DeviceProxy) => void | Promise<void>,
  ): Promise<void> {
    for (const proxy of this.filterByCap(capName)) {
      await cb(proxy)
    }
  }

  /**
   * Invoke a cap method on every device that binds the cap. Returns
   * one result per device, success or failure isolated. Optional
   * parallelism cap — useful for "snapshot all cameras but only 4
   * at a time so battery cams don't all wake at once".
   *
   * Example:
   *
   *   const results = await sm.invokeCap('snapshot', 'getSnapshot', {}, { parallelism: 4 })
   *   const failed = results.filter(r => !r.ok)
   */
  async invokeCap<R = unknown>(
    capName: string,
    methodName: string,
    args: Record<string, unknown>,
    opts: { parallelism?: number } = {},
  ): Promise<ReadonlyArray<{ deviceId: number; ok: boolean; result?: R; error?: unknown }>> {
    const targets = this.filterByCap(capName)
    const parallelism = Math.max(1, opts.parallelism ?? targets.length)
    const out: Array<{ deviceId: number; ok: boolean; result?: R; error?: unknown }> = []

    for (let i = 0; i < targets.length; i += parallelism) {
      const chunk = targets.slice(i, i + parallelism)
      const settled = await Promise.allSettled(
        chunk.map(async (proxy) => {
          const cap: unknown = Reflect.get(proxy, capName)
          const method =
            typeof cap === 'object' && cap !== null ? Reflect.get(cap, methodName) : undefined
          if (typeof method !== 'function') {
            throw new Error(`device '${proxy.deviceId}' does not expose '${capName}.${methodName}'`)
          }
          return (await Reflect.apply(method, cap, [args])) as R
        }),
      )
      for (let j = 0; j < settled.length; j++) {
        const proxy = chunk[j]!
        const r = settled[j]!
        if (r.status === 'fulfilled') {
          out.push({ deviceId: proxy.deviceId, ok: true, result: r.value })
        } else {
          out.push({ deviceId: proxy.deviceId, ok: false, error: r.reason })
        }
      }
    }

    return out
  }

  // ── Diagnostics ────────────────────────────────────────────────────

  /**
   * One-shot summary — fleet size, breakdown by cap / addon / type.
   * Designed for REPL inspection (`sm.summary()`).
   */
  summary(): {
    totalDevices: number
    online: number
    offline: number
    byCap: Record<string, number>
    byAddon: Record<string, number>
    byType: Record<string, number>
    statedDevices: number
  } {
    const byCap: Record<string, number> = {}
    const byAddon: Record<string, number> = {}
    const byType: Record<string, number> = {}
    let online = 0
    let offline = 0

    for (const binding of this.bindings.values()) {
      for (const entry of binding.entries) {
        byCap[entry.capName] = (byCap[entry.capName] ?? 0) + 1
      }
    }

    for (const info of this.devices.values()) {
      byAddon[info.addonId] = (byAddon[info.addonId] ?? 0) + 1
      byType[info.type] = (byType[info.type] ?? 0) + 1
      if (info.online) online++
      else offline++
    }

    return {
      totalDevices: this.bindings.size,
      online,
      offline,
      byCap,
      byAddon,
      byType,
      statedDevices: this.stateMirror.size,
    }
  }

  /**
   * Debug-friendly dump — full state + binding + metadata for one
   * device or all devices. Cheap deep clone so caller mutations don't
   * leak into the mirror.
   */
  dump(deviceId?: number): unknown {
    const dumpOne = (id: number): unknown => {
      const info = this.devices.get(id) ?? null
      const binding = this.bindings.get(id) ?? null
      const state: Record<string, Record<string, unknown>> = {}
      const perCap = this.stateMirror.get(id)
      if (perCap) {
        for (const [cap, slice] of perCap) state[cap] = { ...slice }
      }
      return {
        deviceId: id,
        info,
        binding: binding ? { ...binding, entries: binding.entries.map((e) => ({ ...e })) } : null,
        state,
      }
    }

    if (deviceId !== undefined) return dumpOne(deviceId)

    const out: unknown[] = []
    for (const id of this.bindings.keys()) out.push(dumpOne(id))
    return out
  }

  /**
   * Direct read-only access to the underlying state mirror. Use
   * sparingly — `getSystemState` returns a deep copy that's safer for
   * exploratory work; this avoids the clone cost when iterating
   * thousands of slices.
   */
  getRawMirror(): ReadonlyMap<number, ReadonlyMap<string, Record<string, unknown>>> {
    return this.stateMirror
  }

  /**
   * Snapshot of the full state mirror — same shape as the warm-boot
   * payload. Deep-cloned; safe to mutate.
   */
  getSystemState(): Map<number, Map<string, Record<string, unknown>>> {
    const copy = new Map<number, Map<string, Record<string, unknown>>>()
    for (const [id, perCap] of this.stateMirror) {
      const dup = new Map<string, Record<string, unknown>>()
      for (const [k, v] of perCap) dup.set(k, { ...v })
      copy.set(id, dup)
    }
    return copy
  }

  // ── Internals ──────────────────────────────────────────────────────

  private subscribeBus(): void {
    if (!this.api.live?.onEvent) return
    const sub = this.api.live.onEvent

    this.bridges.push(
      sub.subscribe(
        { category: STATE_CHANGED_CATEGORY },
        {
          onData: (evt) => {
            const data = evt.data as {
              deviceId?: number
              capName?: string
              slice?: Record<string, unknown>
            } | null
            if (!data || typeof data.deviceId !== 'number' || typeof data.capName !== 'string')
              return
            this.applyStateUpdate(data.deviceId, data.capName, data.slice)
          },
        },
      ),
    )

    this.bridges.push(
      sub.subscribe(
        { category: BINDING_CHANGED_CATEGORY },
        {
          onData: (evt) => {
            const data = evt.data as {
              deviceId?: number
              source?: { type?: string; id?: number | string }
            } | null
            const deviceId =
              typeof data?.deviceId === 'number'
                ? data.deviceId
                : data?.source?.type === 'device' && typeof data.source.id === 'number'
                  ? data.source.id
                  : null
            if (deviceId === null) return
            void this.refreshBinding(deviceId)
          },
        },
      ),
    )

    this.bridges.push(
      sub.subscribe(
        { category: DEVICE_REGISTERED_CATEGORY },
        {
          onData: (evt) => {
            const data = evt.data as { deviceId?: number } | null
            if (typeof data?.deviceId !== 'number') return
            void this.refreshDeviceMetadata(data.deviceId, 'added')
          },
        },
      ),
    )

    this.bridges.push(
      sub.subscribe(
        { category: DEVICE_UNREGISTERED_CATEGORY },
        {
          onData: (evt) => {
            const data = evt.data as { deviceId?: number } | null
            if (typeof data?.deviceId !== 'number') return
            this.applyDeviceRemoval(data.deviceId)
          },
        },
      ),
    )

    this.bridges.push(
      sub.subscribe(
        { category: DEVICE_UPDATED_CATEGORY },
        {
          onData: (evt) => {
            const data = evt.data as { deviceId?: number } | null
            if (typeof data?.deviceId !== 'number') return
            void this.refreshDeviceMetadata(data.deviceId, 'updated')
          },
        },
      ),
    )
  }

  private applyStateUpdate(
    deviceId: number,
    capName: string,
    slice: Record<string, unknown> | undefined,
  ): void {
    let perCap = this.stateMirror.get(deviceId)
    if (!perCap) {
      perCap = new Map()
      this.stateMirror.set(deviceId, perCap)
    }
    if (slice === undefined) {
      perCap.delete(capName)
    } else {
      perCap.set(capName, slice)
    }

    const handleKey = `${deviceId}:${capName}`
    const handleSet = this.handleListeners.get(handleKey)
    if (handleSet) {
      for (const cb of handleSet) {
        try {
          cb(slice)
        } catch {
          /* isolated */
        }
      }
    }

    for (const cb of this.globalStateListeners) {
      try {
        cb(deviceId, capName, slice)
      } catch {
        /* isolated */
      }
    }

    const capSet = this.capListeners.get(capName)
    if (capSet) {
      for (const cb of capSet) {
        try {
          cb(deviceId, slice)
        } catch {
          /* isolated */
        }
      }
    }

    const devSet = this.deviceListeners.get(deviceId)
    if (devSet) {
      for (const cb of devSet) {
        try {
          cb(deviceId, capName, slice)
        } catch {
          /* isolated */
        }
      }
    }
  }

  private applyDeviceRemoval(deviceId: number): void {
    const lastInfo = this.devices.get(deviceId) ?? null
    this.bindings.delete(deviceId)
    this.devices.delete(deviceId)
    this.stateMirror.delete(deviceId)
    for (const cb of this.removedListeners) {
      try {
        cb(deviceId, lastInfo)
      } catch {
        /* isolated */
      }
    }
  }

  /**
   * ONE device's bindings, not the fleet's.
   *
   * This runs on every `capability.binding-changed` AND on every
   * `device.registered`, per mirror. It used to answer that with
   * `getAllBindings` and `.find()` the one row — measured on the live
   * hub (524 devices): 903 ms and 373 KB per call, against 21 ms and
   * 613 bytes for `getBindings({deviceId})`.
   *
   * Adopting 20 Home Assistant devices registers 166 devices (parents +
   * accessories), so an operator with the admin UI open bought 166
   * full-fleet binding sweeps: ~150 s of hub main-thread time inside a
   * 219 s adoption, with every other RPC — including the adoption's own —
   * queued behind them. Same defect, same fix, as `refreshDeviceMetadata`
   * below (`listAll` → `getDevice`).
   *
   * Removal is the destructive direction (every proxy handle a consumer
   * holds goes inert), and an EMPTY binding list is not a claim that the
   * device is gone — a device can legitimately bind nothing. So it needs
   * a second read to agree (D49); `device.unregistered` remains the
   * primary removal path.
   */
  private async refreshBinding(deviceId: number): Promise<void> {
    try {
      const fresh = await this.api.deviceManager.getBindings.query({ deviceId })
      if (fresh.entries.length > 0) {
        this.bindings.set(deviceId, fresh)
        return
      }
      const stillThere = await this.api.deviceManager.getDevice.query({ deviceId })
      if (stillThere === null) {
        // Both reads agree the device is gone — emit the lifecycle hook so
        // consumers clean up. Same path as `device.unregistered` events.
        this.applyDeviceRemoval(deviceId)
        return
      }
      this.bindings.set(deviceId, fresh)
    } catch {
      // Transient failure — leave stale binding; next event retries.
    }
  }

  private async refreshDeviceMetadata(deviceId: number, kind: 'added' | 'updated'): Promise<void> {
    try {
      // ONE device, not the catalog. `listAll` returns the full
      // projection — every device's `config` blob, 286 KB on the live
      // hub — and this runs once per device event PER MIRROR. During a
      // deploy/restart storm every runner re-registers its devices, so
      // the hub answered each event with another full-catalog response;
      // msgpack-encoding those was ~37% of hub-main's main thread and
      // drove the GC sawtooth behind the 60 s UDS timeouts.
      const info = await this.api.deviceManager.getDevice.query({ deviceId })
      if (!info) return

      const wasNew = !this.devices.has(deviceId)
      this.devices.set(deviceId, info)

      if (kind === 'added' && wasNew) {
        // `device.registered` event ran but the bindings/state for
        // the new device may still be in flight from the worker.
        // Refresh bindings so consumers can immediately use the
        // device proxy. Lifecycle listener fires after binding lands.
        await this.refreshBinding(deviceId)
        for (const cb of this.addedListeners) {
          try {
            cb(deviceId, info)
          } catch {
            /* isolated */
          }
        }
      }
    } catch {
      /* transient — next event retries */
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function inSet<T>(value: T, set: T | readonly T[]): boolean {
  if (Array.isArray(set)) return (set as readonly T[]).includes(value)
  return value === set
}

function toArray<T>(value: T | readonly T[]): readonly T[] {
  return Array.isArray(value) ? (value as readonly T[]) : [value as T]
}

function matchesString(haystack: string, match: StringMatch): boolean {
  if (typeof match === 'string') return haystack === match
  if (match instanceof RegExp) return match.test(haystack)
  if ('exact' in match) return haystack === match.exact
  if ('contains' in match) return haystack.toLowerCase().includes(match.contains.toLowerCase())
  return false
}

import { z } from 'zod'

/**
 * Per-device runtime state — cap-keyed. Mutable signals discovered
 * after boot live here, separate from `DeviceConfig` (operator
 * intent) and from `deviceCache` (immutable autodetect / abilities).
 *
 * Shape: `Record<capName, capStateSlice>`. Each slice's schema is
 * declared by the capability itself (`CapabilityDefinition.runtimeState`)
 * so that any provider implementing the cap inherits the same shape —
 * the BatteryStatus shape a Reolink cam emits is the same an ONVIF cam
 * emits, no driver-specific re-declaration.
 *
 * Schemas are registered DYNAMICALLY as the device's caps are
 * installed (see `BaseDevice.registerNativeCap`). A slice without a
 * registered schema is rejected on write — the cap must be wired
 * first. Reads return `undefined` for unknown slices.
 *
 * Persistence: only registered slices round-trip to disk. The kernel
 * layer debounces writes; explicit `flush()` awaits in-flight saves
 * (used by the shutdown hook).
 */
export interface IDeviceRuntimeState {
  /**
   * Read the slice for `capName`. Three overloads, picked by
   * argument shape:
   *
   *   1. Pass a known cap-name literal (`'battery'`, `'motion'`, …)
   *      → return type is auto-inferred from
   *      `CapNameToRuntimeStateMap` (codegen output). No generic
   *      argument, no `as`-cast.
   *   2. Pass a cap-name with an explicit generic
   *      (`getCapState<MyShape>('custom-cap')`) → return that
   *      shape. Used for caps the codegen doesn't see (test-only,
   *      addon-private).
   *   3. Pass a cap-name with no generic (default `Record<string,
   *      unknown>`) → permissive untyped fallback.
   *
   * Returns `undefined` if no slice has been written yet.
   */
  getCapState<
    K extends keyof import('../generated/device-local-state.js').CapNameToRuntimeStateMap,
  >(
    capName: K,
  ): Readonly<import('../generated/device-local-state.js').CapNameToRuntimeStateMap[K]> | undefined
  getCapState<T extends Record<string, unknown> = Record<string, unknown>>(
    capName: string,
  ): Readonly<T> | undefined

  /** Read a single key inside a slice. Convenience for the common
   *  case of reading a primitive (`battery.level`). */
  getCapField(capName: string, key: string): unknown

  /**
   * Replace the slice for `capName`. The schema bound to `capName`
   * (via `installCapSchema`) validates `value`; throws on mismatch.
   * Listeners fire synchronously after the write applies.
   */
  setCapState(capName: string, value: Record<string, unknown>): void

  /**
   * Shallow-merge `partial` into the current slice for `capName`.
   * Re-validates the merged result against the cap's schema.
   */
  patchCapState(capName: string, partial: Record<string, unknown>): void

  /** Subscribe to ALL state changes. Receives the cap names whose
   *  slices changed and the full snapshot. */
  subscribe(cb: (changedCaps: ReadonlyArray<string>, snapshot: Snapshot) => void): () => void

  /** Subscribe to a single cap's slice changes. Fires only when that
   *  cap's slice is touched; ignores writes against other caps. */
  subscribeCap<T extends Record<string, unknown> = Record<string, unknown>>(
    capName: string,
    cb: (slice: Readonly<T> | undefined) => void,
  ): () => void

  /** Frozen snapshot of every cap's slice. Cap names without a
   *  written slice are omitted (sparse). */
  snapshot(): Snapshot

  /** Flush any pending debounced disk writes. */
  flush(): Promise<void>

  /**
   * Register a cap's runtime-state schema. Called by the kernel
   * when `ctx.registerNativeCap(cap, …)` runs and `cap.runtimeState`
   * is defined. Idempotent — repeat installs with the same schema
   * are no-ops; mismatched schemas throw to surface a config bug.
   *
   * Lazily validates any existing in-memory slice for `capName` so
   * a slice loaded from disk before the cap was wired is checked
   * the moment the cap shows up.
   */
  installCapSchema(capName: string, schema: z.ZodObject<z.core.$ZodLooseShape>): void
}

export type Snapshot = Readonly<Record<string, Readonly<Record<string, unknown>>>>

/**
 * Concrete implementation. Routes every successful write through
 * `writer(capName, slice)` — the kernel hooks this up to
 * `device-state.setCapSlice`, the canonical cross-layer write
 * entrypoint, which handles disk persistence (debounced on the hub)
 * and mirror updates.
 *
 * Schema validation runs in-process before the writer is called —
 * the round-trip should never carry an invalid slice. `flush()`
 * awaits any in-flight writer promises so shutdown is lossless.
 *
 * `initial` is the persisted blob loaded at boot. Slices for caps
 * whose schema hasn't been installed yet are kept in-memory verbatim
 * and validated when the cap registers later.
 */
export type RuntimeStateWriter = (capName: string, slice: Record<string, unknown>) => Promise<void>

/**
 * Called when the hub REFUSES a write (the slice is not mirrored). The device
 * logs it; the state re-sends the cap's next write even when the value is
 * unchanged, so a refusal is never final (D391, ruling S6).
 */
export type RuntimeStateWriteFailed = (capName: string, error: string) => void

export class DeviceRuntimeState implements IDeviceRuntimeState {
  private readonly writer: RuntimeStateWriter
  private readonly onWriteFailed: RuntimeStateWriteFailed | undefined
  /** In-flight writer promises tracked so `flush()` can await them. */
  private readonly pendingWrites = new Set<Promise<unknown>>()
  /**
   * Caps whose last write the hub refused. The equality gate in
   * `applyCapWrite` is bypassed for these, so the SAME value is re-sent on the
   * next write instead of being swallowed forever; a landing write clears it.
   */
  private readonly failedWrites = new Set<string>()
  /** Per-cap committed slice — after schema validation when known. */
  private slices: Map<string, Record<string, unknown>>
  /** Per-cap registered schema (set by `installCapSchema`). */
  private readonly schemas = new Map<string, z.ZodObject<z.core.$ZodLooseShape>>()
  private readonly listeners = new Set<(changed: ReadonlyArray<string>, snap: Snapshot) => void>()
  private readonly capListeners = new Map<
    string,
    Set<(slice: Readonly<Record<string, unknown>> | undefined) => void>
  >()

  private constructor(
    initial: Record<string, unknown>,
    writer: RuntimeStateWriter,
    onWriteFailed: RuntimeStateWriteFailed | undefined,
  ) {
    this.writer = writer
    this.onWriteFailed = onWriteFailed
    // Hydrate slices: every top-level key in `initial` is a cap name,
    // its value should be an object. Non-object values are dropped
    // with no error — the persisted blob is owned by us, so a
    // garbage shape is a kernel bug we'd rather surface elsewhere.
    this.slices = new Map()
    for (const [k, v] of Object.entries(initial)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        this.slices.set(k, { ...(v as Record<string, unknown>) })
      }
    }
  }

  static fromInitial(
    initial: Record<string, unknown>,
    writer: RuntimeStateWriter,
    onWriteFailed?: RuntimeStateWriteFailed,
  ): DeviceRuntimeState {
    return new DeviceRuntimeState(initial, writer, onWriteFailed)
  }

  installCapSchema(capName: string, schema: z.ZodObject<z.core.$ZodLooseShape>): void {
    const existing = this.schemas.get(capName)
    if (existing) {
      // Idempotent: caps register multiple times during the device's
      // lifetime (constructor + post-login retroactive registration).
      // Ignore identical re-registrations; a different schema for the
      // same cap is a programming error worth throwing on.
      if (existing !== schema) {
        throw new Error(
          `[DeviceRuntimeState] capability "${capName}" registered a different runtime-state schema; ` +
            `each cap must declare ONE shape across every provider`,
        )
      }
      return
    }
    this.schemas.set(capName, schema)
    // Validate any pre-loaded slice now that we have the schema.
    // Reject silently and clear: the persisted blob shouldn't crash
    // the device on boot, just lose stale data the schema rejects.
    const stored = this.slices.get(capName)
    if (stored) {
      const result = schema.safeParse(stored)
      if (result.success) {
        this.slices.set(capName, result.data as Record<string, unknown>)
      } else {
        this.slices.delete(capName)
      }
    }
  }

  getCapState<T extends Record<string, unknown> = Record<string, unknown>>(
    capName: string,
  ): Readonly<T> | undefined {
    const slice = this.slices.get(capName)
    if (!slice) return undefined
    return Object.freeze({ ...slice }) as Readonly<T>
  }

  getCapField(capName: string, key: string): unknown {
    return this.slices.get(capName)?.[key]
  }

  setCapState(capName: string, value: Record<string, unknown>): void {
    this.applyCapWrite(capName, value, /* merge */ false)
  }

  patchCapState(capName: string, partial: Record<string, unknown>): void {
    this.applyCapWrite(capName, partial, /* merge */ true)
  }

  /**
   * Internal worker. `merge` controls whether `value` replaces or
   * shallow-merges into the existing slice. Schema validation runs
   * on the FINAL composed object regardless.
   */
  private applyCapWrite(capName: string, value: Record<string, unknown>, merge: boolean): void {
    const schema = this.schemas.get(capName)
    if (!schema) {
      // Refuse: a cap without a registered schema can't have its
      // slice written. Drivers that legitimately need extra
      // ad-hoc state should attach a `runtimeState` schema to the
      // cap definition. The strict refusal catches typos
      // (`'batery'` vs `'battery'`) loudly.
      throw new Error(
        `[DeviceRuntimeState] no schema registered for cap "${capName}" — ` +
          `did the device register it via ctx.registerNativeCap before writing?`,
      )
    }
    const current = this.slices.get(capName) ?? {}
    const next = merge ? { ...current, ...value } : { ...value }
    const parsed = schema.parse(next) as Record<string, unknown>
    // Equality check before commit — back-to-back identical writes
    // (e.g. battery push every minute with the same level)
    // should NOT churn listeners or disk. Unless the hub REFUSED the
    // last write of this cap: the slice is not mirrored, so the same
    // value must go out again (ruling S6).
    if (shallowEqual(current, parsed) && !this.failedWrites.has(capName)) return
    this.slices.set(capName, parsed)
    this.fireListeners([capName])
    // Kick off the write asynchronously — schema validation already
    // ran, so failure here means a transport / hub issue, or the hub
    // refusing to apply a native write before it knows whether a claim
    // governs it (D49). It is not thrown — `setCapState` is
    // fire-and-forget — but it is never swallowed either (D391): the
    // cap is marked failed and the owner is told.
    const writePromise = this.writer(capName, { ...parsed })
      .then(() => {
        this.failedWrites.delete(capName)
      })
      .catch((err: unknown) => {
        this.failedWrites.add(capName)
        this.onWriteFailed?.(capName, err instanceof Error ? err.message : String(err))
      })
    this.pendingWrites.add(writePromise)
    void writePromise.finally(() => {
      this.pendingWrites.delete(writePromise)
    })
  }

  private fireListeners(changed: ReadonlyArray<string>): void {
    const snap = this.snapshot()
    for (const cb of this.listeners) {
      try {
        cb(changed, snap)
      } catch {
        /* listener errors don't break the writer */
      }
    }
    for (const capName of changed) {
      const subs = this.capListeners.get(capName)
      if (!subs) continue
      const slice = this.getCapState(capName)
      for (const cb of subs) {
        try {
          cb(slice)
        } catch {
          /* idem */
        }
      }
    }
  }

  subscribe(cb: (changed: ReadonlyArray<string>, snap: Snapshot) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  subscribeCap<T extends Record<string, unknown> = Record<string, unknown>>(
    capName: string,
    cb: (slice: Readonly<T> | undefined) => void,
  ): () => void {
    let subs = this.capListeners.get(capName)
    if (!subs) {
      subs = new Set()
      this.capListeners.set(capName, subs)
    }
    const adapter = (slice: Readonly<Record<string, unknown>> | undefined): void => {
      cb(slice as Readonly<T> | undefined)
    }
    subs.add(adapter)
    return () => {
      const set = this.capListeners.get(capName)
      if (!set) return
      set.delete(adapter)
      if (set.size === 0) this.capListeners.delete(capName)
    }
  }

  snapshot(): Snapshot {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [k, v] of this.slices) out[k] = Object.freeze({ ...v })
    return Object.freeze(out) as Snapshot
  }

  async flush(): Promise<void> {
    if (this.pendingWrites.size === 0) return
    // Snapshot the current set so writes added while we await
    // (e.g. listeners that re-trigger setCapState) settle in a
    // separate flush round if the caller wants strict drainage.
    const inflight = [...this.pendingWrites]
    await Promise.allSettled(inflight)
  }
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if (a[k] !== b[k]) return false
  }
  return true
}

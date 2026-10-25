/**
 * What a composition's sources currently say, per source device and per cap
 * (D659).
 *
 * Fed by the events sources ALREADY emit (`device.state-changed`,
 * `device.unregistered`, `device.bindings-changed`). It never polls and arms no
 * timer. It reads the hub only to HYDRATE a source it has not resolved yet (on
 * `sync`, driven by the supervisor's existing converge), to CONFIRM a
 * destructive verdict, and to RECONCILE when the source device (re)registers.
 * A source once resolved is not re-read by `sync`: its values arrive by
 * `device.state-changed`. Events are telemetry and may be dropped (D8), so the
 * reconcile point is the one the source itself raises: a
 * `device.bindings-changed` for a cap it serves (`native-registered` on a
 * provider restart, a wrapper toggle) re-reads that cap — and `device-status`
 * re-reads `online` — and a source found under a NEW id after an unregister is
 * re-read at once. No timer, no poll (R7c).
 *
 *  - fresh: the last value, from a device that is online;
 *  - stale: the last value, while the device is offline or a re-read
 *    flickered. Nothing is destroyed (D49);
 *  - unavailable: no value — never a number that looks plausible (D393). A cap
 *    the provider unregistered is unavailable, NOT stale (spec §2), and so is a
 *    cap absent from the bindings of a device whose ROW exists: after a hub
 *    restart or a provider respawn the bindings are empty until the provider
 *    re-registers, and two back-to-back binding reads are one correlated read.
 *    `fatal` only when the source DEVICE is GONE and two index reads agreed.
 *    Fatal is sticky: only an operator reset ends it (no auto-repair, 2026-08-08).
 *
 * A re-read that answers "no report" never replaces a value already held: the
 * value is kept, marked stale with the reason (D49 — one empty read is not
 * proof). Only `native-unregistered` takes a value away (R7b).
 *
 * Every entry point runs on ONE promise chain (R3): `sync` builds its next map
 * across awaits, and an event that landed mid-way used to be overwritten when
 * that map was assigned. `read` is synchronous, from the last settled map.
 *
 * D224 (R7d): what is held here is the INPUT of a field the composition owns.
 * It is served to nobody else — no cap method, no getter for another addon
 * reads this map; the composed device's slice is the only output. A consumer
 * that wants a source's value asks the addon that owns that source.
 *
 * Slice 2 (D663): a cap is read in one of two VIEWS. The `effective` view is
 * what every consumer sees. The `native` view is what the provider wrote — the
 * shadow under a `replace` claim — and it is how a composition reads its OWN
 * target's fields without seeing its own output (rule 6, no self-cycle). The hub
 * emits the shadow (`device.native-shadow-changed`, owner-only) only for a cap
 * under a claim, and for an unclaimed cap `device.state-changed` IS the native;
 * so a native-view cap under the block's OWN claim ignores `device.state-changed`,
 * and one it does not takes it. What is held is what LANDED (`claimEvent`, the
 * boot seed), never what a plan wants (C-1); while the block's claim RPC is in
 * flight, `device.state-changed` is neither (N-1). Every claim or release reply
 * re-reads the native once — the read that closes the window between the RPC
 * and its answer (N-4). The target ROW is resolved through the same path as a
 * source (`resolve`): one list read, two agreeing absent reads to call it
 * missing, sticky until an operator reset.
 *
 * An unavailability is CONFIRMED only when it is an answer (D49, fix round 2):
 * a GONE row (two reads agreed), a cap the provider unregistered that a
 * bindings re-read agrees is unbound, a field the source reported without. A
 * failed read (`unread`, retried by the next `sync` — the converge is the
 * retry), a first read that finds the cap unbound, an empty read, a source not
 * tracked yet: unconfirmed. Only a confirmed one lets a `release`-mode field
 * hand its claim back; an unconfirmed one holds it on its last value.
 */
import {
  type CompositionFieldRead,
  type CompositionSourceRef,
  compositionSliceKey,
  compositionSourceKey,
  type FieldClaim,
  type SourceReading,
  toExpressionValue,
} from '@camstack/types'
import { type ClaimEvent, HeldClaims } from './held-claims.js'
import {
  type BindingVerdict,
  type CapEntry,
  type CapReading,
  DEVICE_STATUS_CAP,
  entriesOf,
  entryKey,
  entryOf,
  findRow,
  NO_CAPS,
  onlineOf,
  type Resolution,
  resolutionOf,
  type SliceView,
  type SourceBindingsChangeReason,
  type SourceFound,
  type SourceListRead,
  type SourceResolution,
  type SourceTrackerPorts,
  type TrackedSource,
  type TrackedSourceRequest,
  valueAtPath,
} from './source-readings.js'

export type {
  BoundCaps,
  BoundCapsRead,
  SliceFound,
  SliceNone,
  SliceRead,
  SliceView,
  SourceBindingsChangeReason,
  SourceFound,
  SourceListRead,
  SourceMissing,
  SourceResolution,
  SourceRow,
  SourceRowsRead,
  SourceTrackerPorts,
  SourceUnknown,
  SourceUnreadable,
  TrackedSourceRequest,
} from './source-readings.js'

export class SourceTracker {
  private sources: ReadonlyMap<string, TrackedSource> = new Map()
  /** The claims the hub holds — what LANDED, never what a plan wants (C-1). */
  private readonly held = new HeldClaims()
  /** The one chain every entry point joins (R3); the pattern is `BlockSupervisor.inFlight`. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly ports: SourceTrackerPorts) {}

  /**
   * Track exactly `requests`. Hydrate what is new or unresolved; keep what is
   * known. `reset` names source keys an OPERATOR action re-opens (a block edit
   * or restart): only those lose a sticky `missing`.
   */
  sync(
    requests: readonly TrackedSourceRequest[],
    reset: ReadonlySet<string>,
  ): Promise<ReadonlySet<string>> {
    return this.serialized(() => this.syncNow(requests, reset))
  }

  /**
   * Resolve a ref against the device index through the same path as a source
   * (D663 rule 1): one list read; two agreeing absent reads make it `missing`,
   * sticky until `reset` (an operator edit or restart). A source already
   * resolved is answered from memory; one whose index read FAILED is read
   * again. The bare source stays tracked, so a later `sync` that names it keeps
   * its resolution and reads only the caps it asks for.
   */
  resolve(ref: CompositionSourceRef, reset: boolean): Promise<SourceResolution> {
    return this.serialized(async () => {
      const k = compositionSourceKey(ref)
      const prior = this.sources.get(k)
      const before = reset ? undefined : prior
      if (before !== undefined && (before.deviceId !== null || before.missingReason !== null))
        return resolutionOf(before)
      const after = await this.hydrate({ ref, caps: [] }, before, new Map())
      // A reset re-resolves the ROW; it must not publish a bare entry mid-apply.
      // Every reading held for the same device id stays — a room block's read
      // of that device, the old runtime's native read — and keeps arriving by
      // event (M-2). A device found under another id starts empty.
      const kept =
        prior !== undefined && after.deviceId !== null && prior.deviceId === after.deviceId
          ? { ...after, caps: prior.caps, online: prior.online }
          : after
      this.sources = new Map([...this.sources, [k, kept]])
      return resolutionOf(kept)
    })
  }

  /** The claims the hub held at boot (the claims index seed). Nothing is read: no native self-read is tracked before it. */
  seedClaims(claims: readonly FieldClaim[]): void {
    this.held.seed(claims)
  }

  /**
   * A claim RPC of `owner` on `(deviceId, cap)`: dispatched (`claiming`), or
   * answered — the hub holds it (`held`), holds none of it (`free`), or said
   * nothing that changes it (`unsettled`). Every ANSWER re-reads the owner's
   * native-view readings of that cap ONCE: while the RPC was in flight (or a
   * release was being applied) the provider's writes arrived as a
   * `device.state-changed` the tracker could not take as the native.
   */
  claimEvent(
    deviceId: number,
    cap: string,
    owner: string,
    event: ClaimEvent,
  ): Promise<ReadonlySet<string>> {
    return this.serialized(async () => {
      this.held.apply(deviceId, cap, owner, event)
      if (event === 'claiming') return new Set<string>()
      return this.rereadNative(deviceId, cap, owner)
    })
  }

  /** The last settled resolution of a ref; `unknown` when it was never resolved. Synchronous, from memory. */
  resolution(ref: CompositionSourceRef): SourceResolution {
    const source = this.sources.get(compositionSourceKey(ref))
    return source === undefined
      ? { kind: 'unknown', error: `source \`${compositionSourceKey(ref)}\` is not tracked` }
      : resolutionOf(source)
  }

  onStateChanged(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
  ): Promise<ReadonlySet<string>> {
    return this.serialized(async () => this.applyStateChanged(deviceId, capName, slice))
  }

  /** `device.native-shadow-changed`: the provider's own slice of a cap under a claim (owner-only, D224). */
  onNativeChanged(
    deviceId: number,
    capName: string,
    native: Readonly<Record<string, unknown>>,
  ): Promise<ReadonlySet<string>> {
    return this.serialized(async () => this.applyNativeChanged(deviceId, capName, native))
  }

  onDeviceUnregistered(deviceId: number): Promise<ReadonlySet<string>> {
    return this.serialized(() => this.confirmUnregistered(deviceId))
  }

  onBindingsChanged(
    deviceId: number,
    capName: string,
    reason: SourceBindingsChangeReason,
  ): Promise<ReadonlySet<string>> {
    return this.serialized(() => this.applyBindingsChanged(deviceId, capName, reason))
  }

  /** Run `work` after everything already queued, whether that settled or failed; never let one failure stall the chain. */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async syncNow(
    requests: readonly TrackedSourceRequest[],
    reset: ReadonlySet<string>,
  ): Promise<ReadonlySet<string>> {
    const merged = new Map<string, TrackedSourceRequest>()
    for (const request of requests) {
      const k = compositionSourceKey(request.ref)
      const prior = merged.get(k)
      merged.set(k, {
        ref: request.ref,
        caps: [...new Set([...(prior?.caps ?? []), ...request.caps])],
        nativeCaps: [
          ...new Set([...(prior?.nativeCaps ?? []), ...(request.nativeCaps ?? NO_CAPS)]),
        ],
        ...((request.nativeOwner ?? prior?.nativeOwner) === undefined
          ? {}
          : { nativeOwner: request.nativeOwner ?? prior?.nativeOwner }),
      })
    }
    const lists = new Map<string, SourceListRead>()
    const next = new Map<string, TrackedSource>()
    const changed = new Set<string>()
    for (const [k, request] of merged) {
      const before = reset.has(k) ? undefined : this.sources.get(k)
      const after = await this.hydrate(request, before, lists)
      next.set(k, after)
      for (const entry of entriesOf(request)) {
        const key = entryKey(entry)
        if (
          before?.caps.get(key) !== after.caps.get(key) ||
          before?.missingReason !== after.missingReason
        ) {
          changed.add(compositionSliceKey(request.ref, entry.cap))
        }
      }
    }
    this.sources = next
    return changed
  }

  read(read: CompositionFieldRead, view: SliceView = 'effective'): SourceReading {
    const label = `${compositionSourceKey(read.source)} ${read.cap}.${read.fieldPath}`
    const tracked = this.sources.get(compositionSourceKey(read.source))
    if (tracked === undefined)
      return { state: 'unavailable', reason: `${label}: not tracked yet`, fatal: false }
    if (tracked.missingReason !== null)
      return { state: 'unavailable', reason: tracked.missingReason, fatal: true }
    const cap = tracked.caps.get(entryKey({ cap: read.cap, view }))
    if (cap === undefined)
      return { state: 'unavailable', reason: `${label}: not tracked yet`, fatal: false }
    if (cap.kind !== 'slice') {
      // Only an unregistration a re-read agreed with is an answer (D49).
      const confirmed = cap.kind === 'none' && cap.confirmed
      return { state: 'unavailable', reason: `${label}: ${cap.reason}`, fatal: false, confirmed }
    }
    const value = toExpressionValue(valueAtPath(cap.slice, read.fieldPath))
    if (value === undefined) {
      // The source REPORTED the cap without it: that is an answer.
      return {
        state: 'unavailable',
        reason: `${label}: the field is absent or not a scalar`,
        fatal: false,
        confirmed: true,
      }
    }
    if (cap.staleReason !== null) return { state: 'stale', value, reason: cap.staleReason }
    if (tracked.online === false)
      return { state: 'stale', value, reason: 'the source device is offline' }
    return { state: 'fresh', value }
  }

  private applyStateChanged(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
  ): ReadonlySet<string> {
    const changed = new Set<string>()
    const next = new Map(this.sources)
    for (const [k, source] of this.sources) {
      if (source.deviceId !== deviceId || source.missingReason !== null) continue
      let updated = source
      if (capName === DEVICE_STATUS_CAP) {
        const online = onlineOf(slice)
        if (online !== source.online) {
          updated = { ...updated, online }
          for (const key of source.caps.keys())
            changed.add(compositionSliceKey(source.ref, entryOf(key).cap))
        }
      }
      // The merge every consumer sees IS the native for a cap under no claim; for
      // a cap whose claim has LANDED it is the composition's own output (rule 6).
      const views: readonly SliceView[] =
        source.nativeOwner !== null &&
        this.held.shadowsNative(deviceId, capName, source.nativeOwner)
          ? ['effective']
          : ['effective', 'native']
      for (const view of views) {
        const key = entryKey({ cap: capName, view })
        const current = source.caps.get(key)
        if (current === undefined) continue
        if (current.kind === 'unbound') this.logHealed(deviceId, capName, 'device.state-changed')
        updated = {
          ...updated,
          caps: new Map([...updated.caps, [key, { kind: 'slice', slice, staleReason: null }]]),
        }
        changed.add(compositionSliceKey(source.ref, capName))
      }
      if (updated !== source) next.set(k, updated)
    }
    this.sources = next
    return changed
  }

  private applyNativeChanged(
    deviceId: number,
    capName: string,
    native: Readonly<Record<string, unknown>>,
  ): ReadonlySet<string> {
    const changed = new Set<string>()
    const next = new Map(this.sources)
    const key = entryKey({ cap: capName, view: 'native' })
    for (const [k, source] of this.sources) {
      if (source.deviceId !== deviceId || source.missingReason !== null) continue
      const current = source.caps.get(key)
      if (current === undefined) continue
      if (current.kind === 'unbound')
        this.logHealed(deviceId, capName, 'device.native-shadow-changed')
      next.set(k, {
        ...source,
        caps: new Map([...source.caps, [key, { kind: 'slice', slice: native, staleReason: null }]]),
      })
      changed.add(compositionSliceKey(source.ref, capName))
    }
    this.sources = next
    return changed
  }

  private async confirmUnregistered(deviceId: number): Promise<ReadonlySet<string>> {
    const changed = new Set<string>()
    for (const [k, source] of this.sources) {
      if (source.deviceId !== deviceId || source.missingReason !== null) continue
      const resolution = await this.resolveConfirmed(source.ref, undefined)
      if (resolution.kind === 'unknown') {
        this.ports.logger.warn(
          'composition source: could not confirm a removal — nothing changes',
          {
            tags: { deviceId },
            meta: { source: k, error: resolution.error },
          },
        )
        continue
      }
      if (resolution.kind === 'found' && resolution.deviceId === deviceId) continue
      const next: TrackedSource =
        resolution.kind === 'missing'
          ? {
              ...source,
              deviceId: null,
              type: null,
              missingReason: `source \`${k}\` (device ${deviceId}) was removed — two reads agreed`,
            }
          : await this.rereadUnderNewId(source, resolution)
      this.ports.logger.warn(
        resolution.kind === 'missing'
          ? 'composition source removed — its fields are unavailable until the operator acts'
          : 'composition source re-registered under a new id — re-read under it',
        {
          tags: { deviceId },
          meta: {
            source: k,
            ...(resolution.kind === 'found' ? { newDeviceId: resolution.deviceId } : {}),
          },
        },
      )
      this.sources = new Map([...this.sources, [k, next]])
      for (const key of source.caps.keys())
        changed.add(compositionSliceKey(source.ref, entryOf(key).cap))
    }
    return changed
  }

  private async applyBindingsChanged(
    deviceId: number,
    capName: string,
    reason: SourceBindingsChangeReason,
  ): Promise<ReadonlySet<string>> {
    const changed = new Set<string>()
    // An unregistration is CONFIRMED by one bindings re-read, once per event (D49).
    let confirm: BindingVerdict | null = null
    for (const [k, source] of this.sources) {
      if (source.deviceId !== deviceId || source.missingReason !== null) continue
      const entries: readonly CapEntry[] = [
        { cap: capName, view: 'effective' },
        { cap: capName, view: 'native' },
      ]
      let updated = source
      let healed = false
      for (const entry of entries) {
        const key = entryKey(entry)
        const current = source.caps.get(key)
        if (current === undefined) continue
        if (reason === 'native-unregistered') {
          // Spec §2: a cap removed is UNAVAILABLE, never a stale number (D393). Not
          // fatal — a provider restart looks exactly like this, and `native-registered`
          // re-reads it. Fatal belongs to a GONE device row only (R7b). Confirmed only
          // when a bindings re-read agrees; still bound → the event is stale, re-read.
          confirm ??= (await this.readBindings(deviceId, [capName])).get(capName) ?? 'unknown'
          const reading: CapReading =
            confirm === 'bound'
              ? await this.readCap(deviceId, entry, 'bound', current)
              : {
                  kind: 'none',
                  reason:
                    confirm === 'unbound'
                      ? `the provider unregistered \`${capName}\` — a bindings re-read agreed; no value until it registers again`
                      : `the provider unregistered \`${capName}\` — not confirmed (the bindings re-read failed); no value, nothing released`,
                  confirmed: confirm === 'unbound',
                }
          updated = { ...updated, caps: new Map([...updated.caps, [key, reading]]) }
          continue
        }
        // The source (re)registered or re-bound the cap: the reconcile point for
        // any `device.state-changed` the bus dropped meanwhile (R7c, D8). An
        // empty answer keeps a held value (`readCap`), so this never destroys.
        const reading = await this.readCap(deviceId, entry, 'bound', current)
        updated = { ...updated, caps: new Map([...updated.caps, [key, reading]]) }
        if (current.kind === 'unbound' && reading.kind !== 'unbound') healed = true
      }
      if (healed) this.logHealed(deviceId, capName, reason)
      if (reason !== 'native-unregistered' && capName === DEVICE_STATUS_CAP) {
        // One read of `device-status` serves both the tracked cap and `online`.
        const reading = updated.caps.get(entryKey({ cap: capName, view: 'effective' }))
        const online =
          reading === undefined
            ? await this.readOnline(deviceId)
            : reading.kind === 'slice'
              ? onlineOf(reading.slice)
              : null
        if (online !== null && online !== source.online) {
          updated = { ...updated, online }
          for (const key of source.caps.keys())
            changed.add(compositionSliceKey(source.ref, entryOf(key).cap))
        }
      }
      if (updated === source) continue
      this.sources = new Map([...this.sources, [k, updated]])
      if (updated.caps !== source.caps) changed.add(compositionSliceKey(source.ref, capName))
    }
    return changed
  }

  /** A source found under a NEW id is a re-registration: read it there now (R7c). */
  private async rereadUnderNewId(
    source: TrackedSource,
    found: SourceFound,
  ): Promise<TrackedSource> {
    const caps = new Map<string, CapReading>()
    for (const [key, prior] of source.caps) {
      caps.set(key, await this.readCap(found.deviceId, entryOf(key), 'bound', prior))
    }
    // A failed read changes nothing: an unknown `online` keeps the last one.
    const online = (await this.readOnline(found.deviceId)) ?? source.online
    return { ...source, deviceId: found.deviceId, type: found.type, online, caps }
  }

  private async hydrate(
    request: TrackedSourceRequest,
    before: TrackedSource | undefined,
    lists: Map<string, SourceListRead>,
  ): Promise<TrackedSource> {
    const entries = entriesOf(request)
    // Sticky-missing is never re-read: only an operator reset ends it.
    if (before !== undefined && before.missingReason !== null) return before
    // A source already RESOLVED is not re-read (R7c): a cap it has not reported
    // yet arrives by `device.state-changed`, a cap it lost by `native-registered`,
    // its `online` by `device-status`. Only a cap it was not asked for before is
    // read now — otherwise a second composition over the same source would wait
    // forever on a cap nobody follows — and one whose read FAILED (`unread`):
    // the converge is its retry (D49).
    if (before !== undefined && before.deviceId !== null) {
      const toRead = entries.filter((entry) => {
        const held = before.caps.get(entryKey(entry))
        return held === undefined || held.kind === 'unread'
      })
      const nativeOwner = request.nativeOwner ?? null
      if (
        toRead.length === 0 &&
        entries.length === before.caps.size &&
        nativeOwner === before.nativeOwner
      )
        return before
      const caps = await this.readCaps(before.deviceId, entries, before.caps, toRead)
      return { ...before, caps, nativeOwner }
    }
    // The only source read again is one whose index read FAILED (`deviceId`
    // null, not missing) — retried on the next apply, never on a timer.
    const k = compositionSourceKey(request.ref)
    const first =
      lists.get(request.ref.addonId) ?? (await this.ports.listDevicesOf(request.ref.addonId))
    lists.set(request.ref.addonId, first)
    const resolution = await this.resolveConfirmed(request.ref, first)
    if (resolution.kind === 'missing') {
      this.ports.logger.warn('composition source does not exist — two reads agreed', {
        meta: { source: k },
      })
      return {
        ref: request.ref,
        deviceId: null,
        type: null,
        missingReason: `source \`${k}\` does not exist — two reads agreed`,
        indexError: null,
        online: null,
        caps: new Map(),
        nativeOwner: request.nativeOwner ?? null,
      }
    }
    if (resolution.kind === 'unknown') {
      this.ports.logger.warn(
        'composition source: the device index could not be read — its fields are unavailable until the next apply',
        { meta: { source: k, error: resolution.error } },
      )
      return {
        ref: request.ref,
        deviceId: null,
        type: null,
        missingReason: null,
        indexError: resolution.error,
        online: null,
        caps: new Map(
          entries.map((entry) => [
            entryKey(entry),
            { kind: 'unread', reason: `the source could not be resolved: ${resolution.error}` },
          ]),
        ),
        nativeOwner: request.nativeOwner ?? null,
      }
    }
    const known = before?.caps ?? new Map<string, CapReading>()
    const toRead = entries.filter((entry) => known.get(entryKey(entry))?.kind !== 'slice')
    const caps = await this.readCaps(resolution.deviceId, entries, known, toRead)
    const online = before?.online ?? (await this.readOnline(resolution.deviceId))
    return {
      ref: request.ref,
      deviceId: resolution.deviceId,
      type: resolution.type,
      missingReason: null,
      indexError: null,
      online,
      caps,
      nativeOwner: request.nativeOwner ?? null,
    }
  }

  /** Read `toRead` (bindings first, then slices); every other requested entry keeps what `known` holds. */
  private async readCaps(
    deviceId: number,
    requested: readonly CapEntry[],
    known: ReadonlyMap<string, CapReading>,
    toRead: readonly CapEntry[],
  ): Promise<ReadonlyMap<string, CapReading>> {
    const bound =
      toRead.length > 0
        ? await this.readBindings(deviceId, [...new Set(toRead.map((e) => e.cap))])
        : new Map<string, BindingVerdict>()
    const reading = new Set(toRead.map(entryKey))
    const caps = new Map<string, CapReading>()
    for (const entry of requested) {
      const key = entryKey(entry)
      const prior = known.get(key)
      caps.set(
        key,
        prior !== undefined && !reading.has(key)
          ? prior
          : await this.readCap(deviceId, entry, bound.get(entry.cap) ?? 'unknown', prior),
      )
    }
    return caps
  }

  private async resolveConfirmed(
    ref: CompositionSourceRef,
    first: SourceListRead | undefined,
  ): Promise<Resolution> {
    const verdict = findRow(first ?? (await this.ports.listDevicesOf(ref.addonId)), ref.stableId)
    if (verdict.kind !== 'absent') return verdict
    const second = findRow(await this.ports.listDevicesOf(ref.addonId), ref.stableId)
    if (second.kind === 'found') {
      this.ports.logger.warn(
        'composition source: the device index disagreed with itself — keeping the source',
        {
          tags: { deviceId: second.deviceId },
          meta: { source: compositionSourceKey(ref) },
        },
      )
      return second
    }
    return second.kind === 'absent'
      ? { kind: 'missing', reason: `source \`${compositionSourceKey(ref)}\` does not exist` }
      : second
  }

  /**
   * One bindings read. A second one would not confirm anything: back to back
   * they are one correlated read, and "unbound" no longer destroys work — it is
   * a non-fatal `none` that `native-registered` heals.
   */
  private async readBindings(
    deviceId: number,
    caps: readonly string[],
  ): Promise<ReadonlyMap<string, BindingVerdict>> {
    const read = await this.ports.readBoundCaps(deviceId)
    return new Map(
      caps.map((c): readonly [string, BindingVerdict] => {
        if (read.kind === 'unreadable') return [c, 'unknown']
        return [c, read.caps.has(c) ? 'bound' : 'unbound']
      }),
    )
  }

  private async readCap(
    deviceId: number,
    entry: CapEntry,
    binding: BindingVerdict,
    prior: CapReading | undefined,
  ): Promise<CapReading> {
    const { cap, view } = entry
    if (binding === 'unbound') {
      const reason = `capability \`${cap}\` is not bound on device ${deviceId} — waiting for \`native-registered\``
      // Logged on the TRANSITION into unbound only, never on a read (D391).
      if (prior?.kind !== 'unbound') {
        this.ports.logger.warn(
          'composition source: a requested capability is not bound — the field is unavailable until it registers',
          {
            tags: { deviceId },
            meta: { cap, view, reason },
          },
        )
      }
      return { kind: 'unbound', reason }
    }
    const read = await this.ports.readSlice(deviceId, cap, view)
    if (read.kind === 'slice') return { kind: 'slice', slice: read.slice, staleReason: null }
    if (read.kind === 'none') {
      // One empty answer is not proof the value is gone (D49): keep what is held.
      if (prior?.kind === 'slice')
        return {
          ...prior,
          staleReason: `a re-read found no \`${cap}\` report — the last value is kept`,
        }
      // An empty read is not an answer either: unconfirmed, nothing is released on it.
      return {
        kind: 'none',
        reason: `the source has not reported \`${cap}\` yet`,
        confirmed: false,
      }
    }
    this.ports.logger.warn('composition source: a slice read failed — the last value is kept', {
      tags: { deviceId },
      meta: { cap, view, error: read.error },
    })
    if (prior?.kind === 'slice') return { ...prior, staleReason: `re-read failed: ${read.error}` }
    // A failed read changes nothing (D49): what was known stays; nothing known is `unread`.
    if (prior !== undefined && prior.kind !== 'unread') return prior
    return { kind: 'unread', reason: `the slice could not be read: ${read.error}` }
  }

  /** A claim or release of `owner` on `(deviceId, cap)` was answered: read the owner's native-view readings of it once, in place. */
  private async rereadNative(
    deviceId: number,
    cap: string,
    owner: string,
  ): Promise<ReadonlySet<string>> {
    const changed = new Set<string>()
    const key = entryKey({ cap, view: 'native' })
    for (const [k, source] of this.sources) {
      if (source.deviceId !== deviceId || source.missingReason !== null) continue
      if (source.nativeOwner !== owner) continue
      const current = source.caps.get(key)
      if (current === undefined) continue
      const reading = await this.readCap(deviceId, { cap, view: 'native' }, 'bound', current)
      if (reading === current) continue
      const latest = this.sources.get(k) ?? source
      this.sources = new Map([
        ...this.sources,
        [k, { ...latest, caps: new Map([...latest.caps, [key, reading]]) }],
      ])
      changed.add(compositionSliceKey(source.ref, cap))
    }
    return changed
  }

  private logHealed(deviceId: number, cap: string, via: string): void {
    this.ports.logger.info('composition source: an unbound capability is served again', {
      tags: { deviceId },
      meta: { cap, via },
    })
  }

  private async readOnline(deviceId: number): Promise<boolean | null> {
    const read = await this.ports.readSlice(deviceId, DEVICE_STATUS_CAP, 'effective')
    if (read.kind === 'unreadable') {
      this.ports.logger.warn(
        'composition source: `device-status` could not be read — online unknown',
        {
          tags: { deviceId },
          meta: { error: read.error },
        },
      )
    }
    return read.kind === 'slice' ? onlineOf(read.slice) : null
  }
}

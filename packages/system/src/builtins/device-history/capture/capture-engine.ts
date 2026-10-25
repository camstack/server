/**
 * Capture of capability fields (D850, plan §5.3), driven by the GENERATED
 * history catalog — a field is recorded because its `*.cap.ts` says so, never
 * because someone listed it here.
 *
 * For a `DeviceStateChanged { deviceId, capName, slice }` the engine:
 *   1. ignores a cap with no catalog entry (the common case — cheap, uncounted);
 *   2. skips an opted-out device (counted), a device whose type is not yet
 *      known (parked, then replayed once the hub answers), and a `hub` /
 *      `container` (counted: not a real device);
 *   3. per field: skips an excluded device type, an absent or non-numeric value
 *      (null is UNKNOWN, never 0), then runs {@link decideCapture} against the
 *      last RECORDED value — change-only, deadband, capture floor;
 *   4. buffers the point for the batched write.
 *
 * A change inside the capture floor is kept PENDING and emitted when the floor
 * has passed ({@link CaptureEngine.tickPending}), so the end of a burst is never
 * lost. Reconcile ({@link CaptureEngine.reconcile}) restores what a dropped
 * event missed from the state mirror's snapshot.
 */
import {
  type CapabilityHistoryField,
  type CapabilityHistoryItems,
  type DeviceHistorySubject,
  type DeviceType,
  type IScopedLogger,
  historyItemFieldPath,
} from '@camstack/types'
import type { HistoryCounters } from '../status/counters.js'
import type { SeriesRegistry } from '../store/series-registry.js'
import { identityOf, subjectIdOf } from '../store/series-registry.js'
import type { HistoryStore, MetricRecord } from '../store/history-store.js'
import { type RecordedState, decideCapture, minIntervalOf } from './capture-filter.js'
import { type DeviceDirectory, isRealDeviceType } from './device-directory.js'
import { readNumeric, readPath } from './field-path.js'
import type { PointWriter } from './point-writer.js'

export type HistoryCatalog = Readonly<
  Record<string, Readonly<Record<string, CapabilityHistoryField>>>
>

/** Keyed-array series per cap (D917): the item key is the series scope. */
export type HistoryItemCatalog = Readonly<Record<string, CapabilityHistoryItems>>

export const CAP_KEY_PREFIX = 'cap:'

/**
 * Items read from one slice's keyed array; beyond this the rest are not
 * captured (counted `item-overflow`). A consumables list holds a handful.
 */
export const MAX_ITEMS_PER_SLICE = 64
/** The longest item key that becomes a series scope (counted `item-key-invalid` beyond). */
export const MAX_ITEM_KEY_LENGTH = 128

export function capSeriesKey(capName: string, fieldPath: string): string {
  return `${CAP_KEY_PREFIX}${capName}.${fieldPath}`
}

/** The series key of an item field: `cap:<capName>.<path>[].<field>`. */
export function capItemSeriesKey(
  capName: string,
  items: CapabilityHistoryItems,
  field: string,
): string {
  return capSeriesKey(capName, historyItemFieldPath(items.path, field))
}

function humanize(capName: string, fieldPath: string): string {
  const field = fieldPath
    .replace(/([A-Z])/g, ' $1')
    .replace(/\./g, ' ')
    .toLowerCase()
  return `${capName.replace(/-/g, ' ')} ${field}`
}

function metricOf(
  key: string,
  capName: string,
  path: string,
  spec: CapabilityHistoryField,
  now: number,
): MetricRecord {
  return {
    key,
    source: 'cap',
    ownerAddon: 'device-history',
    subjectKind: 'device',
    kind: spec.kind,
    unit: spec.unit ?? null,
    displayName: spec.displayName ?? humanize(capName, path),
    ingest: 'points',
    declaredAt: now,
    values: spec.kind === 'enum' ? (spec.values ?? []) : null,
  }
}

/** The metric rows of every catalog field and keyed-item field (owner `device-history`). */
export function catalogMetrics(
  catalog: HistoryCatalog,
  itemCatalog: HistoryItemCatalog,
  now: number,
): readonly MetricRecord[] {
  const fields = Object.entries(catalog).flatMap(([capName, specs]) =>
    Object.entries(specs).map(([path, spec]) =>
      metricOf(capSeriesKey(capName, path), capName, path, spec, now),
    ),
  )
  const items = Object.entries(itemCatalog).flatMap(([capName, block]) =>
    Object.entries(block.fields).map(([field, spec]) =>
      metricOf(capItemSeriesKey(capName, block, field), capName, field, spec, now),
    ),
  )
  return [...fields, ...items]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface PendingPoint {
  readonly key: string
  readonly subject: DeviceHistorySubject
  readonly scope: string
  readonly spec: CapabilityHistoryField
  readonly value: number
}

interface ParkedSlice {
  readonly capName: string
  readonly slice: Readonly<Record<string, unknown>>
  readonly at: number
}

/** Devices waiting on a type lookup; beyond this the oldest is dropped (and counted). */
const MAX_PARKED_DEVICES = 5_000
/** Seeding reads the newest raw row of each cap series, this many at once. */
const SEED_CONCURRENCY = 8

export type SnapshotMap = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
>

export interface CaptureEngineDeps {
  readonly catalog: HistoryCatalog
  readonly itemCatalog: HistoryItemCatalog
  readonly registry: SeriesRegistry
  readonly store: HistoryStore
  readonly directory: DeviceDirectory
  readonly writer: PointWriter
  readonly optedOut: () => ReadonlySet<number>
  readonly counters: HistoryCounters
  readonly logger: IScopedLogger
  readonly clock: () => number
}

export class CaptureEngine {
  private readonly recorded = new Map<string, RecordedState>()
  private readonly pending = new Map<string, PendingPoint>()
  private readonly parked = new Map<number, Map<string, ParkedSlice>>()

  constructor(private readonly deps: CaptureEngineDeps) {}

  /** Learn the last recorded value of every cap series from the store, so a restart repeats nothing. */
  async seed(): Promise<void> {
    const { registry, store } = this.deps
    const capSeries = registry.all().filter((s) => s.key.startsWith(CAP_KEY_PREFIX))
    for (let i = 0; i < capSeries.length; i += SEED_CONCURRENCY) {
      await Promise.all(
        capSeries.slice(i, i + SEED_CONCURRENCY).map(async (series) => {
          const newest = await store.rawBefore(series.id, Number.MAX_SAFE_INTEGER)
          if (newest === null) return
          this.recorded.set(identityOf(series.key, series.subject, series.scope), newest)
        }),
      )
    }
  }

  /** One `DeviceStateChanged`. Synchronous: the bus must never wait on us. */
  handleState(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
    at: number,
  ): void {
    const fields = this.deps.catalog[capName]
    const items = this.deps.itemCatalog[capName]
    if (fields === undefined && items === undefined) return
    const { counters, directory } = this.deps
    counters.eventsSeen += 1
    if (this.deps.optedOut().has(deviceId)) {
      counters.skip('opted-out')
      return
    }
    const type = directory.typeOf(deviceId)
    if (type === undefined) {
      this.park(deviceId, capName, slice, at)
      return
    }
    if (!isRealDeviceType(type)) {
      counters.skip('not-a-real-device')
      return
    }
    this.captureSlice(deviceId, type, capName, slice, at, false)
  }

  /** Every catalogued field and keyed item of one cap slice, for a real device. */
  private captureSlice(
    deviceId: number,
    type: DeviceType,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
    at: number,
    reconciling: boolean,
  ): void {
    for (const [path, spec] of Object.entries(this.deps.catalog[capName] ?? {})) {
      if (spec.excludeDeviceTypes?.includes(type) === true) {
        if (!reconciling) this.deps.counters.skip('excluded-device-type')
        continue
      }
      const key = capSeriesKey(capName, path)
      const value = this.readValue(slice, key, path, spec)
      if (value === null) continue
      this.consider(deviceId, key, '', spec, value, at, reconciling)
    }
    const items = this.deps.itemCatalog[capName]
    if (items !== undefined) {
      this.captureItems(deviceId, type, capName, items, slice, at, reconciling)
    }
  }

  /**
   * A keyed array (D917): each item with a usable key contributes its fields
   * under that key as the series scope. A value that is not an array is no
   * reading; an item without a string key cannot be followed and is counted.
   */
  private captureItems(
    deviceId: number,
    type: DeviceType,
    capName: string,
    items: CapabilityHistoryItems,
    slice: Readonly<Record<string, unknown>>,
    at: number,
    reconciling: boolean,
  ): void {
    const list = readPath(slice, items.path)
    if (!Array.isArray(list)) return
    const { counters } = this.deps
    if (list.length > MAX_ITEMS_PER_SLICE) {
      counters.skip('item-overflow', list.length - MAX_ITEMS_PER_SLICE)
    }
    for (const entry of list.slice(0, MAX_ITEMS_PER_SLICE)) {
      const scope = isRecord(entry) ? entry[items.key] : undefined
      if (
        !isRecord(entry) ||
        typeof scope !== 'string' ||
        scope.length === 0 ||
        scope.length > MAX_ITEM_KEY_LENGTH
      ) {
        counters.skip('item-key-invalid')
        continue
      }
      for (const [field, spec] of Object.entries(items.fields)) {
        if (spec.excludeDeviceTypes?.includes(type) === true) continue
        const key = capItemSeriesKey(capName, items, field)
        const value = this.readValue(entry, key, field, spec)
        if (value === null) continue
        this.consider(deviceId, key, scope, spec, value, at, reconciling)
      }
    }
  }

  /**
   * The number a field contributes, or `null` (not a reading — never 0). An
   * `enum` state becomes the ordinal of its value in the metric's list; a value
   * the full list cannot take is refused and counted (`enum-overflow`).
   */
  private readValue(
    slice: Readonly<Record<string, unknown>>,
    key: string,
    path: string,
    spec: CapabilityHistoryField,
  ): number | null {
    if (spec.skipWhenSet !== undefined) {
      const gate = readPath(slice, spec.skipWhenSet)
      if (gate !== undefined && gate !== null) return null
    }
    if (spec.kind !== 'enum') return readNumeric(slice, path, spec.kind)
    const raw = readPath(slice, path)
    if (typeof raw !== 'string' || raw.length === 0) return null
    const ordinal = this.deps.registry.ordinalOf(key, raw)
    if (ordinal === null) this.deps.counters.skip('enum-overflow')
    return ordinal
  }

  private consider(
    deviceId: number,
    key: string,
    scope: string,
    spec: CapabilityHistoryField,
    value: number,
    at: number,
    reconciling: boolean,
  ): void {
    const subject: DeviceHistorySubject = { kind: 'device', deviceId }
    const identity = identityOf(key, `d:${deviceId}`, scope)
    const decision = decideCapture(spec, this.recorded.get(identity) ?? null, value, at, {
      ignoreFloor: reconciling,
    })
    if (decision.action === 'emit') {
      this.emit(identity, key, subject, scope, value, at)
      if (reconciling) this.deps.counters.reconciledPoints += 1
      return
    }
    if (decision.action === 'defer') {
      this.pending.set(identity, { key, subject, scope, spec, value })
      return
    }
    // The current value is NOT worth a point; anything pending for it is stale.
    this.pending.delete(identity)
    this.deps.counters.skip(decision.reason)
  }

  private emit(
    identity: string,
    key: string,
    subject: DeviceHistorySubject,
    scope: string,
    value: number,
    ts: number,
  ): void {
    this.recorded.set(identity, { value, ts })
    this.pending.delete(identity)
    this.deps.counters.pointsEmitted += 1
    this.deps.writer.enqueue({ key, subject, scope, ts, value })
  }

  /** Emit every pending change whose capture floor has passed, stamped where the floor ended. */
  tickPending(now: number): void {
    for (const [identity, p] of this.pending) {
      const recorded = this.recorded.get(identity)
      const deviceId = p.subject.kind === 'device' ? p.subject.deviceId : -1
      if (this.deps.optedOut().has(deviceId)) {
        this.pending.delete(identity)
        this.deps.counters.skip('opted-out')
        continue
      }
      const notBefore = (recorded?.ts ?? now) + minIntervalOf(p.spec)
      if (now < notBefore) continue
      this.emit(identity, p.key, p.subject, p.scope, p.value, notBefore)
      this.deps.counters.trailingEmitted += 1
    }
  }

  // ── devices whose type is not known yet ────────────────────────────

  private park(
    deviceId: number,
    capName: string,
    slice: Readonly<Record<string, unknown>>,
    at: number,
  ): void {
    const existing = this.parked.get(deviceId)
    if (existing !== undefined) {
      existing.set(capName, { capName, slice, at })
      return
    }
    if (this.parked.size >= MAX_PARKED_DEVICES) {
      const oldest = this.parked.keys().next()
      if (oldest.done !== true) this.parked.delete(oldest.value)
      this.deps.counters.skip('parked-overflow')
    }
    this.parked.set(deviceId, new Map([[capName, { capName, slice, at }]]))
    void this.deps.directory.ensure(deviceId).then((type) => {
      const waiting = this.parked.get(deviceId)
      this.parked.delete(deviceId)
      if (waiting === undefined) return
      if (type === undefined) {
        this.deps.counters.skip('unknown-device', waiting.size)
        return
      }
      for (const p of waiting.values()) this.handleState(deviceId, p.capName, p.slice, p.at)
    })
  }

  // ── reconcile ──────────────────────────────────────────────────────

  /**
   * Restore a missed change from the state mirror's whole snapshot: a field whose
   * value differs from the last recorded one gets a point stamped `now`.
   * Additive only — it never removes anything, and a snapshot that could not be
   * read is the CALLER's failure to count (D49), not an empty snapshot.
   */
  reconcile(snapshots: SnapshotMap, now: number): void {
    const optedOut = this.deps.optedOut()
    for (const [deviceKey, caps] of Object.entries(snapshots)) {
      const deviceId = Number(deviceKey)
      if (!Number.isInteger(deviceId) || optedOut.has(deviceId)) continue
      const type = this.deps.directory.typeOf(deviceId)
      if (type === undefined || !isRealDeviceType(type)) continue
      for (const [capName, slice] of Object.entries(caps)) {
        this.captureSlice(deviceId, type, capName, slice, now, true)
      }
    }
  }

  /**
   * Forget what was "recorded" for points that never reached the store (dropped),
   * so the next change-only comparison — and the next reconcile — starts from what
   * is really there instead of leaving a hole until the value moves.
   */
  forget(
    points: readonly {
      key: string
      subject: DeviceHistorySubject
      scope: string
    }[],
  ): void {
    for (const p of points) {
      const identity = identityOf(p.key, subjectIdOf(p.subject), p.scope)
      this.recorded.delete(identity)
      this.pending.delete(identity)
    }
  }

  /** A purged series leaves no state behind. */
  forgetSeries(series: { key: string; subject: string; scope: string }): void {
    const identity = identityOf(series.key, series.subject, series.scope)
    this.recorded.delete(identity)
    this.pending.delete(identity)
  }

  /** For status and specs. */
  pendingCount(): number {
    return this.pending.size
  }

  /** The last recorded state of a series, for specs. */
  lastRecorded(key: string, subjectId: string, scope = ''): RecordedState | undefined {
    return this.recorded.get(identityOf(key, subjectId, scope))
  }
}

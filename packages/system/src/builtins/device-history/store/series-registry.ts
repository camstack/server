/**
 * The in-memory index of metrics and series, loaded once and kept in step with
 * the store. Series ids are assigned by the engine (`INTEGER PRIMARY KEY`, a
 * rowid alias, D473); creating one is single-flight per identity so two
 * concurrent first points of a series never insert it twice.
 */
import type { DeviceHistorySubject } from '@camstack/types'
import { HistoryStore, type MetricRecord, type SeriesRecord } from './history-store.js'

export function subjectIdOf(subject: DeviceHistorySubject): string {
  return subject.kind === 'device' ? `d:${subject.deviceId}` : `n:${subject.nodeId}`
}

export function deviceIdOf(subject: DeviceHistorySubject): number | null {
  return subject.kind === 'device' ? subject.deviceId : null
}

/** Every metric key is a cap field (`cap:`), an addon's series (`addon:`) or derived. */
export function isMetricKey(key: string): boolean {
  return key.startsWith('cap:') || key.startsWith('addon:')
}

export function identityOf(key: string, subjectId: string, scope: string): string {
  return `${key}\u0000${subjectId}\u0000${scope}`
}

const LOAD_PAGE = 5_000

/**
 * Values one `enum` key may learn. A field that keeps producing new values is
 * free text, not a state: past this its new values are refused (counted), never
 * allowed to grow the dictionary — and so every stored row — without bound.
 */
export const MAX_ENUM_VALUES = 1024

/** Append what `next` names that `stored` lacks, in `next`'s order: an ordinal never moves. */
export function mergeEnumValues(
  stored: readonly string[] | null,
  next: readonly string[] | null,
): readonly string[] | null {
  if (stored === null) return next
  if (next === null) return stored
  const missing = next.filter((v) => !stored.includes(v))
  return missing.length === 0 ? stored : [...stored, ...missing]
}

export class SeriesRegistry {
  private readonly metrics = new Map<string, MetricRecord>()
  private readonly byIdentity = new Map<string, SeriesRecord>()
  private readonly byId = new Map<number, SeriesRecord>()
  private readonly inflight = new Map<string, Promise<SeriesRecord>>()
  /** Enum metrics whose value list grew in memory and is not stored yet. */
  private readonly dirtyMetrics = new Set<string>()
  private readonly removeListeners: ((series: SeriesRecord) => void)[] = []

  constructor(private readonly store: HistoryStore) {}

  async load(): Promise<void> {
    this.metrics.clear()
    this.byIdentity.clear()
    this.byId.clear()
    const stray: string[] = []
    for (const m of await this.store.loadMetrics()) {
      if (isMetricKey(m.key)) this.metrics.set(m.key, m)
      else stray.push(m.key)
    }
    if (stray.length > 0) await this.store.deleteMetrics(stray)
    let afterId = 0
    for (;;) {
      const page = await this.store.loadSeriesPage(afterId, LOAD_PAGE)
      for (const s of page) this.index(s)
      const last = page[page.length - 1]
      if (last === undefined || page.length < LOAD_PAGE) break
      afterId = last.id
    }
  }

  private index(series: SeriesRecord): void {
    this.byId.set(series.id, series)
    this.byIdentity.set(identityOf(series.key, series.subject, series.scope), series)
  }

  // ── metrics ────────────────────────────────────────────────────────

  metric(key: string): MetricRecord | undefined {
    return this.metrics.get(key)
  }

  allMetrics(): readonly MetricRecord[] {
    return [...this.metrics.values()]
  }

  /**
   * Persist and remember a metric; idempotent. An `enum` value list is MERGED
   * append-only with the stored one, so reordering a `z.enum` never changes
   * what a stored ordinal means.
   */
  async declareMetric(metric: MetricRecord): Promise<void> {
    const existing = this.metrics.get(metric.key)
    const merged: MetricRecord = {
      ...metric,
      values: mergeEnumValues(existing?.values ?? null, metric.values),
    }
    if (existing !== undefined && sameMetric(existing, merged)) return
    await this.store.upsertMetric(merged)
    this.metrics.set(metric.key, merged)
  }

  /**
   * The ordinal of `value` in an `enum` metric's list, learning (appending) a
   * value seen for the first time. `null` when the key is not an enum metric or
   * its list is full ({@link MAX_ENUM_VALUES}). A learned value is stored by
   * {@link persistDirtyMetrics} BEFORE any point that uses it.
   */
  ordinalOf(key: string, value: string): number | null {
    const metric = this.metrics.get(key)
    if (metric === undefined || metric.kind !== 'enum') return null
    const values = metric.values ?? []
    const known = values.indexOf(value)
    if (known >= 0) return known
    if (values.length >= MAX_ENUM_VALUES) return null
    this.metrics.set(key, { ...metric, values: [...values, value] })
    this.dirtyMetrics.add(key)
    return values.length
  }

  /** Store every value list that grew in memory. Throws (and keeps them dirty) on a failed write. */
  async persistDirtyMetrics(): Promise<void> {
    for (const key of this.dirtyMetrics) {
      const metric = this.metrics.get(key)
      if (metric !== undefined) await this.store.upsertMetric(metric)
      this.dirtyMetrics.delete(key)
    }
  }

  // ── series ─────────────────────────────────────────────────────────

  find(key: string, subjectId: string, scope: string): SeriesRecord | undefined {
    return this.byIdentity.get(identityOf(key, subjectId, scope))
  }

  byIdOf(id: number): SeriesRecord | undefined {
    return this.byId.get(id)
  }

  all(): readonly SeriesRecord[] {
    return [...this.byId.values()]
  }

  forSubject(subjectId: string): readonly SeriesRecord[] {
    return this.all().filter((s) => s.subject === subjectId)
  }

  forKeyAndSubject(key: string, subjectId: string): readonly SeriesRecord[] {
    return this.all().filter((s) => s.key === key && s.subject === subjectId)
  }

  /** The series, created on first sight. `ts` stamps `first_ts`/`last_ts` of a new one. */
  async ensure(
    key: string,
    subject: DeviceHistorySubject,
    scope: string,
    ts: number,
  ): Promise<SeriesRecord> {
    const subjectId = subjectIdOf(subject)
    const identity = identityOf(key, subjectId, scope)
    const known = this.byIdentity.get(identity)
    if (known !== undefined) return known
    const pending = this.inflight.get(identity)
    if (pending !== undefined) return pending
    const created = this.create(key, subjectId, deviceIdOf(subject), scope, ts).finally(() => {
      this.inflight.delete(identity)
    })
    this.inflight.set(identity, created)
    return created
  }

  private async create(
    key: string,
    subjectId: string,
    deviceId: number | null,
    scope: string,
    ts: number,
  ): Promise<SeriesRecord> {
    const stored =
      (await this.store.findSeries(key, subjectId, scope)) ??
      (await this.store.insertSeries({ key, subject: subjectId, deviceId, scope, ts }))
    this.index(stored)
    return stored
  }

  /** Remember a widened span (the store write is the caller's). */
  noteSpan(id: number, firstTs: number, lastTs: number): void {
    const current = this.byId.get(id)
    if (current === undefined) return
    this.index({
      ...current,
      firstTs: Math.min(current.firstTs, firstTs),
      lastTs: Math.max(current.lastTs, lastTs),
    })
  }

  remove(id: number): void {
    const current = this.byId.get(id)
    if (current === undefined) return
    this.byId.delete(id)
    this.byIdentity.delete(identityOf(current.key, current.subject, current.scope))
    for (const listener of this.removeListeners) listener(current)
  }

  /** Per-series state elsewhere (last recorded value, dirty marks, rate limits) is dropped through this. */
  onRemove(listener: (series: SeriesRecord) => void): void {
    this.removeListeners.push(listener)
  }
}

function sameMetric(a: MetricRecord, b: MetricRecord): boolean {
  return (
    a.source === b.source &&
    a.ownerAddon === b.ownerAddon &&
    a.subjectKind === b.subjectKind &&
    a.kind === b.kind &&
    a.unit === b.unit &&
    a.displayName === b.displayName &&
    a.ingest === b.ingest &&
    JSON.stringify(a.values) === JSON.stringify(b.values)
  )
}

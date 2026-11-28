/**
 * The derived-changes reader's view of device-history (D1084): which audited fields of a device
 * have a series, and their raw points. A field with no series (its cap has no `history` block)
 * has no derived row.
 */
import { auditedFields, type DeviceHistoryKind, type IScopedLogger } from '@dominevo/types'
import { CAP_KEY_PREFIX, capSeriesKey } from '../capture/capture-engine.js'
import type { HistoryQuery } from '../query/history-query.js'
import type { SeriesRegistry } from '../store/series-registry.js'
import {
  DERIVED_POINTS_MAX,
  type AuditedSeries,
  type ChangeSeriesPort,
  type RawChangeRead,
} from './derived-changes.js'

export interface HistoryChangePortDeps {
  readonly registry: Pick<SeriesRegistry, 'forSubject' | 'metric'>
  readonly query: Pick<HistoryQuery, 'query'>
  readonly logger: IScopedLogger
}

/** `cap:<capName>.<field>` → its parts, or `null` for a key that is not a top-level cap field. */
function splitCapKey(key: string): { readonly capName: string; readonly field: string } | null {
  if (!key.startsWith(CAP_KEY_PREFIX)) return null
  const rest = key.slice(CAP_KEY_PREFIX.length)
  const dot = rest.indexOf('.')
  if (dot <= 0 || dot === rest.length - 1) return null
  return { capName: rest.slice(0, dot), field: rest.slice(dot + 1) }
}

export class HistoryChangePort implements ChangeSeriesPort {
  constructor(private readonly deps: HistoryChangePortDeps) {}

  auditedSeries(deviceId: number): readonly AuditedSeries[] {
    const out: AuditedSeries[] = []
    for (const series of this.deps.registry.forSubject(`d:${deviceId}`)) {
      if (series.scope !== '') continue
      const parts = splitCapKey(series.key)
      if (parts === null || !auditedFields(parts.capName).has(parts.field)) continue
      const kind: DeviceHistoryKind | undefined = this.deps.registry.metric(series.key)?.kind
      if (kind === undefined) continue
      out.push({ capName: parts.capName, field: parts.field, kind })
    }
    return out
  }

  async readRaw(
    deviceId: number,
    series: AuditedSeries,
    from: number,
    to: number,
  ): Promise<RawChangeRead> {
    const result = await this.deps.query.query({
      key: capSeriesKey(series.capName, series.field),
      subject: { kind: 'device', deviceId },
      scope: '',
      from,
      to,
      resolution: 'raw',
      maxPoints: DERIVED_POINTS_MAX,
    })
    if (result.truncated) {
      this.deps.logger.warn(
        'derived device changes read cut at the raw point cap; the oldest points are left out',
        {
          tags: { deviceId },
          meta: { field: `${series.capName}.${series.field}`, cap: DERIVED_POINTS_MAX },
        },
      )
    }
    const first = result.series[0]
    if (first === undefined) return { before: null, points: [] }
    return {
      before:
        first.before === null
          ? null
          : {
              t: first.before.t,
              value: first.before.value,
              state: first.before.state,
            },
      points: first.points.map((p) => ({
        t: p.t,
        value: p.last,
        state: p.state,
      })),
    }
  }
}

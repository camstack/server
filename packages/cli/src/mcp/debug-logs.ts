/**
 * The pure half of `debug_report`'s log section: which lines of a camera's
 * window are churn (a profile slot changed, detection restarted, a derived
 * stream's encoder respawned, a restream dropped packets), counted with their
 * rate and the gap between them, plus the notable lines themselves, scrubbed.
 */
import { scrubSecrets } from '@camstack/develop'
import type { LogEntry } from './ops-logs.js'

interface ChurnPattern {
  readonly id: string
  readonly test: RegExp
}

/** Messages the pipeline and the stream broker log at the moments the issue reports name. */
export const CHURN_PATTERNS: readonly ChurnPattern[] = [
  { id: 'profile-slot-changed', test: /profile slot changed/i },
  { id: 'slots-changed-event', test: /received onProfileSlotsChanged/i },
  { id: 'detection-stopped', test: /^detection stopped/i },
  { id: 'detection-started', test: /^starting detection/i },
  { id: 'derived-feeder-restart', test: /derived feeder (restarting|spawn failed|giving up)/i },
  { id: 'restream-dropped-packets', test: /restream dropped packets/i },
]

export interface ChurnEvent {
  readonly id: string
  readonly count: number
  readonly firstAt: string
  readonly lastAt: string
  /** Events per hour over the window; `null` when the window is empty. */
  readonly perHour: number | null
  /** Median seconds between consecutive events; `null` with fewer than two. */
  readonly medianGapSec: number | null
  /** Derived streams named by these lines (`derived:web-720p`), with a count each. */
  readonly byDerivedStream: { readonly [camStreamId: string]: number }
}

export interface NotableLine {
  readonly at: string
  readonly level: string
  readonly scope: string | null
  readonly message: string
}

export interface LogAnalysis {
  readonly scanned: number
  readonly byLevel: { readonly [level: string]: number }
  readonly events: readonly ChurnEvent[]
  readonly notable: readonly NotableLine[]
  readonly notableTruncated: number
}

export const NOTABLE_LIMIT = 60
const LINE_MAX_CHARS = 300
const DERIVED_ID = /derived:[a-z0-9][a-z0-9._-]*/i

const ms = (iso: string): number => Date.parse(iso)

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid]
  const lower = sorted[mid - 1]
  if (upper === undefined) return null
  return sorted.length % 2 === 1 || lower === undefined ? upper : (lower + upper) / 2
}

/** The derived stream a line is about: its message, then `meta.camStreamId`. */
export function derivedStreamOf(entry: LogEntry): string | null {
  const inMessage = DERIVED_ID.exec(entry.message)
  if (inMessage) return inMessage[0]
  const metaId: unknown = entry.meta?.['camStreamId']
  if (typeof metaId === 'string' && metaId.startsWith('derived:')) return metaId
  return null
}

export function analyzeLogs(
  entries: readonly LogEntry[],
  window: { readonly sinceMs: number; readonly untilMs: number },
): LogAnalysis {
  const ordered = entries.toSorted((a, b) => ms(a.timestamp) - ms(b.timestamp))
  const byLevel: { [level: string]: number } = {}
  for (const e of ordered) byLevel[e.level] = (byLevel[e.level] ?? 0) + 1
  const hours = (window.untilMs - window.sinceMs) / 3_600_000
  const events: ChurnEvent[] = []
  for (const pattern of CHURN_PATTERNS) {
    const hits = ordered.filter((e) => pattern.test.test(e.message))
    const first = hits[0]
    const last = hits.at(-1)
    if (!first || !last) continue
    const gaps: number[] = []
    for (let i = 1; i < hits.length; i += 1) {
      const prev = hits[i - 1]
      const cur = hits[i]
      if (prev && cur) gaps.push((ms(cur.timestamp) - ms(prev.timestamp)) / 1000)
    }
    const byDerived: { [id: string]: number } = {}
    for (const h of hits) {
      const id = derivedStreamOf(h)
      if (id !== null) byDerived[id] = (byDerived[id] ?? 0) + 1
    }
    events.push({
      id: pattern.id,
      count: hits.length,
      firstAt: first.timestamp,
      lastAt: last.timestamp,
      perHour: hours > 0 ? Number((hits.length / hours).toFixed(2)) : null,
      medianGapSec: median(gaps),
      byDerivedStream: byDerived,
    })
  }
  const notableAll = ordered.filter(
    (e) =>
      e.level === 'error' ||
      e.level === 'warn' ||
      CHURN_PATTERNS.some((p) => p.test.test(e.message)),
  )
  const notable = notableAll.slice(-NOTABLE_LIMIT).map(
    (e): NotableLine => ({
      at: e.timestamp,
      level: e.level,
      scope: e.scope ?? null,
      message: scrubSecrets(e.message).slice(0, LINE_MAX_CHARS),
    }),
  )
  return {
    scanned: ordered.length,
    byLevel,
    events,
    notable,
    notableTruncated: Math.max(0, notableAll.length - NOTABLE_LIMIT),
  }
}

/** `30m`, `2h`, `1d`, or an ISO timestamp, as a start instant. `null` when it is none of those. */
export function parseSince(
  value: string | undefined,
  now: number,
  fallbackMinutes: number,
): number | null {
  if (value === undefined || value === '') return now - fallbackMinutes * 60_000
  const rel = /^(\d+)\s*([mhd])$/i.exec(value.trim())
  if (rel) {
    const n = Number(rel[1])
    const unit = (rel[2] ?? 'm').toLowerCase()
    const perUnit = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000
    return now - n * perUnit
  }
  const abs = Date.parse(value)
  return Number.isNaN(abs) ? null : abs
}

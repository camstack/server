/**
 * Pure Loki push-payload construction. No I/O, no timers — so the label policy
 * and the ordering rules below are testable without a Loki instance.
 *
 * ## Why Loki and not Promtail
 *
 * Promtail is a file *tailer*: it watches log files on disk and ships what it
 * reads to Loki. CamStack already has every entry in memory, in structured form,
 * at the moment it is emitted — writing it to disk purely so a sidecar can parse
 * it back out loses the structure and adds a process. Loki's own ingestion API
 * (`POST /loki/api/v1/push`) takes the structured form directly.
 *
 * Promtail is also end-of-life: Grafana deprecated it in favour of Alloy in 2025.
 * Building against a deprecated shipper to reach an API we can call ourselves
 * would be strange. If someone does run Promtail or Alloy, the rotated files
 * from the `winston-logging` destination are still there to tail — the two
 * destinations are independent.
 *
 * ## The label policy, which matters more than it looks
 *
 * Loki indexes labels, and every distinct label-value combination is a separate
 * *stream* with its own index entry and its own chunks. High-cardinality labels
 * are the documented way to make a Loki cluster fall over.
 *
 * So `scope`, `message`, `deviceId`, `sessionId` and everything else per-entry
 * stay OUT of the labels and go in the line body as JSON. Labels are only the
 * handful of values with a small, bounded set:
 *
 *   job    a fixed string, operator-configured (default `camstack`)
 *   node   the ORIGIN node's id — the agent that EMITTED the entry, not the
 *          node running this destination. The hub is the single Loki egress
 *          for the whole cluster (agents forward their logs to it via the
 *          `hub-forwarder`), so labelling every pushed line with the hub's own
 *          id would collapse the entire fleet onto `node="hub"` and lose the
 *          source. Each entry carries its origin in `tags.agentId` (`'hub'` for
 *          hub-local entries, the agent id for forwarded ones — always the root
 *          node, never a child process), which is bounded by cluster size. The
 *          destination's configured node is only the fallback for an entry with
 *          no `agentId` tag.
 *   level  one of four
 *
 * That is at most `4 × nodes` streams, which is what Loki is built for.
 */
import type { LogEntry, LogLevel } from '@camstack/types'

/** One `[unixNano, line]` pair, exactly as Loki's push API expects. */
export type LokiValue = readonly [string, string]

export interface LokiStream {
  readonly stream: Readonly<Record<string, string>>
  readonly values: readonly LokiValue[]
}

export interface LokiPushBody {
  readonly streams: readonly LokiStream[]
}

export interface LokiLabelInput {
  /** Fixed `job` label. Bounded by configuration, never per-entry. */
  readonly job: string
  /**
   * Fallback node id for entries that carry no `tags.agentId` origin — the
   * id of the node running this destination. The per-entry origin
   * (`tags.agentId`) is preferred so forwarded agent logs are attributed to
   * their source node rather than the hub that ships them.
   */
  readonly node: string
  /** Extra static labels from configuration. Values must be low-cardinality. */
  readonly extra?: Readonly<Record<string, string>>
}

/**
 * Loki rejects a label name that is not a valid Prometheus label
 * (`[a-zA-Z_][a-zA-Z0-9_]*`), so operator-supplied keys are sanitised rather
 * than passed through — a 400 from the push endpoint on every batch is a much
 * worse outcome than a renamed label.
 */
export function sanitizeLabelName(raw: string): string {
  const replaced = raw.replaceAll(/[^a-zA-Z0-9_]/g, '_')
  return /^[a-zA-Z_]/.test(replaced) ? replaced : `_${replaced}`
}

/** Parse an operator's `key=value,key2=value2` label string. */
export function parseExtraLabels(raw: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const name = sanitizeLabelName(trimmed.slice(0, eq).trim())
    const value = trimmed.slice(eq + 1).trim()
    if (value.length > 0) out[name] = value
  }
  return out
}

/** `Date` → Loki's nanosecond-precision string timestamp. */
export function toUnixNano(timestamp: Date | string | number): string {
  const ms =
    timestamp instanceof Date
      ? timestamp.getTime()
      : typeof timestamp === 'number'
        ? timestamp
        : Date.parse(timestamp)
  // Not `* 1e6` on a float: 1e6 × a 13-digit epoch exceeds 2^53 and would lose
  // precision. String concatenation is exact and is what the API wants anyway.
  return `${String(Math.trunc(Number.isFinite(ms) ? ms : 0))}000000`
}

/**
 * The line body: JSON carrying everything that must NOT be a label. Loki can
 * parse this with `| json` at query time, so `scope` and `tags.deviceId` stay
 * filterable without ever being indexed.
 */
export function formatLokiLine(entry: LogEntry): string {
  const line: Record<string, unknown> = { message: entry.message }
  // The entry's identity (D898): a page read back from Loki dedupes against
  // the same line pushed live.
  if (entry.id !== undefined) line['id'] = entry.id
  if (entry.scope !== undefined && entry.scope.length > 0) line['scope'] = entry.scope
  if (entry.tags !== undefined && Object.keys(entry.tags).length > 0) line['tags'] = entry.tags
  if (entry.meta !== undefined && Object.keys(entry.meta).length > 0) line['meta'] = entry.meta
  return JSON.stringify(line)
}

/**
 * Group a batch into one stream per distinct label set, and sort each stream's
 * values by timestamp.
 *
 * The `node` label is resolved PER ENTRY from `tags.agentId` (the emitting
 * agent, falling back to `labels.node` when absent), so a batch that mixes
 * hub-local lines with forwarded agent lines fans out into one stream per
 * origin node — the whole point of shipping the cluster's logs through the hub
 * without flattening every line onto `node="hub"`.
 *
 * The sort is not cosmetic. Loki historically rejected a stream whose entries
 * were not in ascending time order, and even with out-of-order ingestion enabled
 * it is bounded by a window. Entries reach a destination from several concurrent
 * producers, so a batch is NOT naturally ordered — without this, some pushes
 * fail with `entry out of order` and those log lines are simply gone.
 */
export function buildPushBody(
  entries: readonly LogEntry[],
  labels: LokiLabelInput,
): LokiPushBody | null {
  if (entries.length === 0) return null

  const base: Record<string, string> = { job: labels.job }
  for (const [key, value] of Object.entries(labels.extra ?? {})) base[key] = value

  // Group by the (node, level) pair. `node` is the entry's origin agent so
  // forwarded agent logs land under their own node label, not the hub's.
  const byStream = new Map<string, { node: string; level: LogLevel; values: LokiValue[] }>()
  for (const entry of entries) {
    const agentId = entry.tags?.agentId
    const node = typeof agentId === 'string' && agentId.length > 0 ? agentId : labels.node
    const key = `${node}\u0000${entry.level}`
    const bucket = byStream.get(key) ?? { node, level: entry.level, values: [] }
    bucket.values.push([toUnixNano(entry.timestamp), formatLokiLine(entry)])
    byStream.set(key, bucket)
  }

  const streams: LokiStream[] = []
  for (const { node, level, values } of byStream.values()) {
    streams.push({
      stream: { ...base, node, level },
      values: values.toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    })
  }
  return { streams }
}

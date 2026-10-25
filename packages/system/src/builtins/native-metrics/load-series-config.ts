/**
 * The two knobs of the durable load series, and the arithmetic that makes them
 * honest.
 *
 * ## Where they live, and why there
 *
 * In `native-metrics`'s OWN global settings document — the one that already
 * exists and already carries `samplingIntervalMs`. Fields on a document, never
 * a method per knob: `system.getLoggingSettings` / `setLoggingSettings` set
 * that precedent and it holds here.
 *
 * They are NOT in the logging document, and that is a decision rather than an
 * omission. That document is about levels and diagnostic windows; a metrics
 * cadence and a table's retention are neither. Two documents that both claim a
 * knob is how this repo has already shipped a switch nobody read.
 *
 * They are cluster-wide, not per-node. Every node emits on the same cadence or
 * the fleet's series cannot be laid over each other, and the table is single
 * and hub-resident, so a per-node retention would be a promise nothing could
 * keep.
 *
 * ## Refused, not clamped
 *
 * A cadence outside 5-60 s is REFUSED. Clamping would silently store 10 when
 * the operator typed 2 and then report 10 back as though it had been accepted
 * — the failure mode where a knob and its readback agree on a value nobody
 * chose. The schema advertises the bounds; this refuses anything else.
 */

/** Measured bytes per row (legacy load table); still used for cost projection copy. */
export const MEASURED_BYTES_PER_ROW = 87

export const MIN_CADENCE_SEC = 5
export const MAX_CADENCE_SEC = 60
export const DEFAULT_CADENCE_SEC = 10

export const DEFAULT_RETENTION_HOURS = 6
export const MIN_RETENTION_HOURS = 1
export const MAX_RETENTION_HOURS = 72

export const DEFAULT_MAX_ROWS = 500_000

/** The resolved, in-force configuration. */
export interface LoadSeriesConfig {
  readonly cadenceSec: number
  readonly retentionHours: number
  readonly maxRows: number
}

/** Why a value was refused — the message an operator is shown verbatim. */
export class LoadSeriesConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LoadSeriesConfigError'
  }
}

function requireInteger(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    throw new LoadSeriesConfigError(`${field} must be a number, received ${String(value)}`)
  }
  return Math.round(n)
}

/**
 * Resolve the configuration, REFUSING anything out of range.
 *
 * An ABSENT field takes its default — that is not a refusal, it is a document
 * that has never been written. A PRESENT field outside its bounds throws.
 */
export function resolveLoadSeriesConfig(raw: {
  readonly loadSeriesCadenceSec?: unknown
  readonly loadSeriesRetentionHours?: unknown
}): LoadSeriesConfig {
  let cadenceSec = DEFAULT_CADENCE_SEC
  if (raw.loadSeriesCadenceSec !== undefined && raw.loadSeriesCadenceSec !== null) {
    cadenceSec = requireInteger(raw.loadSeriesCadenceSec, 'loadSeriesCadenceSec')
    if (cadenceSec < MIN_CADENCE_SEC || cadenceSec > MAX_CADENCE_SEC) {
      throw new LoadSeriesConfigError(
        `load series cadence must be between ${MIN_CADENCE_SEC} and ${MAX_CADENCE_SEC} seconds — refused ${cadenceSec}`,
      )
    }
  }

  let retentionHours = DEFAULT_RETENTION_HOURS
  if (raw.loadSeriesRetentionHours !== undefined && raw.loadSeriesRetentionHours !== null) {
    retentionHours = requireInteger(raw.loadSeriesRetentionHours, 'loadSeriesRetentionHours')
    if (retentionHours < MIN_RETENTION_HOURS || retentionHours > MAX_RETENTION_HOURS) {
      throw new LoadSeriesConfigError(
        `load series retention must be between ${MIN_RETENTION_HOURS} and ${MAX_RETENTION_HOURS} hours — refused ${retentionHours}`,
      )
    }
  }

  return { cadenceSec, retentionHours, maxRows: DEFAULT_MAX_ROWS }
}

/** What a configuration is projected to cost, from OBSERVED counts. */
export interface LoadSeriesProjection {
  /** Rows the retention window alone would hold. */
  readonly intendedRows: number
  /** Rows actually allowed — `min(intendedRows, maxRows)`. */
  readonly boundedRows: number
  readonly estimatedBytes: number
  /** Does the row cap bite before the retention window is full? */
  readonly capBites: boolean
}

/**
 * Project the cost of a configuration from the numbers the cluster is actually
 * reporting — nodes and processes OBSERVED, never a constant.
 *
 * This is what makes the knob honest: an operator raising retention to three
 * days sees the row count and the megabytes BEFORE applying it, rather than
 * discovering them afterwards. `MEASURED_BYTES_PER_ROW` is measured, not
 * guessed — see `node-metrics-history-recorder.ts`.
 */
export function projectLoadSeriesCost(input: {
  readonly config: LoadSeriesConfig
  /** Process rows observed across the fleet in the most recent snapshots. */
  readonly observedProcessRows: number
}): LoadSeriesProjection {
  const samplesPerNodeWindow = (input.config.retentionHours * 3600) / input.config.cadenceSec
  const intendedRows = Math.round(samplesPerNodeWindow * Math.max(input.observedProcessRows, 0))
  const boundedRows = Math.min(intendedRows, input.config.maxRows)
  return {
    intendedRows,
    boundedRows,
    estimatedBytes: boundedRows * MEASURED_BYTES_PER_ROW,
    capBites: intendedRows > input.config.maxRows,
  }
}

/** Human-readable one-liner for the settings form. */
export function describeLoadSeriesCost(projection: LoadSeriesProjection): string {
  const mib = (projection.estimatedBytes / 1_048_576).toFixed(1)
  const rows = projection.intendedRows.toLocaleString('en-US')
  const capped = projection.boundedRows.toLocaleString('en-US')
  if (!projection.capBites) {
    return `This configuration retains ~${rows} rows ≈ ${mib} MiB on the hub database (NVMe cache), measured at ${MEASURED_BYTES_PER_ROW} bytes per row.`
  }
  return (
    `This configuration WANTS ~${rows} rows, above the ${projection.boundedRows.toLocaleString('en-US')}-row hard cap. ` +
    `The table will hold ~${capped} rows ≈ ${mib} MiB and the OLDEST samples will be evicted, ` +
    `so the effective window is shorter than the retention you asked for.`
  )
}

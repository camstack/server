/**
 * Pure derivation + formatting helpers for the Exports section (T7).
 *
 * Extracted from `ExportsSection.tsx` so the label/range/expiry formatting
 * and the seed-plus-live-events merge are unit-testable without mounting the
 * React tree or stubbing the tRPC provider.
 */
import type { ExportOptions, ExportRecord } from '@camstack/types'
import i18n from '../../i18n/index'

/** Live event payloads emitted by the render engine, keyed by export id. */
export interface ExportProgressEvent {
  readonly exportId: string
  readonly progressPct: number
}
export interface ExportCompletedEvent {
  readonly exportId: string
  readonly fileBytes: number
}
export interface ExportFailedEvent {
  readonly exportId: string
  readonly error: string
}

/** Human variant label: "1×", "4× + audio", "timelapse 2s". */
export function describeVariant(options: ExportOptions): string {
  const parts: string[] = []
  if (options.timelapse) {
    parts.push(`timelapse ${String(options.timelapse.everyMs / 1000)}s`)
  } else {
    parts.push(`${String(options.speed ?? 1)}×`)
    if (options.includeAudio) parts.push('+ audio')
  }
  return parts.join(' ')
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Render the from→to range plus its duration (mm:ss / h:mm:ss). */
export function formatRange(fromMs: number, toMs: number): string {
  const totalSec = Math.max(0, Math.round((toMs - fromMs) / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const dur =
    h > 0
      ? `${String(h)}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${String(m)}:${String(s).padStart(2, '0')}`
  return `${formatClock(fromMs)} · ${dur}`
}

/** Relative expiry: "in 6d", "in 3h", "in 12m", or "expired". */
export function formatExpiry(expiresAt: number, nowMs: number): string {
  const deltaMs = expiresAt - nowMs
  if (deltaMs <= 0) return i18n.t('helpers.exportFormat.expired')
  const mins = Math.floor(deltaMs / 60_000)
  if (mins < 60) return i18n.t('helpers.exportFormat.inMinutes', { n: String(mins) })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return i18n.t('helpers.exportFormat.inHours', { n: String(hours) })
  return i18n.t('helpers.exportFormat.inDays', { n: String(Math.floor(hours / 24)) })
}

/**
 * Merge the `listExports` seed with the three live telemetry event maps.
 *
 * Precedence per row (freshest wins, terminal server states are sticky):
 *   1. `deleted` / `expired` server rows are never overridden by live events.
 *   2. a failure event → `failed` (+error, progress cleared).
 *   3. a completion event → `ready` (+fileBytes, 100%).
 *   4. a progress event on a still-active row → `rendering` (+pct).
 *   5. otherwise the seed row unchanged.
 */
export function mergeLiveExports(
  seed: readonly ExportRecord[],
  progress: ReadonlyMap<string, ExportProgressEvent>,
  completed: ReadonlyMap<string, ExportCompletedEvent>,
  failed: ReadonlyMap<string, ExportFailedEvent>,
): readonly ExportRecord[] {
  return seed.map((rec) => {
    if (rec.state === 'expired' || rec.state === 'deleted') return rec
    const fail = failed.get(rec.id)
    if (fail) return { ...rec, state: 'failed', error: fail.error, progressPct: null }
    const done = completed.get(rec.id)
    if (done) return { ...rec, state: 'ready', fileBytes: done.fileBytes, progressPct: 100 }
    const prog = progress.get(rec.id)
    if (prog && (rec.state === 'queued' || rec.state === 'rendering')) {
      return { ...rec, state: 'rendering', progressPct: prog.progressPct }
    }
    return rec
  })
}

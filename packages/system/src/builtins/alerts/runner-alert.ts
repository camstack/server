/**
 * ONE alert per runner (D877).
 *
 * A runner that dies produces a burst: `process.crashed` per exit,
 * `addon.crashed` per hosted addon, then `addon.runner-failed` when the D6
 * breaker gives up (or `addon.runner-refused` for a typed Init refusal). On
 * 2026-10-17 28 runners made 28 "Addon crash loop" + 140 "Process crashed" +
 * 34 "Addon crashed" alerts in one minute - the alerts ring (500) was a third
 * full and the one alert that mattered was 1 of 202.
 *
 * Here the burst folds into ONE record per `(node, runner)` that updates its
 * count and state. `refused` and `failed` are TERMINAL markers: a later plain
 * crash bumps the count but never downgrades them. A dismissed record starts
 * a fresh one.
 */
import type { AlertSeverity } from '@camstack/types'

export type RunnerAlertState = 'crashed' | 'failed' | 'refused'

export interface RunnerAlertRecord {
  readonly nodeId: string
  readonly runnerId: string
  readonly state: RunnerAlertState
  /** When this EPISODE began (ms). A runner that recovered and fails again opens a new one. */
  readonly since: number
  /** Events folded into this record. */
  readonly count: number
  readonly addonIds: readonly string[]
  /** Last error text a plain crash carried. */
  readonly lastError?: string
  /** Refusal: the addon's own words, and what the operator does. */
  readonly reason?: string
  readonly remedy?: string
  /** Breaker: crashes inside the window. */
  readonly crashesInWindow?: number
}

export type RunnerAlertCategory =
  | 'process.crashed'
  | 'addon.crashed'
  | 'addon.runner-failed'
  | 'addon.runner-refused'

export const RUNNER_ALERT_CATEGORIES: readonly RunnerAlertCategory[] = [
  'process.crashed',
  'addon.crashed',
  'addon.runner-failed',
  'addon.runner-refused',
]

export function isRunnerAlertCategory(category: string): category is RunnerAlertCategory {
  return (RUNNER_ALERT_CATEGORIES as readonly string[]).includes(category)
}

/** Stable alert id of a runner on a node. */
export function runnerAlertId(nodeId: string, runnerId: string): string {
  return `runner:${nodeId}:${runnerId}`
}

function str(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function strList(data: Record<string, unknown>, key: string): readonly string[] {
  const value = data[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Which runner an event is about; `null` when it names none. */
export function runnerKeyOf(
  category: RunnerAlertCategory,
  data: Record<string, unknown>,
  source: { readonly id?: string; readonly nodeId?: string } | undefined,
): { readonly nodeId: string; readonly runnerId: string } | null {
  const nodeId = str(data, 'nodeId') ?? source?.nodeId ?? 'hub'
  const runnerId =
    category === 'process.crashed'
      ? (str(data, 'processId') ?? source?.id ?? 'unknown')
      : category === 'addon.crashed'
        ? (str(data, 'addonId') ?? source?.id ?? 'unknown')
        : str(data, 'runnerId')
  return runnerId === undefined ? null : { nodeId, runnerId }
}

/** Fold one event into the runner's record. */
export function foldRunnerEvent(
  previous: RunnerAlertRecord | null,
  category: RunnerAlertCategory,
  data: Record<string, unknown>,
  key: { readonly nodeId: string; readonly runnerId: string },
  now: number,
): RunnerAlertRecord {
  const base: RunnerAlertRecord = previous ?? {
    nodeId: key.nodeId,
    runnerId: key.runnerId,
    state: 'crashed',
    since: now,
    count: 0,
    addonIds: [],
  }
  const addonIds = [...new Set([...base.addonIds, ...strList(data, 'addonIds')])]
  const count = base.count + 1
  switch (category) {
    case 'addon.runner-refused':
      return {
        ...base,
        state: 'refused',
        count,
        addonIds,
        reason: str(data, 'reason') ?? 'refused to start',
        ...(str(data, 'remedy') !== undefined ? { remedy: str(data, 'remedy') } : {}),
      }
    case 'addon.runner-failed': {
      // A refusal is the more specific truth and is never downgraded.
      if (base.state === 'refused') return { ...base, count, addonIds }
      const crashes = data['crashesInWindow']
      return {
        ...base,
        state: 'failed',
        count,
        addonIds,
        ...(typeof crashes === 'number' ? { crashesInWindow: crashes } : {}),
      }
    }
    case 'addon.crashed': {
      const error = str(data, 'error')
      const addonId = str(data, 'addonId')
      return {
        ...base,
        count,
        addonIds: addonId !== undefined ? [...new Set([...addonIds, addonId])] : addonIds,
        ...(error !== undefined ? { lastError: error } : {}),
      }
    }
    case 'process.crashed':
      return { ...base, count, addonIds }
  }
}

export interface RenderedRunnerAlert {
  readonly severity: AlertSeverity
  readonly title: string
  readonly message: string
}

export function renderRunnerAlert(record: RunnerAlertRecord): RenderedRunnerAlert {
  const where = record.nodeId === 'hub' ? record.runnerId : `${record.runnerId} on ${record.nodeId}`
  switch (record.state) {
    case 'refused':
      return {
        severity: 'critical',
        title: 'Addon refused to start',
        message:
          `${where}: refused - ${record.reason ?? 'no reason reported'}` +
          `${record.remedy !== undefined ? ` ${record.remedy}` : ''}`,
      }
    case 'failed':
      return {
        severity: 'critical',
        title: 'Addon crash loop',
        message:
          `Runner "${where}" gave up` +
          `${record.crashesInWindow !== undefined ? ` after ${String(record.crashesInWindow)} crashes` : ''}` +
          `${record.addonIds.length > 0 ? ` (addons: ${record.addonIds.join(', ')})` : ''}` +
          ` - ${String(record.count)} events`,
      }
    case 'crashed':
      return {
        severity: 'error',
        title: 'Addon crashed',
        message:
          `Addon "${where}" crashed${record.lastError !== undefined ? `: ${record.lastError}` : ''}` +
          `${record.count > 1 ? ` (${String(record.count)} events)` : ''}`,
      }
  }
}

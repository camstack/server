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
import { CORE_BLOCK_ADDON_PREFIX } from '@camstack/types'
import { CRASH_BREAKER_ERROR_PREFIX } from '../../kernel/moleculer/runner-failure-info.js'

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
  /** Human name of the runner (a core block's name, an addon's manifest name); absent = unknown, the id is shown. */
  readonly displayName?: string
  /** The real cause: the runner's own last stderr line, else a crash event's error (never the breaker's own text). */
  readonly lastError?: string
  /** Refusal: the addon's own words, and what the operator does. */
  readonly reason?: string
  readonly remedy?: string
  /** Breaker: crashes inside the window. */
  readonly crashesInWindow?: number
  /** How the last process left, when the hub saw it. */
  readonly exitCode?: number
  readonly signal?: string
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
  const displayName = base.displayName ?? str(data, 'displayName')
  const named = displayName !== undefined ? { displayName } : {}
  const count = base.count + 1
  switch (category) {
    case 'addon.runner-refused':
      return {
        ...base,
        ...named,
        state: 'refused',
        count,
        addonIds,
        reason: str(data, 'reason') ?? 'refused to start',
        ...(str(data, 'remedy') !== undefined ? { remedy: str(data, 'remedy') } : {}),
      }
    case 'addon.runner-failed': {
      // A refusal is the more specific truth and is never downgraded.
      if (base.state === 'refused') return { ...base, ...named, count, addonIds }
      const crashes = data['crashesInWindow']
      const cause = str(data, 'lastError')
      const exitCode = data['exitCode']
      const signal = str(data, 'signal')
      return {
        ...base,
        ...named,
        state: 'failed',
        count,
        addonIds,
        ...(cause !== undefined ? { lastError: cause } : {}),
        ...(typeof exitCode === 'number' ? { exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(typeof crashes === 'number' ? { crashesInWindow: crashes } : {}),
      }
    }
    case 'addon.crashed': {
      const error = str(data, 'error')
      const addonId = str(data, 'addonId')
      return {
        ...base,
        ...named,
        count,
        addonIds: addonId !== undefined ? [...new Set([...addonIds, addonId])] : addonIds,
        // The breaker's own sentence describes the breaker, not the cause.
        ...(error !== undefined && !error.startsWith(CRASH_BREAKER_ERROR_PREFIX)
          ? { lastError: error }
          : {}),
      }
    }
    case 'process.crashed':
      return { ...base, ...named, count, addonIds }
  }
}

export interface RenderedRunnerAlert {
  readonly severity: AlertSeverity
  readonly title: string
  readonly message: string
}

/** `Core block "TV" (core-block-x)`, `Addon "Reolink" (reolink)`; the bare id when no name is known. */
function runnerLabel(record: RunnerAlertRecord): string {
  const { displayName, runnerId } = record
  if (displayName === undefined) return `"${runnerId}"`
  const kind = runnerId.startsWith(CORE_BLOCK_ADDON_PREFIX) ? 'Core block' : 'Addon'
  return `${kind} "${displayName}" (${runnerId})`
}

/** `: <cause>`; with no cause known, how the process left (`: exit code 1`), else nothing. */
function failureCause(record: RunnerAlertRecord): string {
  if (record.lastError !== undefined) return `: ${record.lastError}`
  if (record.signal !== undefined) return `: killed by ${record.signal}`
  if (record.exitCode !== undefined) return `: exit code ${String(record.exitCode)}`
  return ''
}

export function renderRunnerAlert(record: RunnerAlertRecord): RenderedRunnerAlert {
  const named = record.displayName !== undefined
  const on = record.nodeId === 'hub' ? '' : ` on ${record.nodeId}`
  const label = `${runnerLabel(record)}${on}`
  switch (record.state) {
    case 'refused':
      return {
        severity: 'critical',
        title: 'Addon refused to start',
        message:
          `${named ? label : `${record.runnerId}${on}`}: refused - ${record.reason ?? 'no reason reported'}` +
          `${record.remedy !== undefined ? ` ${record.remedy}` : ''}`,
      }
    case 'failed': {
      const others = record.addonIds.filter((id) => id !== record.runnerId)
      return {
        severity: 'critical',
        title: 'Addon crash loop',
        message:
          `${named ? label : `Runner ${label}`} gave up` +
          `${record.crashesInWindow !== undefined ? ` after ${String(record.crashesInWindow)} crashes` : ''}` +
          `${failureCause(record)}` +
          `${others.length > 0 ? ` (addons: ${others.join(', ')})` : ''}` +
          ` - ${String(record.count)} events`,
      }
    }
    case 'crashed':
      return {
        severity: 'error',
        title: 'Addon crashed',
        message:
          `${named ? label : `Addon ${label}`} crashed${record.lastError !== undefined ? `: ${record.lastError}` : ''}` +
          `${record.count > 1 ? ` (${String(record.count)} events)` : ''}`,
      }
  }
}

/**
 * The overview's Activity & health feed: archive operations (both ops logs) and
 * the health digest's findings, one list, newest first, filtered by camera,
 * function and severity.
 */
import type { HealthFinding, OpsLogEntry } from '@camstack/types'

export type ActivitySeverity = 'info' | 'warning' | 'critical'
export type ActivityFunction = 'recording' | 'events' | 'detection' | 'motion' | 'other'

export interface ActivityItem {
  readonly id: string
  /** Epoch ms. Findings carry the digest time. */
  readonly at: number
  readonly source: 'operation' | 'finding'
  readonly severity: ActivitySeverity
  readonly fn: ActivityFunction
  /** `null` = a cluster-wide or node-level row. */
  readonly deviceId: number | null
  readonly title: string
  readonly detail: string | null
}

export interface ActivityFilter {
  readonly deviceId: number | null
  readonly fn: ActivityFunction | null
  readonly minSeverity: ActivitySeverity | null
}

const SEVERITY_RANK: Readonly<Record<ActivitySeverity, number>> = {
  info: 0,
  warning: 1,
  critical: 2,
}

const FINDING_FUNCTION: Readonly<Record<HealthFinding['kind'], ActivityFunction>> = {
  'motion-without-detections': 'motion',
  'detections-under-floor': 'detection',
  'inference-too-slow': 'detection',
  'frames-shed': 'detection',
  'inference-device-unusable': 'detection',
}

export function opsLogItem(entry: OpsLogEntry): ActivityItem {
  return {
    id: `op:${entry.id}`,
    at: entry.at,
    source: 'operation',
    severity: 'info',
    fn: entry.domain === 'recording' ? 'recording' : 'events',
    deviceId: entry.deviceId,
    title: `${entry.op} · ${entry.reason}`,
    detail: entry.detail,
  }
}

export function findingItem(finding: HealthFinding, digestAtMs: number): ActivityItem {
  return {
    id: `finding:${finding.id}`,
    at: digestAtMs,
    source: 'finding',
    severity: finding.severity,
    fn: FINDING_FUNCTION[finding.kind],
    deviceId: finding.subject.type === 'camera' ? finding.subject.deviceId : null,
    title: finding.what,
    detail: finding.action,
  }
}

export function filterActivity(
  items: readonly ActivityItem[],
  filter: ActivityFilter,
): readonly ActivityItem[] {
  return items
    .filter((i) => filter.deviceId === null || i.deviceId === filter.deviceId)
    .filter((i) => filter.fn === null || i.fn === filter.fn)
    .filter(
      (i) =>
        filter.minSeverity === null ||
        SEVERITY_RANK[i.severity] >= SEVERITY_RANK[filter.minSeverity],
    )
    .toSorted((a, b) => b.at - a.at)
}

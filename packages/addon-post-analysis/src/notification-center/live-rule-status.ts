/**
 * Extracted from NotificationCenter (ruleStatusFor, timelapseStatusFor).
 * The class method forwards private state through {@link LiveRuleStatusHost}.
 */

import type { NcArtifactRecord } from './artifact-index.js'
import { NcGroupedDelivery } from './grouped/grouped-delivery.js'
import { occupancyClassWarning, probeOccupancyNow } from './occupancy-dry-run.js'
import { OccupancyWatcher, occupancyThreshold } from './occupancy-watcher.js'
import type { NcRuleStatus, NcTimelapseDeviceStatus } from './rule-status.js'
import {
  buildGroupedStatus,
  buildGroupedStatusUnknown,
  buildOccupancyStatus,
} from './rule-status.js'
import {
  TIMELAPSE_LOOKBACK_MS,
  TIMELAPSE_SETTLE_MS,
  TimelapseScheduler,
} from './timelapse/timelapse-scheduler.js'
import { findLastClosedWindow, findNextWindowOpen } from './timelapse/window-bounds.js'
import type { CameraOccupancySnapshot, IScopedLogger, NcRule, TimelapseRule } from '@camstack/types'
import { readTimelapseGeneratedAt, ruleGroupingApplies } from '@camstack/types'
import type { NotificationCenterDeps } from './index.js'

/**
 * How far ahead a status may scan for the next window opening.
 *
 * Nine days rather than "as far as it takes": a weekly schedule opens within
 * seven, and a schedule that opens less often than that is one whose next run
 * is not the fact an operator is looking at a card for.
 */
export const TIMELAPSE_LOOKAHEAD_MS = 9 * 86_400_000
/**
 * The artefact a (rule, camera) pair last produced, if the retained shelf still
 * holds it. A function rather than the index itself: the index lives in the
 * hosting addon, and the centre must not grow a dependency on it to answer a
 * question that degrades perfectly well to "no link".
 */
export type NcTimelapseArtifactLookup = (input: {
  readonly ruleId: string
  readonly deviceId: number
}) => Promise<NcArtifactRecord | null>

export interface LiveRuleStatusHost {
  readonly deps: NotificationCenterDeps
  readonly evaluationActive: boolean
  readonly grouped: NcGroupedDelivery
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly occupancyWatcher: OccupancyWatcher
  readonly timelapseScheduler: TimelapseScheduler | null
}

/**
 * The live status of ONE detection rule — see `rule-status.ts`.
 *
 * `none` is a real answer, not a failure: most rule kinds have no live state
 * a card could show, and returning an empty object would read as a read that
 * failed. Only occupancy has one today, and it is the kind whose entire
 * subject is a number nobody can see.
 */
export async function ruleStatusFor(host: LiveRuleStatusHost, rule: NcRule): Promise<NcRuleStatus> {
  // D692: a grouped rule's live state is its open windows. An immediate detection rule has
  // no occupancy condition, so this never shadows the occupancy status below.
  if (rule.groupingSec !== undefined && ruleGroupingApplies(rule)) {
    // D315: a node that does not evaluate holds no windows — that is "unknown", not "none".
    if (!host.evaluationActive) {
      return buildGroupedStatusUnknown(rule.groupingSec, 'this node does not run rule evaluation')
    }
    return buildGroupedStatus({
      groupingSec: rule.groupingSec,
      // A replaying window's deadline is on the EVENTS' clock: against now it reads as
      // "closes within 0 s". It is not an open window of the live rule yet.
      windows: host.grouped
        .openWindowsFor(rule.id)
        .filter((window) => !window.replaying)
        .map((window) => ({
          key: window.key,
          deviceId: window.deviceId,
          openedAt: window.openedAt,
          deadlineAt: window.deadlineAt,
          members: window.members.map((member) => ({
            trackId: member.trackId,
            final: host.grouped.finalityOf(window, member).final,
          })),
        })),
    })
  }
  const occupancy = rule.conditions.occupancy
  if (occupancy === undefined) {
    return { kind: 'none', reason: 'this rule has no live state to report' }
  }
  const deviceId = rule.conditions.devices?.[0]
  const read = host.deps.readOccupancySnapshots
  const threshold = occupancyThreshold(occupancy)
  if (deviceId === undefined || read === undefined) {
    // Honest, and different from "empty": a rule with no camera scope counts
    // on every camera and there is no single "now" to report for it.
    return buildOccupancyStatus({
      deviceId: deviceId ?? 0,
      condition: occupancy,
      probe: { kind: 'unavailable', reason: 'no-snapshot' },
      confirmed: host.occupancyWatcher.snapshotState(),
      threshold,
    })
  }
  let snapshot: CameraOccupancySnapshot | null = null
  try {
    snapshot = (await read([deviceId])).get(deviceId) ?? null
  } catch (err) {
    // Named: a read that failed and said nothing is indistinguishable from a
    // camera that has never produced a snapshot, and the two have different
    // remedies.
    host.logger.warn('rule status could not read the live occupancy snapshot', {
      tags: { deviceId },
      meta: { ruleId: rule.id, error: String(err) },
    })
  }
  const probe = probeOccupancyNow({ occupancy, deviceId, snapshot, now: host.now() })
  const warning = occupancyClassWarning(occupancy.className)
  return buildOccupancyStatus({
    deviceId,
    condition: occupancy,
    probe,
    confirmed: host.occupancyWatcher.snapshotState(),
    threshold,
    ...(warning !== null ? { warning } : {}),
  })
}
/**
 * The live status of one TIMELAPSE rule.
 *
 * Three facts, and each answers a question the rule itself cannot: when each
 * camera last produced (and the artefact it produced, while the shelf still
 * holds it), whether a render is in flight RIGHT NOW, and when the next
 * window opens. The window boundaries are scanned through `isScheduleActive`,
 * the same authority the producer uses — a second reading of a schedule is
 * how a status starts promising a run that is not coming.
 */
export async function timelapseStatusFor(
  host: LiveRuleStatusHost,
  rule: TimelapseRule,
  lookup?: NcTimelapseArtifactLookup,
): Promise<NcRuleStatus> {
  const now = host.now()
  const flights = host.timelapseScheduler?.renderInFlight() ?? []
  const lastWindow = findLastClosedWindow({
    schedule: rule.schedule,
    nowMs: now,
    lookbackMs: TIMELAPSE_LOOKBACK_MS,
  })
  const nextWindow = findNextWindowOpen({
    schedule: rule.schedule,
    nowMs: now,
    lookaheadMs: TIMELAPSE_LOOKAHEAD_MS,
  })
  const devices: NcTimelapseDeviceStatus[] = []
  for (const deviceId of rule.deviceIds) {
    const generatedAt = readTimelapseGeneratedAt(rule, deviceId)
    const flight = flights.find((f) => f.ruleId === rule.id && f.deviceId === deviceId)
    // Best-effort: an index that cannot answer costs the link, never the
    // status — the generation stamp is the durable fact and it is already in.
    const artifact =
      lookup === undefined
        ? null
        : await lookup({ ruleId: rule.id, deviceId }).catch((err: unknown) => {
            host.logger.warn('rule status could not read the timelapse artifact index', {
              tags: { deviceId },
              meta: { ruleId: rule.id, error: String(err) },
            })
            return null
          })
    devices.push({
      deviceId,
      ...(generatedAt > 0 ? { lastGeneratedAt: generatedAt } : {}),
      ...(artifact !== null ? { lastArtifact: artifact } : {}),
      ...(flight !== undefined
        ? {
            rendering: {
              startedAt: flight.startedAt,
              windowStartMs: flight.window.startMs,
              windowEndMs: flight.window.endMs,
            },
          }
        : {}),
    })
  }
  return {
    kind: 'timelapse',
    devices,
    ...(lastWindow !== null ? { lastWindow } : {}),
    ...(nextWindow !== null ? { nextWindow } : {}),
    settleMs: TIMELAPSE_SETTLE_MS,
  }
}

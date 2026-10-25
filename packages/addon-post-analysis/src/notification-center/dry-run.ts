/**
 * Extracted from NotificationCenter (dryRun, occupancyDryRun, validateTargetRefs).
 * The class method forwards private state through {@link DryRunHost}.
 */

import { NcDeviceStateCache } from './device-state-cache.js'
import { RECONCILE_SCAN_LIMIT } from './drain-snooze.js'
import { incomingFromTrack } from './event-intake.js'
import { packagePhaseOf } from './live-intake.js'
import { occupancyProbeLabel, probeOccupancyNow } from './occupancy-dry-run.js'
import type { NcDeviceStateLookup, NcRuleSubject, NcSceneStateLookup } from './rule-engine.js'
import { evaluateRule, subjectFromObjectEvent, subjectFromPackageEvent } from './rule-engine.js'
import { NcSceneStateCache } from './scene-state-cache.js'
import { NcZoneOwnershipCache } from './zone-owner-cache.js'
import type { NcZoneOwnerLookup } from './zone-ownership.js'
import type {
  CameraOccupancySnapshot,
  IScopedLogger,
  NcOccupancyCondition,
  NcRuleInput,
  NcTestResult,
} from '@camstack/types'
import type { NotificationCenterDeps } from './index.js'

// The outbox window's default lives in `PRUNE_WINDOW_DEFAULT_DAYS` with every
// other one. It used to be a local 7-day constant; a second default over one
// value is how `embeddingEnabled` came to show the operator the opposite of
// what the cluster was doing.
const TEST_RULE_MAX_RESULTS = 200

export interface DryRunHost {
  readonly deps: NotificationCenterDeps
  deviceStateLookup(read: (deviceId: number) => string | undefined): NcDeviceStateLookup
  readonly deviceStates: NcDeviceStateCache
  readonly logger: IScopedLogger
  readonly now: () => number
  occupancyDryRun(
    rule: NcRuleInput,
    occupancy: NcOccupancyCondition,
    lookup: NcDeviceStateLookup,
    zoneLookup: NcZoneOwnerLookup,
    sceneLookup: NcSceneStateLookup,
  ): Promise<readonly NcTestResult[]>
  readonly sceneStates: NcSceneStateCache
  readonly zoneOwners: NcZoneOwnershipCache
}

/** `testRule` dry-run — condition evaluation only (no throttle). */
export async function dryRun(
  host: DryRunHost,
  rule: NcRuleInput,
  lookbackMinutes: number,
): Promise<readonly NcTestResult[]> {
  const since = host.now() - lookbackMinutes * 60_000
  const subjects: NcRuleSubject[] = []
  if (rule.delivery === 'immediate') {
    const events = await host.deps.listObjectEventsSince(since, RECONCILE_SCAN_LIMIT)
    // Exclude package rows — those belong to the package-event trigger.
    for (const ev of events) {
      if (packagePhaseOf(ev) === null) subjects.push(subjectFromObjectEvent(ev))
    }
  } else if (rule.delivery === 'package-event') {
    const events = await host.deps.listObjectEventsSince(since, RECONCILE_SCAN_LIMIT)
    for (const ev of events) {
      const phase = packagePhaseOf(ev)
      if (phase !== null) subjects.push(subjectFromPackageEvent(ev, phase))
    }
  } else if (rule.delivery === 'track-end') {
    const tracks = await host.deps.listRecentTracks(since, TEST_RULE_MAX_RESULTS)
    for (const track of tracks) {
      // Persisted rows carry no per-detection confidence; the dry-run
      // reuses importance-free evaluation exactly like the live path.
      subjects.push(incomingFromTrack(track).subject)
    }
  }
  // device-event/system-event: their sources have no durable cross-device
  // scan surface in this slice, so dry-run returns no candidate records (the
  // rules still fire live). Documented boundary — see the cap file.

  // A dry-run rule is not SAVED, so its gated device is not in the watched
  // set and the cache knows nothing about it — every candidate would then
  // report `failedCondition: 'deviceState'`, telling the operator a perfectly
  // good rule can never fire. Found by dry-running one against the live hub.
  // Read that one device on demand: a dry-run is an explicit operator action,
  // not the hot path, so one read is free here in a way it is not there.
  let lookup: NcDeviceStateLookup = host.deviceStateLookup((id) => host.deviceStates.get(id))
  const gated = rule.conditions.deviceState
  if (gated !== undefined && host.deps.readDeviceStates !== undefined) {
    try {
      const fresh = await host.deps.readDeviceStates([gated.deviceId])
      lookup = host.deviceStateLookup((id) => fresh.get(id) ?? host.deviceStates.get(id))
    } catch {
      // Fall through to the cache: a failed read must not fail the dry-run,
      // and the gate's own fail-closed answer is still the honest one.
    }
  }
  // Same story for zone OWNERSHIP: an unsaved rule's cameras are not in the
  // watched set, so the tester would answer with the flat verdict while the
  // saved rule answers with the scoped one — and the tester exists precisely
  // to predict what saving it will do. One read, on an explicit operator
  // action; a failure leaves it flat, exactly as the live path would be.
  let zoneLookup: NcZoneOwnerLookup = host.zoneOwners.lookup()
  const zoneScope = rule.conditions.devices
  if (
    rule.conditions.zones !== undefined &&
    zoneScope !== undefined &&
    zoneScope.length > 0 &&
    host.deps.readDeviceZoneIds !== undefined
  ) {
    try {
      const fresh = await host.deps.readDeviceZoneIds(zoneScope)
      zoneLookup = (id) => fresh.get(id) ?? host.zoneOwners.get(id)
    } catch {
      // Flat verdict, which is what an unreadable catalogue means everywhere.
    }
  }

  // …and the same story again for the SCENE gate, for the exact reason the
  // `deviceState` block above exists: an unsaved rule's scene is not in the
  // watched set, so every candidate would report `failedCondition: 'scene'`
  // and tell the operator a perfectly good rule can never fire. The provider
  // is in this process and answers the whole list synchronously, so there is
  // no cost argument for leaving the tester wrong.
  let sceneLookup: NcSceneStateLookup = (id) => host.sceneStates.get(id)
  const sceneGate = rule.conditions.scene
  if (sceneGate !== undefined && host.deps.readSceneStates !== undefined) {
    try {
      const fresh = new Map(host.deps.readSceneStates().map((o) => [o.sceneId, o]))
      sceneLookup = (id) => fresh.get(id) ?? host.sceneStates.get(id)
    } catch {
      // Fall through to the mirror: a failed read must not fail the dry-run,
      // and the gate's own fail-closed answer is still the honest one.
    }
  }

  // OCCUPANCY: the only trigger whose truth is available RIGHT NOW rather
  // than in a persisted row — the live snapshot IS the state the condition is
  // about. Answered from it, through the same matcher; see
  // `occupancy-dry-run.ts` for what that answer may and may not claim.
  const occupancy = rule.conditions.occupancy
  if (rule.delivery === 'device-event' && occupancy !== undefined) {
    return host.occupancyDryRun(rule, occupancy, lookup, zoneLookup, sceneLookup)
  }

  const results: NcTestResult[] = []
  for (const subject of subjects.sort((a, b) => b.timestamp - a.timestamp)) {
    if (results.length >= TEST_RULE_MAX_RESULTS) break
    const evaluation = evaluateRule(rule, subject, lookup, zoneLookup, sceneLookup)
    results.push({
      recordId: subject.recordId,
      // dryRun only builds object/track/package subjects (audio, occupancy,
      // device and system events are not scanned), but the subject type is
      // broad; map the unreachable `audio-event`/`occupancy-event` to siblings
      // (`object-event`/`device-event`) to satisfy the NcTestResult enum.
      recordKind:
        subject.kind === 'track-end'
          ? 'track'
          : subject.kind === 'audio-event' || subject.kind === 'audio-window'
            ? 'object-event'
            : subject.kind === 'occupancy-event'
              ? 'device-event'
              : subject.kind,
      deviceId: subject.deviceId,
      timestamp: subject.timestamp,
      wouldFire: evaluation.matched,
      ...(evaluation.failedCondition !== undefined
        ? { failedCondition: evaluation.failedCondition }
        : {}),
      className: subject.classNames[0] ?? 'object',
      ...(subject.label !== undefined ? { label: subject.label } : {}),
    })
  }
  return results
}
/**
 * The occupancy half of {@link dryRun} — "as of now, would this rule fire?".
 *
 * One row per camera in scope, and a row is produced even when the answer is
 * "I cannot see": a rule whose zone was deleted, or whose camera has produced
 * no snapshot, is EXACTLY the rule an operator is testing because it never
 * fires, and an empty result list is what hid that. The verdict itself comes
 * from the ordinary `evaluateRule` on the ordinary subject — this method
 * chooses the cameras and writes the sentence, nothing else.
 */
export async function occupancyDryRun(
  host: DryRunHost,
  rule: NcRuleInput,
  occupancy: NcOccupancyCondition,
  lookup: NcDeviceStateLookup,
  zoneLookup: NcZoneOwnerLookup,
  sceneLookup: NcSceneStateLookup,
): Promise<readonly NcTestResult[]> {
  const read = host.deps.readOccupancySnapshots
  if (read === undefined) return []
  const now = host.now()
  const scoped = rule.conditions.devices
  // The cheapest question first: an unscoped rule asks for every camera that
  // HAS a snapshot; a scoped one asks only for its own.
  const wanted = scoped !== undefined && scoped.length > 0 ? scoped : undefined
  let snapshots: ReadonlyMap<number, CameraOccupancySnapshot>
  try {
    snapshots = await read(wanted)
  } catch (err) {
    host.logger.warn('occupancy dry-run could not read the live snapshots', {
      meta: { rule: rule.name, error: String(err) },
    })
    return []
  }
  const deviceIds = wanted ?? [...snapshots.keys()]
  const results: NcTestResult[] = []
  for (const deviceId of deviceIds) {
    if (results.length >= TEST_RULE_MAX_RESULTS) break
    const probe = probeOccupancyNow({
      occupancy,
      deviceId,
      snapshot: snapshots.get(deviceId) ?? null,
      now,
    })
    const label = occupancyProbeLabel(occupancy, probe, rule.throttle.cooldownSec)
    const common = {
      deviceId,
      // `device-event` is the kind an occupancy row lands as everywhere else
      // (the outbox, the history) — the tester must not invent a sixth kind.
      recordKind: 'device-event' as const,
      className: occupancy.className ?? 'occupancy',
      label,
    }
    if (probe.kind === 'unavailable') {
      results.push({
        ...common,
        recordId: `dryrun:occ:${String(deviceId)}:${probe.reason}`,
        timestamp: now,
        wouldFire: false,
        // The SAME condition id the engine's fail-closed reports, because it
        // is the same failure: the condition could not read its scope.
        failedCondition: 'occupancy',
      })
      continue
    }
    const evaluation = evaluateRule(rule, probe.subject, lookup, zoneLookup, sceneLookup)
    results.push({
      ...common,
      recordId: probe.subject.recordId,
      // The FRAME the counts came from, not "now": a camera whose last
      // snapshot is an hour old is a different problem from an empty zone.
      timestamp: probe.observedAt,
      wouldFire: evaluation.matched,
      ...(evaluation.failedCondition !== undefined
        ? { failedCondition: evaluation.failedCondition }
        : {}),
    })
  }
  return results
}
/** Rule-save referential check: every targetId must resolve in the
 *  live notification-output catalog (spec §2.3 save-time validation). */
export async function validateTargetRefs(
  host: DryRunHost,
  targetIds: readonly string[],
): Promise<void> {
  if (targetIds.length === 0) return
  const targets = await host.deps.dispatcher.listTargets()
  // An EMPTY catalog is indistinguishable from a transport failure, so it is
  // never evidence that an id is wrong — refusing the save would turn a
  // transient into a hard operator error. It IS, however, a defect worth
  // shouting about: from 2026-07-29 to 2026-07-30 this warn was the only
  // visible trace of the collection fan-out gap that made the engine
  // dead-letter every notification it produced. The fan-out is fixed
  // (`aggregateCollectionCall`); if this line reappears, the transport
  // regressed — do not soften it again.
  if (targets.length === 0) {
    host.logger.warn(
      'target catalog came back EMPTY at rule save — the notification-output catalog is ' +
        'unreachable or under-reporting (collection fan-out regression?). Skipping the ' +
        'referential check; delivery re-checks with retry semantics.',
      { meta: { targetIds: [...targetIds] } },
    )
    return
  }
  const known = new Set(targets.map((t) => t.id))
  for (const id of targetIds) {
    if (!known.has(id)) throw new Error(`unknown notification target: ${id}`)
  }
}

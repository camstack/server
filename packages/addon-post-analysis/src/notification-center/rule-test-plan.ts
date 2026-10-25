/**
 * "Fire THIS rule, now" — the plan behind the per-rule Test button.
 *
 * PURE. It reads a rule and returns the synthetic event that SATISFIES it, in
 * the exact shape {@link NcTestEventInput} already carries — so the button
 * costs no second injection path, no second matcher and no second delivery leg.
 * `nc.testRule` is this function plus `injectTestEvent`, and what lands on the
 * operator's phone was matched by `evaluateRule`, enqueued into the durable
 * outbox and delivered by the ordinary notifier.
 *
 * WHY IT IS SERVER-SIDE
 * ─────────────────────
 * The admin UI already derives a simulator FORM from a rule
 * (`prefillFromRule`), and that is a different job: it seeds controls a human
 * then edits. This one answers a rule id and must be right for every rule the
 * hub can evaluate — including the two kinds no client could construct
 * correctly, because their subjects are not records:
 *
 *  - a SOUND rule fires only on a confirmed sampling WINDOW, and
 *    `matchesAudio` compares the window's spec fields to the rule's for
 *    EQUALITY. A window built from anything but the rule's own condition fails
 *    closed, and the operator would read "does not match" about a rule that
 *    works.
 *  - a SYSTEM rule fires on no record at all: its subject carries catalog KEYS
 *    the intake freezes, and inventing prose for them client-side would test
 *    the client's prose rather than the hub's text catalog.
 *
 * WHAT IT DELIBERATELY CANNOT DO
 * ──────────────────────────────
 * Two conditions read the world rather than the subject, and the plan reports
 * them instead of faking them (`notes`): `deviceState` gates on a REAL device's
 * current state, and a `customZones` polygon is matched against a bbox this
 * plan can place but not guarantee. Reported, never silently satisfied — a test
 * that passes where production fails is the one outcome a tester must never
 * produce.
 */

import type {
  NcAudioCondition,
  NcConditions,
  NcOccupancyCondition,
  NcRule,
  NcSchedule,
  NcSystemEventKind,
} from '@camstack/types'
import { isScheduleActive, NC_SENSOR_TRANSITION_KINDS, ruleGroupingApplies } from '@camstack/types'
import { audioSpecFromCondition } from './audio-rule-matcher.js'
import type { NcTestEventInput } from './test-event.js'

/** The subject kind a rule of this shape fires on — the engine's own mapping. */
export type NcRuleTestTrigger = NcTestEventInput['trigger']

/**
 * Which subject kind THIS rule fires on.
 *
 * `delivery` alone cannot answer, because two features ride an existing
 * delivery and are discriminated by a CONDITION — exactly as the engine
 * discriminates them (`rule-engine.ts`: an audio window fires only for a rule
 * declaring `conditions.audio`, an occupancy edge only for one declaring
 * `conditions.occupancy`). A third case is the LEGACY audio-class rule: an
 * `immediate` rule whose classes are all `audio-*` and which declares no
 * `audio` condition fires on a classified episode and on nothing else.
 */
export function testTriggerForRule(rule: {
  readonly delivery: string
  readonly conditions: NcConditions
}): NcRuleTestTrigger {
  if (rule.delivery === 'system-event') return 'system-event'
  if (rule.delivery === 'track-end') return 'track-end'
  if (rule.delivery === 'package-event') return 'package-event'
  if (rule.delivery === 'device-event') {
    return rule.conditions.occupancy !== undefined ? 'occupancy-event' : 'device-event'
  }
  if (rule.conditions.audio !== undefined) return 'audio-window'
  const classes = rule.conditions.classes ?? []
  if (classes.length > 0 && classes.every((c) => c.trim().toLowerCase().startsWith('audio-'))) {
    return 'audio-event'
  }
  return 'object-event'
}

/** What a planned test could not reproduce, and why — rendered, never hidden. */
export interface NcRuleTestNote {
  /** The condition (or `'schedule'` / `'device'`) the note is about. */
  readonly conditionId: string
  readonly note: string
}

export interface NcRuleTestPlan {
  readonly trigger: NcRuleTestTrigger
  /** Ready for `NotificationCenter.injectTestEvent` — no further shaping. */
  readonly input: NcTestEventInput
  readonly notes: readonly NcRuleTestNote[]
}

export interface NcRuleTestPlanInput {
  readonly rule: NcRule
  /** The tester's clock. */
  readonly now: number
  /**
   * The camera to attribute the event to when the rule names none. A rule with
   * no device scope matches every camera, so ANY camera is a faithful subject —
   * but a still needs a real one, and only the caller knows which exist.
   */
  readonly fallbackDeviceId?: number
}

/** Reserved device id for an event with no camera (mirrors the engine's). */
const NC_SYSTEM_DEVICE_ID = 0

/** The grid a schedule is authored on — the same one `window-bounds.ts` scans. */
const SCHEDULE_SCAN_STEP_MS = 60_000

/** How far back a schedule scan may look for an active minute (one week + a day). */
const SCHEDULE_SCAN_LOOKBACK_MS = 8 * 86_400_000

/**
 * Nudge a threshold to a value that PASSES it, and that reads like something a
 * detector would produce. Clamped to 1 so a rule with a floor of 1 still gets a
 * legal value.
 */
function justAbove(floor: number): number {
  return Math.min(1, Math.round((floor + 0.05) * 100) / 100)
}

/**
 * A timestamp the rule's SCHEDULE is active at — `now` when it already is.
 *
 * Scans BACKWARDS on the schedule's own minute grid through `isScheduleActive`,
 * the single authority on what a window means (midnight crossing, `invert`,
 * IANA timezone). Backwards rather than forwards because a test must fire NOW:
 * a future instant would be a notification about something that has not
 * happened, and the outbox would deliver it immediately anyway.
 *
 * `null` when the schedule has no active minute in the lookback — a rule that
 * is currently unfireable, which is a note rather than a silent failure.
 */
export function scheduleActiveAt(schedule: NcSchedule | undefined, now: number): number | null {
  if (schedule === undefined) return now
  if (isScheduleActive(schedule, now)) return now
  const floor = now - SCHEDULE_SCAN_LOOKBACK_MS
  for (let t = now - SCHEDULE_SCAN_STEP_MS; t >= floor; t -= SCHEDULE_SCAN_STEP_MS) {
    if (isScheduleActive(schedule, t)) return t
  }
  return null
}

/**
 * The bbox that satisfies a `customZones` polygon: the polygon's own bounding
 * box, clamped to the frame.
 *
 * The engine's test is `bboxPolygonOverlap(bbox, points) > 0`, and a polygon's
 * bounding box always overlaps it (a polygon with area is contained in its own
 * box). The admin simulator's centred half-frame box does NOT — a polygon drawn
 * in a corner fails it, and the operator reads a working rule as broken.
 */
function bboxForPolygon(
  points: readonly { readonly x: number; readonly y: number }[],
): NonNullable<NcTestEventInput['bbox']> | undefined {
  if (points.length === 0) return undefined
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.max(0, Math.min(...xs))
  const minY = Math.max(0, Math.min(...ys))
  const maxX = Math.min(1, Math.max(...xs))
  const maxY = Math.min(1, Math.max(...ys))
  const w = Math.max(0.01, maxX - minX)
  const h = Math.max(0.01, maxY - minY)
  return { x: minX, y: minY, w: Math.min(1 - minX, w), h: Math.min(1 - minY, h) }
}

/**
 * The audio evidence that answers a condition — in the condition's own MODE.
 *
 * The spec is rebuilt through `audioSpecFromCondition`, the same function the
 * live watcher is fed with, because `matchesAudio` compares those fields for
 * equality: this is the pairing rule that stops a hub with two sound rules on
 * one camera answering one rule with the other's evidence, and rebuilding it
 * anywhere else is how the test comes to disagree with production. A condition
 * with neither filter yields no spec — the engine refuses it, so the plan has
 * nothing to send.
 */
function audioWindowFor(condition: NcAudioCondition): NcTestEventInput['audioWindow'] {
  const spec = audioSpecFromCondition(condition)
  if (spec === null) return undefined
  if (spec.mode === 'label') {
    // A LABEL rule fires on one labelled frame — so that is exactly what the
    // test sends. No window, because the live path has none either.
    return { mode: 'label', specLabels: [...spec.labels], labels: [...spec.labels] }
  }
  // Samples: a plausible ~1 s inference cadence over the window, with exactly
  // the hit share the rule demands (rounded UP — the engine's test is `>=`).
  const samples = Math.max(2, spec.samplingSeconds)
  const hits = Math.max(1, Math.ceil((samples * spec.hitPercent) / 100))
  return {
    mode: 'level',
    hitPercent: Math.min(100, Math.round((hits / samples) * 100)),
    samplingSeconds: spec.samplingSeconds,
    samples,
    hits,
    dbThreshold: spec.dbThreshold,
    peakDbfs: Math.min(0, spec.dbThreshold + 6),
    labels: [],
  }
}

/**
 * The edge that satisfies an occupancy condition.
 *
 * Each op has exactly ONE edge that passes it (see `matchesOccupancy`): the
 * count arrives AT the threshold from below, falls to zero from it, or falls TO
 * the threshold from one above.
 */
function occupancyEdgeFor(condition: NcOccupancyCondition): NcTestEventInput['occupancy'] {
  const threshold = Math.max(1, Math.round(condition.count))
  const shared = {
    ...(condition.zoneId !== undefined ? { zoneId: condition.zoneId } : {}),
    ...(condition.className !== undefined ? { className: condition.className } : {}),
  }
  if (condition.op === 'became-free') {
    return { ...shared, count: 0, previousCount: threshold, occupied: false, threshold }
  }
  if (condition.op === '<=') {
    // `<=C` keys on C+1 (`occupancyThreshold`), and the edge that satisfies it
    // is the count falling TO C from one above. `occupied` is `count >=
    // threshold`, which is C >= C+1 — FALSE, always. Deriving it from
    // `count > 0` instead (as the admin simulator's mirror of this does) makes
    // every `<=` edge un-matchable: `matchesOccupancy` requires the
    // un-occupied edge of key C+1.
    const count = Math.max(0, Math.round(condition.count))
    return { ...shared, count, previousCount: count + 1, occupied: false, threshold: count + 1 }
  }
  return {
    ...shared,
    count: threshold,
    previousCount: Math.max(0, threshold - 1),
    occupied: true,
    threshold,
  }
}

/**
 * The catalog keys a synthetic system event of this kind carries.
 *
 * MIRRORS `incomingFromSystemEvent`'s key derivation, and the mirror is pinned
 * by a spec that asserts every key exists in the shipped English bundle — a key
 * nothing resolves renders an EMPTY notification, which is the one failure a
 * tester must not be able to produce. The BODY VARIANTS the intake chooses from
 * the payload (`.profiled`, `.agent`, `.onNode`) are deliberately not chosen
 * here: the plain variant is the one every kind has.
 */
function systemEventKeys(kind: NcSystemEventKind): {
  readonly titleKey: string
  readonly bodyKey: string
} {
  if (kind === 'node-online' || kind === 'node-offline') {
    return { titleKey: `system.${kind}.title`, bodyKey: `system.${kind}.body.agent` }
  }
  // The mode-carrying alarm titles are per-MODE ("Armed: away" is a different
  // sentence from "Armed: home", and in Italian a different article), so their
  // title key carries the mode. `away` stands in — it is the mode an operator
  // testing an alarm rule means, and the body key is shared by every mode.
  if (PER_MODE_TITLE_KINDS.has(kind)) {
    return { titleKey: `system.${kind}.title.${TEST_ALARM_MODE}`, bodyKey: `system.${kind}.body` }
  }
  // A bypass has two bodies and no plain one; `ignored` (open at arm time) is
  // the one a person meets first.
  if (kind === 'alarm-sensor-bypass') {
    return { titleKey: `system.${kind}.title`, bodyKey: `system.${kind}.body.ignored` }
  }
  if (kind === 'device-consumable-low') {
    return {
      titleKey: `system.${kind}.title`,
      bodyKey: 'system.device-consumable-low.body.tank',
    }
  }
  // A broken rule's body is per REASON (D905); a deleted device stands in.
  if (kind === 'rule-broken') {
    return { titleKey: `system.${kind}.title`, bodyKey: `system.${kind}.body.device-deleted` }
  }
  return { titleKey: `system.${kind}.title`, bodyKey: `system.${kind}.body` }
}

/** The alarm kinds whose TITLE key is per arm mode (`….title.<mode>`). */
const PER_MODE_TITLE_KINDS: ReadonlySet<NcSystemEventKind> = new Set<NcSystemEventKind>([
  'alarm-arm-refused',
  'alarm-check-failed',
  'alarm-arming',
  'alarm-armed',
  'alarm-pending',
  'alarm-rearmed',
])

/** The arm mode a synthetic alarm event stands in for — see {@link systemEventKeys}. */
const TEST_ALARM_MODE = 'away'

/** The runner a synthetic `addon-crash-loop` stands in for. A test fire has no
 *  real crashed runner, and a blank one would render "The  addon on node hub". */
const TEST_CRASHED_RUNNER = 'recorder'

/** The dedup subject the live intake stamps for this kind — same families. */
function systemEventSubject(
  kind: NcSystemEventKind,
  scope: {
    readonly deviceId?: number
    readonly nodeId?: string
    readonly packageName?: string
  },
): string {
  if (kind === 'device-disabled' || kind === 'device-enabled') {
    return `device-switch:${scope.deviceId ?? 0}`
  }
  if (kind === 'device-online' || kind === 'device-offline') return `device:${scope.deviceId ?? 0}`
  if (kind === 'stream-online' || kind === 'stream-offline') return `stream:${scope.deviceId ?? 0}`
  if (kind === 'node-online' || kind === 'node-offline') return `node:${scope.nodeId ?? 'hub'}`
  // Its OWN family, like the live intake: a node whose accelerators died is
  // not the same fact as a node that went away, and sharing a dedup slot
  // would let one suppress the other.
  if (kind === 'node-inference-unavailable') return `node-inference:${scope.nodeId ?? 'hub'}`
  if (kind === 'detection-blind') return `detection-blind:${scope.deviceId ?? 0}`
  if (kind === 'motion-noisy' || kind === 'motion-calm')
    return `motion-noise:${scope.deviceId ?? 0}`
  // Per RUNNER, per node — a group runner is one outage, and it must not share
  // a dedup slot with the node going away.
  if (kind === 'addon-crash-loop') {
    return `addon-crash:${scope.nodeId ?? 'hub'}:${TEST_CRASHED_RUNNER}`
  }
  if (kind === 'addon-update-available' || kind === 'server-update-available') {
    return `package:${scope.packageName ?? '@camstack/server'}`
  }
  // One shell per node, so the NODE is the dedup slot — mirroring the live
  // intake, which keys it the same way.
  if (kind === 'wrapper-update-available') return `wrapper:${scope.nodeId ?? 'hub'}`
  if (kind === 'addon-updated') return `packages:addon-updated:${scope.packageName ?? 'pkg'}`
  if (kind === 'server-updated') return `server-updated:${scope.nodeId ?? 'hub'}`
  // D723: the announcement halves of a restart, keyed like the live intake —
  // a TEST subject carries no restart time, so the node alone is the slot.
  if (kind === 'node-restarting') return `node-restart:${scope.nodeId ?? 'hub'}:test`
  if (kind === 'node-updating') return `node-updating:${scope.nodeId ?? 'hub'}:1.0.1`
  if (kind === 'export-completed') return `export:${scope.deviceId ?? 0}`
  if (kind === 'backup-completed') return 'backup:test'
  if (kind.startsWith('alert-')) return 'alert:test'
  return `alarm:${scope.deviceId ?? 0}`
}

/**
 * The class the subject carries, chosen so it PASSES the rule's class
 * conditions rather than merely existing.
 *
 * A macro selection (`vehicle`) is written verbatim: the engine expands macro →
 * leaves, so the macro itself is always in its own expansion. The exclude list
 * is then honoured — a class that is both wanted and vetoed is a rule that can
 * never fire, and the plan must not paper over it.
 */
function classNamesFor(conditions: NcConditions): readonly string[] {
  const excluded = new Set((conditions.classesExclude ?? []).map((c) => c.trim().toLowerCase()))
  const wanted = (conditions.classes ?? []).filter((c) => !excluded.has(c.trim().toLowerCase()))
  const first = wanted[0] ?? conditions.classes?.[0]
  if (first !== undefined) return [first]
  // No class condition: the subject still needs one — a notification body reads
  // it out — and `person` is the class every model emits.
  return excluded.has('person') ? [] : ['person']
}

/** The label that satisfies the rule's identity / plate / label matchers. */
function labelFor(conditions: NcConditions): string | undefined {
  return (
    conditions.identities?.[0] ??
    conditions.labelEquals?.[0] ??
    conditions.plates?.values?.[0] ??
    undefined
  )
}

/**
 * The edge a planned sensor event carries (D640): RAISED by default — the
 * alert, which is what an operator pressing Test on a flood rule expects to
 * see — and cleared only for a rule that asks for the clear. Only for a kind
 * that HAS a raise: a doorbell press carries none in production, and a test
 * subject claiming one would be a subject no real record could be.
 */
function sensorEdgeFor(trigger: string, c: NcConditions): { sensorRaised?: boolean } {
  const kind = c.sensorKinds?.[0]
  if (trigger !== 'device-event' || kind === undefined) return {}
  if (!NC_SENSOR_TRANSITION_KINDS.includes(kind.trim().toLowerCase())) return {}
  return { sensorRaised: c.sensorTransition !== 'cleared' }
}

/**
 * Plan the injection that fires this rule.
 *
 * Every condition the engine reads off the SUBJECT is satisfied here; the two
 * that read the world are reported in {@link NcRuleTestPlan.notes}.
 */
export function planRuleTest(input: NcRuleTestPlanInput): NcRuleTestPlan {
  const { rule, now } = input
  const c = rule.conditions
  const trigger = testTriggerForRule(rule)
  const notes: NcRuleTestNote[] = []

  const systemScope = {
    ...(c.systemEvent?.deviceIds?.[0] !== undefined
      ? { deviceId: c.systemEvent.deviceIds[0] }
      : {}),
    ...(c.systemEvent?.nodeIds?.[0] !== undefined ? { nodeId: c.systemEvent.nodeIds[0] } : {}),
    ...(c.systemEvent?.packageNames?.[0] !== undefined
      ? { packageName: c.systemEvent.packageNames[0] }
      : {}),
  }

  const scopedDeviceId =
    trigger === 'system-event'
      ? (systemScope.deviceId ?? input.fallbackDeviceId ?? NC_SYSTEM_DEVICE_ID)
      : (c.devices?.[0] ?? input.fallbackDeviceId)
  if (scopedDeviceId === undefined) {
    notes.push({
      conditionId: 'devices',
      note: 'This rule names no camera and none was supplied, so the event is attributed to no device and carries no picture. Scope the rule to a camera, or pick one, to see the notification it would really send.',
    })
  }
  const deviceId = scopedDeviceId ?? NC_SYSTEM_DEVICE_ID
  // D641: the camera the test lands on is one the rule EXCLUDES. Planning
  // around it would test a different camera than the operator picked; saying
  // so is the honest half, and the engine's refusal names the condition.
  if (trigger !== 'system-event' && (c.devicesExclude ?? []).includes(deviceId)) {
    notes.push({
      conditionId: 'devicesExclude',
      note: 'The camera this test uses is one the rule excludes, so the evaluation will refuse the event — exactly as it refuses every real one there. Pick another camera to see the notification.',
    })
  }

  if (trigger === 'object-event' && rule.groupingSec !== undefined && ruleGroupingApplies(rule)) {
    notes.push({
      conditionId: 'grouping',
      note: `grouped: window of ${String(rule.groupingSec)} s; a test sends a group of one`,
    })
  }

  const scheduledAt = scheduleActiveAt(rule.schedule, now)
  if (scheduledAt === null) {
    notes.push({
      conditionId: 'schedule',
      note: 'This rule’s weekly schedule has no active minute in the last eight days, so the test fires outside it and the schedule condition will refuse the event — exactly as it refuses every real one.',
    })
  } else if (scheduledAt !== now) {
    notes.push({
      conditionId: 'schedule',
      note: 'The rule is outside its schedule right now, so the event is stamped with the most recent instant inside a window. The notification therefore reports a past time.',
    })
  }

  if (c.deviceState !== undefined) {
    notes.push({
      conditionId: 'deviceState',
      note: `This rule only fires while device #${c.deviceState.deviceId} is in one of its chosen states. That gate reads the REAL device and cannot be simulated — put the device in that state first, or the test fails closed exactly as production would.`,
    })
  }
  if (c.scene !== undefined) {
    notes.push({
      conditionId: 'scene',
      note: `This rule only fires while scene ${c.scene.sceneId} is ${c.scene.requiredState}. That gate reads the scene's REAL state and cannot be simulated — the test answers with whatever the scene is right now, and fails closed while it cannot judge or has not been read yet, exactly as production would.`,
    })
  }
  if (c.customZones !== undefined && c.customZones.length > 0) {
    notes.push({
      conditionId: 'customZones',
      note: 'The subject is placed over the first drawn polygon so the condition passes. A rule that needs a specific polygon should be checked in the simulator, where the box can be moved.',
    })
  }

  const zones = c.zones?.ids ?? []
  const label = labelFor(c)
  const bbox =
    c.customZones !== undefined && c.customZones.length > 0
      ? bboxForPolygon(c.customZones[0]?.points ?? [])
      : undefined

  const audioWindow =
    trigger === 'audio-window' && c.audio !== undefined ? audioWindowFor(c.audio) : undefined
  const classNames =
    trigger === 'audio-window'
      ? (audioWindow?.labels ?? []).map((l) => `audio-${l}`)
      : trigger === 'occupancy-event'
        ? [c.occupancy?.className ?? 'occupancy']
        : trigger === 'device-event' || trigger === 'system-event'
          ? []
          : classNamesFor(c)

  const systemEventKind = c.systemEvent?.kinds[0]
  if (trigger === 'system-event' && systemEventKind === undefined) {
    notes.push({
      conditionId: 'systemEvent',
      note: 'This rule names no system event, so nothing can be injected for it — the hub refuses such a rule at save time and the engine matches nothing.',
    })
  }

  const testInput: NcTestEventInput = {
    trigger,
    deviceId,
    classNames: [...classNames],
    ...(label !== undefined ? { label } : {}),
    ...(c.minConfidence !== undefined ? { confidence: justAbove(c.minConfidence) } : {}),
    ...(c.minLabelConfidence !== undefined
      ? { labelConfidence: justAbove(c.minLabelConfidence) }
      : {}),
    ...(c.minImportance !== undefined ? { importance: justAbove(c.minImportance) } : {}),
    ...(c.minDwellSeconds !== undefined ? { dwellSeconds: Math.round(c.minDwellSeconds) + 1 } : {}),
    zones: [...zones],
    // A crossing exists only on an object event, and only `exit` needs one:
    // absent and `enter` both pass on a record that is not a crossing at all.
    ...(trigger === 'object-event' && c.crossing === 'exit'
      ? { crossing: { zoneId: zones[0] ?? 'zone', direction: 'exit' as const } }
      : {}),
    ...(c.sensorKinds?.[0] !== undefined ? { sensorKind: c.sensorKinds[0] } : {}),
    ...(c.eventTypeTokens?.[0] !== undefined ? { eventType: c.eventTypeTokens[0] } : {}),
    ...sensorEdgeFor(trigger, c),
    ...(trigger === 'package-event'
      ? {
          packagePhase:
            c.packagePhase === 'picked-up' ? ('picked-up' as const) : ('delivered' as const),
        }
      : {}),
    // `any` is "no restriction" — reproducing it as an authored source would
    // narrow a simulation the rule deliberately left open.
    ...(c.source !== undefined && c.source !== 'any' ? { source: c.source } : {}),
    ...(bbox !== undefined ? { bbox } : {}),
    ...(trigger === 'occupancy-event' && c.occupancy !== undefined
      ? { occupancy: occupancyEdgeFor(c.occupancy) }
      : {}),
    ...(audioWindow !== undefined ? { audioWindow } : {}),
    ...(trigger === 'system-event' && systemEventKind !== undefined
      ? {
          systemEvent: {
            kind: systemEventKind,
            subject: systemEventSubject(systemEventKind, systemScope),
            ...systemEventKeys(systemEventKind),
            textParams: {
              deviceId: String(systemScope.deviceId ?? deviceId),
              deviceName: `camera ${String(systemScope.deviceId ?? deviceId)}`,
              nodeId: systemScope.nodeId ?? 'hub',
              nodeName: systemScope.nodeId ?? 'hub',
              packageName: systemScope.packageName ?? '@camstack/server',
              // Plausible versions, not `0.0.0`. A test fire is byte-for-byte
              // an ordinary notification, so its placeholders teach the
              // operator how to read the real ones — and `0.0.0` is exactly
              // the string a broken emitter shipped as a real version on
              // 2026-08-30. A sample must not look like that bug.
              currentVersion: '1.0.0',
              latestVersion: '1.0.1',
              profile: 'low',
              // The arming title counts down; a blank placeholder there would
              // deliver "Arming away — s".
              seconds: '30',
              // `node-inference-unavailable` names the accelerators that went
              // away, and `detection-blind` the minutes it has been blind. A
              // missing placeholder renders EMPTY, so a test fire would deliver
              // "every enabled device is unavailable ()".
              devices: 'cuda:0',
              minutes: '15',
              // `motion-noisy` / `motion-calm`: the share of the hour in
              // motion and the sessions it took.
              duty: '55',
              sessions: '96',
              // `addon-crash-loop` names the addons the dead runner hosted.
              addons: TEST_CRASHED_RUNNER,
              list: '@camstack/addon-pipeline 1.0.1 (current 1.0.0)',
              nodes: 'hub',
              fromVersion: '1.0.0',
              toVersion: '1.0.1',
              title: systemEventKind.startsWith('alert-') ? 'Recording location full' : 'Export',
              // An alert episode's own facts (`alert-critical`, …): a blank
              // placeholder would deliver "Resolved: " with nothing after it.
              message: 'No free space left on the recording location',
              severity: systemEventKind === 'alert-error' ? 'error' : 'critical',
              category: 'recorder.placement',
              source: 'recorder',
              actionUrl: '/system/addons',
              count: '1',
            },
            ...(systemScope.deviceId !== undefined ? { deviceId: systemScope.deviceId } : {}),
            // The TYPE a `deviceTypes` condition is judged against. Fails closed
            // when the rule narrows by type and the plan cannot name one, which
            // is honest: the live event reads it from the device mirror.
            ...(c.systemEvent?.deviceTypes?.[0] !== undefined
              ? { deviceType: c.systemEvent.deviceTypes[0] }
              : {}),
            ...(systemScope.nodeId !== undefined ? { nodeId: systemScope.nodeId } : {}),
            ...(systemScope.packageName !== undefined
              ? { packageName: systemScope.packageName }
              : {}),
          },
        }
      : {}),
    timestamp: scheduledAt ?? now,
    onlyRuleId: rule.id,
    // A TEST bypasses both side gates, deliberately and loudly: the operator
    // pressed a button and must receive the notification, not a report that a
    // cooldown from ten minutes ago swallowed it. Neither window is CONSUMED,
    // so the next real fire is unaffected.
    bypassCooldown: true,
    bypassMute: true,
    // Never: a rule's sequences unlock doors. Testing the actuation is the
    // simulator's explicit switch, not a side effect of "does this notify".
    runActions: false,
    still: 'live',
  }

  return { trigger, input: testInput, notes }
}

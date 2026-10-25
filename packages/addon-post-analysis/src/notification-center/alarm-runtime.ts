/**
 * Extracted from NotificationCenter (alarmActions, alarmOpenings, alarmLive, enqueueAlarmAnnouncement, alarmAnnouncementText, settleCombinedAlarm, enqueuePickerTargets, scheduleAlarmTransition).
 * The class method forwards private state through {@link AlarmRuntimeHost}.
 */

import type { NcAlarmOpenDevice } from './alarm/alarm-arm-guard.js'
import { alarmCoveredDevices } from './alarm/alarm-arm-guard.js'
import type { NcAlarmInputBypassRecord } from './alarm/alarm-input-bypasses.js'
import type { NcAlarmLiveReadOutcome } from './alarm/alarm-live-read-log.js'
import { NcAlarmLiveReadLog } from './alarm/alarm-live-read-log.js'
import type { NcAlarmLive } from './alarm/alarm-live.js'
import { alarmLiveReadIds, buildAlarmLive } from './alarm/alarm-live.js'
import type {
  NcAlarmModeCoverage,
  NcArmAnnouncementText,
  NcDeviceNameLookup,
} from './alarm/alarm-mode-coverage.js'
import {
  alarmCoverageGap,
  buildArmAnnouncement,
  buildArmRefusedAnnouncement,
  buildArmingAnnouncement,
} from './alarm/alarm-mode-coverage.js'
import type { NcAlarmOpening } from './alarm/alarm-openings.js'
import { classifyCoveredOpening, rawForLog } from './alarm/alarm-openings.js'
import type { NcAlarmOpenings } from './alarm/alarm-panel-device.js'
import type { NcAlarmTransition } from './alarm/alarm-transitions.js'
import type { NcMediaPolicyFields } from './build-entries.js'
import { matchedTriggerZoneIds, mediaPolicyFields } from './build-entries.js'
import { ruleCropZoneIds } from './close-grouped-pass.js'
import { NcDeviceDirectory } from './device-directory.js'
import type { NcIncomingEvent, NcIntakeReport, NcRuleOutcome } from './event-intake.js'
import { incomingFromAlarmTransition } from './event-intake.js'
import { NC_ALARM_ANNOUNCE_RULE_ID } from './mint-buttons.js'
import type { NcAlarmActionDeps } from './nc-actions.js'
import type { NcOutboxEnqueueInput } from './outbox.js'
import { NcOutbox } from './outbox.js'
import type { NcRuleFireRef } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import type {
  AlarmArmMode,
  IScopedLogger,
  NcAlarmConfig,
  NcAlarmSensors,
  NcAlarmSensorsInput,
  NcAlarmSettingsPatch,
  NcRule,
} from '@camstack/types'
import { ruleAutoTriggersAlarm } from '@camstack/types'
import type { NcAlarmPanelPort, NotificationCenterDeps } from './index.js'

/**
 * One alarm transition's announcement: the composed body, when the words
 * depend on the rule set (null ⇒ the intake's catalog body), and the panel's
 * `announceTargets`.
 */
export interface NcAlarmAnnouncement {
  readonly text: NcArmAnnouncementText | null
  readonly targetIds: readonly string[]
}
/**
 * Synthetic rule id for an export's on-screen picker.
 *
 * The operator named these targets on the export screen, not in a rule. The
 * row still lives in the outbox so history, retry and language rendering are
 * the same path as every other notification. A matching `export-completed`
 * rule that already reached a target is skipped so one export is one push.
 */
export const NC_EXPORT_NOTIFY_RULE_ID = 'nc-export-notify'
/**
 * Is a bypassed (rule, input) pair still an input of that rule? The rule must
 * exist, be enabled, still press the panel, and — when it names devices —
 * still name the input or its camera, and not exclude the input. A false
 * "no" re-arms the input (protection restored), which is the safe direction.
 */
export function alarmRuleStillHasInput(
  rule: NcRule | null,
  entry: Pick<NcAlarmInputBypassRecord, 'deviceId' | 'cameraId'>,
): boolean {
  if (rule === null || !rule.enabled || !ruleAutoTriggersAlarm(rule)) return false
  if ((rule.conditions.devicesExclude ?? []).includes(entry.deviceId)) return false
  const scope = rule.conditions.devices
  if (scope === undefined || scope.length === 0) return true
  return scope.includes(entry.deviceId) || scope.includes(entry.cameraId)
}

export interface AlarmRuntimeHost {
  alarmAnnouncement(panel: NcAlarmPanelPort, transition: NcAlarmTransition): NcAlarmAnnouncement
  alarmConfig(): Promise<NcAlarmConfig>
  alarmLive(panel: NcAlarmPanelPort): Promise<NcAlarmLive>
  readonly alarmLiveReadLog: NcAlarmLiveReadLog
  readonly alarmPanel: NcAlarmPanelPort | null
  alarmSensors(input: NcAlarmSensorsInput): Promise<NcAlarmSensors>
  coverageFor(panel: NcAlarmPanelPort): readonly NcAlarmModeCoverage[]
  readonly deps: NotificationCenterDeps
  readonly deviceDirectory: NcDeviceDirectory
  deviceNameFromDirectory(): NcDeviceNameLookup
  enqueueAlarmAnnouncement(
    panel: NcAlarmPanelPort,
    incoming: NcIncomingEvent,
    announcement: NcAlarmAnnouncement,
    reached: ReadonlySet<string>,
  ): Promise<readonly string[]>
  evalChain: Promise<void>
  evaluateAndEnqueue(event: NcIncomingEvent): Promise<NcIntakeReport>
  readonly logger: IScopedLogger
  readonly outbox: NcOutbox
  readonly rules: NcRuleStore
  setAlarmConfig(patch: NcAlarmSettingsPatch): Promise<NcAlarmConfig>
  settleCombinedAlarm(
    transition: NcAlarmTransition,
    incoming: NcIncomingEvent,
    report: NcIntakeReport,
    reached: ReadonlySet<string>,
    announced: readonly string[],
  ): Promise<void>
}

/**
 * The alarm, for the `nc.*` bridge — the viewer's and the admin tab's
 * surface (`nc-actions.ts` decides who may call what). The same paths the cap
 * and the notification buttons take: `armWith`, `armAnyway`, `disarm` on the
 * panel, and the one config reader/writer below.
 */
export function alarmActions(host: AlarmRuntimeHost): NcAlarmActionDeps {
  const requirePanel = (): NcAlarmPanelPort => {
    const panel = host.alarmPanel
    if (panel === null) throw new Error('this node has no alarm panel')
    return panel
  }
  return {
    status: async () => {
      const panel = host.alarmPanel
      if (panel === null) return { deviceId: null, live: null }
      return { deviceId: panel.deviceId, live: await host.alarmLive(panel) }
    },
    // WHO pressed it, on the panel's own id — the panel logs what happened,
    // not who asked.
    arm: async (mode, userId) => {
      const panel = requirePanel()
      const outcome = await panel.armWith(mode)
      host.logger.info('alarm arm requested through the bridge', {
        tags: { deviceId: panel.deviceId },
        meta: { userId, mode, outcome: outcome.outcome },
      })
      return outcome
    },
    armAnyway: async (refusalId, userId) => {
      const panel = requirePanel()
      const outcome = await panel.armAnyway(refusalId)
      host.logger.info('alarm Arm anyway requested through the bridge', {
        tags: { deviceId: panel.deviceId },
        meta: { userId, refusalId, outcome: outcome.outcome },
      })
      return outcome
    },
    disarm: async (userId) => {
      const panel = requirePanel()
      await panel.disarm()
      host.logger.info('alarm disarm requested through the bridge', {
        tags: { deviceId: panel.deviceId },
        meta: { userId },
      })
    },
    // The app's twin of the trigger notification's Bypass button. The rule
    // mirror is the authority on whether this is an input at all.
    bypassInput: async ({ ruleId, deviceId }, userId) => {
      const panel = requirePanel()
      const rule = host.rules.get(ruleId) ?? null
      const entry = { deviceId, cameraId: deviceId }
      if (rule === null || !alarmRuleStillHasInput(rule, entry)) {
        host.logger.info('alarm input bypass refused — not an input of an alarm rule', {
          tags: { deviceId },
          meta: { userId, ruleId, panelDeviceId: panel.deviceId },
        })
        return { outcome: 'refused', reason: 'not-an-input' }
      }
      const outcome = panel.bypassInput({
        ruleId,
        ruleName: rule.name,
        deviceId,
        cameraId: deviceId,
      })
      host.logger.info('alarm input bypass requested through the bridge', {
        tags: { deviceId },
        meta: { userId, ruleId, rule: rule.name, outcome: outcome.outcome },
      })
      return outcome.outcome === 'refused'
        ? { outcome: 'refused', reason: outcome.reason }
        : { outcome: outcome.outcome, reason: null }
    },
    getConfig: () => host.alarmConfig(),
    getSensors: (input) => host.alarmSensors(input),
    setConfig: (patch) => host.setAlarmConfig(patch),
  }
}
/**
 * Which of the devices this mode covers are OPEN right now, and which could
 * not be read (D630).
 *
 * A TARGETED read of at most the handful of devices the mode's rules name,
 * not a refresh of the whole watched set: the arm is a person pressing a
 * button and the answer has to be about this second, but it must not become
 * a fan-out over every gated device on the hub. Read through
 * `readDeviceOpenings`, so a cover or a lock that is not secure is open too,
 * and a camera an intrusion rule names is `not-opening` and takes no part.
 *
 * Never a guess, in either direction (D49):
 *
 *  - a device the read could not answer for (absent), or whose opening slice
 *    carries a word its cap does not define (`unknown`), is UNKNOWN — it
 *    never blocks, is never counted secure, and says so in one line each;
 *  - a mode whose rules name no devices blocks nothing — an unscoped rule
 *    covers every device on the hub, and a refusal naming devices the
 *    operator never associated with the alarm is one they cannot act on;
 *  - when NOTHING could be read (no reader, the read threw, or every id came
 *    back absent) this THROWS, and the panel arms and announces that it
 *    armed without the check.
 */
export async function alarmOpenings(
  host: AlarmRuntimeHost,
  mode: AlarmArmMode,
): Promise<NcAlarmOpenings> {
  const panel = host.alarmPanel
  if (panel === null) return { open: [], unknown: [] }
  const candidates = alarmCoveredDevices(host.rules.list(), panel.deviceId, mode)
  if (candidates.length === 0) return { open: [], unknown: [] }
  const read = host.deps.readDeviceOpenings
  if (read === undefined) throw new Error('no openings reader is wired on this node')
  const openings = await read(candidates)
  if (openings.size === 0) {
    throw new Error(`none of the ${String(candidates.length)} covered devices could be read`)
  }
  const name = host.deviceNameFromDirectory()
  const open: NcAlarmOpenDevice[] = []
  const unknown: number[] = []
  for (const deviceId of candidates) {
    // The SAME classifier the live view uses (`classifyCoveredOpening`).
    const verdict = classifyCoveredOpening(openings.get(deviceId))
    if (verdict.kind === 'unknown') {
      unknown.push(deviceId)
      // A branch that drops work says so: this device could not take part
      // in the decision, and the arm goes ahead without it.
      host.logger.info('alarm arm check: device state unreadable — it cannot block this arm', {
        tags: { deviceId },
        meta: {
          panelDeviceId: panel.deviceId,
          mode,
          why: verdict.why,
          ...(verdict.why === 'unknown-word'
            ? { cap: verdict.cap, raw: rawForLog(verdict.raw) }
            : {}),
        },
      })
      continue
    }
    if (verdict.kind === 'open') {
      open.push({
        deviceId,
        name: name(deviceId),
        state: verdict.state,
        controllable: verdict.controllable,
        cap: verdict.cap,
      })
    }
  }
  host.logger.info('alarm arm check', {
    tags: { deviceId: panel.deviceId },
    meta: {
      mode,
      candidates: candidates.length,
      open: open.length,
      unknown: unknown.length,
      openIds: open.map((d) => d.deviceId).join(','),
    },
  })
  return { open, unknown }
}
/**
 * The panel as it is NOW — see `alarm-live.ts`.
 *
 * ONE read of the union of every mode's covered devices, so each is read
 * once however many modes cover it. A read that fails is not an error here:
 * every covered device is then `unknown` (D49) and the line says why — a
 * status the UI polls must not fail because a contact is asleep.
 */
export async function alarmLive(
  host: AlarmRuntimeHost,
  panel: NcAlarmPanelPort,
): Promise<NcAlarmLive> {
  const modes = panel.availableModes()
  const rules = host.rules.list()
  const covered = new Map(
    modes.map((mode) => [mode, alarmCoveredDevices(rules, panel.deviceId, mode)] as const),
  )
  const ids = alarmLiveReadIds(covered)
  let openings: ReadonlyMap<number, NcAlarmOpening> = new Map()
  const read = host.deps.readDeviceOpenings
  let outcome: NcAlarmLiveReadOutcome = { kind: 'ok' }
  if (ids.length > 0 && read === undefined) {
    outcome = { kind: 'no-reader', covered: ids.length }
  } else if (ids.length > 0 && read !== undefined) {
    try {
      openings = await read(ids)
      // `readAlarmOpenings` never throws — a device it could not read is
      // simply ABSENT, so a partial view is detected here.
      const unanswered = ids.filter((id) => !openings.has(id))
      if (unanswered.length > 0) {
        outcome = { kind: 'partial', covered: ids.length, unansweredIds: unanswered }
      }
    } catch (err) {
      outcome = {
        kind: 'threw',
        covered: ids.length,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  // Polled every 2–15 s: ONE line per change of the read's health, never
  // one per poll. The view itself still shows every unanswered device.
  const line = host.alarmLiveReadLog.next(panel.deviceId, outcome)
  if (line !== null) {
    host.logger[line.level](line.message, { tags: { deviceId: panel.deviceId }, meta: line.meta })
  }
  return buildAlarmLive({
    state: panel.currentState(),
    target: panel.currentTarget(),
    modes,
    covered,
    openings,
    nonBlocking: panel.settings().nonBlocking,
    exclusions: panel.exclusionPhases(),
    bypasses: panel.inputBypasses(),
    ruleName: (ruleId) => host.rules.get(ruleId)?.name,
    name: host.deviceNameFromDirectory(),
  })
}
/**
 * Put the alarm announcement in the outbox, under {@link NC_ALARM_ANNOUNCE_RULE_ID}.
 *
 * The row is what makes this a notification like any other: durable, retried,
 * visible in history, and rendered in the reader's language at send time
 * rather than frozen in the hub's at transition time. `recordId` is the
 * transition's own id, so every transition is a new row (cooldown 0) and a
 * replay of the same one is deduped.
 *
 * Targets a RULE already reached are skipped — one transition, one sentence,
 * one push per person, whichever path addressed them.
 */
export async function enqueueAlarmAnnouncement(
  host: AlarmRuntimeHost,
  panel: NcAlarmPanelPort,
  incoming: NcIncomingEvent,
  announcement: NcAlarmAnnouncement,
  reached: ReadonlySet<string>,
): Promise<readonly string[]> {
  const targets = announcement.targetIds.filter((id) => !reached.has(id))
  if (targets.length === 0) return []
  const subject = incoming.subject
  // The COMBINED siren: this row is the one push the target gets about the
  // incident, so it carries the triggering rule's pictures exactly as a
  // rule-reached combined row does (`buildEntries`). A source rule deleted
  // since degrades to no media, never to a broken row.
  const alarmSource = subject.systemEvent?.alarmSource
  const sourceRule = alarmSource !== undefined ? host.rules.get(alarmSource.ruleId) : null
  const media: NcMediaPolicyFields =
    sourceRule !== null
      ? mediaPolicyFields(
          sourceRule,
          ruleCropZoneIds(sourceRule),
          matchedTriggerZoneIds(sourceRule, ruleCropZoneIds(sourceRule), subject),
        )
      : { media: 'none' }
  // Whose event it is: the CAMERA that set it off when one did, else the
  // panel — same rule as `incomingFromAlarmTransition` / `buildEntries`.
  // Addressing the panel while the still owner is a camera track left the
  // announce path looking media-ready and then attaching nothing.
  const mediaDeviceId = alarmSource?.deviceId ?? panel.deviceId
  const entries: readonly NcOutboxEnqueueInput[] = targets.map((targetId) => ({
    ruleId: NC_ALARM_ANNOUNCE_RULE_ID,
    targetId,
    deviceId: mediaDeviceId,
    recordKind: 'system-event' as const,
    recordId: subject.recordId,
    payload: {
      ruleName: 'alarm',
      delivery: 'system-event' as const,
      priority: 2,
      ...media,
      subject: {
        deviceId: mediaDeviceId,
        // The media OWNERS of a combined row are the triggering detection's.
        ...(alarmSource?.trackId !== undefined ? { trackId: alarmSource.trackId } : {}),
        ...(alarmSource?.extraStills !== undefined && alarmSource.extraStills.length > 0
          ? { extraStills: alarmSource.extraStills.map((x) => ({ ...x })) }
          : {}),
        ...(alarmSource?.eventId !== undefined ? { eventId: alarmSource.eventId } : {}),
        className: 'alarm',
        zones: [],
        timestamp: subject.timestamp,
        ...(subject.systemEvent !== undefined ? { systemEvent: subject.systemEvent } : {}),
      },
    },
  }))
  const inserted = await host.outbox.enqueue(entries)
  host.logger.info('alarm announcement enqueued', {
    tags: { deviceId: panel.deviceId },
    meta: {
      kind: subject.systemEvent?.kind,
      targets: targets.length,
      inserted,
      bodyKey: subject.systemEvent?.bodyKey,
      media: media.media,
    },
  })
  return targets
}
/** The composed body of {@link alarmAnnouncement}, or null for a catalog body. */
export function alarmAnnouncementText(
  host: AlarmRuntimeHost,
  panel: NcAlarmPanelPort,
  transition: NcAlarmTransition,
): NcArmAnnouncementText | null {
  const kind = transition.kind
  const mode = transition.mode
  if (kind === 'alarm-arm-refused') {
    if (mode === undefined) return null
    return buildArmRefusedAnnouncement(
      mode,
      (transition.blocking ?? []).map((d) => d.name),
      transition.refusalId !== undefined,
    )
  }
  if (kind !== 'alarm-armed' && kind !== 'alarm-arming') return null
  if (mode === undefined) return null
  // Never fall back to the catalog `system.alarm-armed.body` /
  // `system.alarm-arming.body` shell: those are empty of the device lists.
  // A mode the panel does not currently offer still gets a composed
  // uncovered body rather than a title with a generic line under it.
  const coverage = host.coverageFor(panel).find((c) => c.mode === mode) ?? {
    mode,
    ruleCount: 0,
    allDevices: false,
    allDevicesExcept: [],
    deviceIds: [],
    skippedDevices: [],
  }
  const name = host.deviceNameFromDirectory()
  // What this arm is deliberately NOT watching, read off the panel — the one
  // authority for it. An arm that excluded a window has to say so in the
  // same sentence that says it is armed, or the operator's record of the
  // night says "Casa attivato" and nothing about the open window they
  // confirmed thirty seconds earlier.
  const bypassed = panel.excludedDevices()
  const text =
    kind === 'alarm-arming'
      ? buildArmingAnnouncement(coverage, transition.seconds ?? 0, name, bypassed)
      : buildArmAnnouncement(coverage, name, bypassed)
  const gap = alarmCoverageGap(coverage)
  if (gap !== null) {
    // The notification SAYS this, so the line is no longer the only record
    // of it — but it is still the only place the operator can grep for "why
    // did the alarm do nothing last night".
    host.logger.warn('alarm armed into a mode that watches nothing', {
      tags: { deviceId: panel.deviceId },
      meta: {
        mode,
        kind,
        gap,
        rules: coverage.ruleCount,
        devices: coverage.deviceIds.length,
        skipped: coverage.skippedDevices.length,
      },
    })
  }
  return text
}
/**
 * The COMBINED notification's second half: withdraw what it replaced.
 *
 * Only for the targets the alarm actually reached, and only while their rows
 * are still pending. An entry delay means the rule's notification usually
 * went out twenty seconds ago — that is not a duplicate, it is the
 * escalation, and this says so rather than silently doing nothing.
 */
export async function settleCombinedAlarm(
  host: AlarmRuntimeHost,
  transition: NcAlarmTransition,
  incoming: NcIncomingEvent,
  report: NcIntakeReport,
  reached: ReadonlySet<string>,
  announced: readonly string[],
): Promise<void> {
  if (transition.kind !== 'alarm-triggered') return
  const tags = { deviceId: incoming.subject.deviceId }
  const source = transition.source
  if (reached.size === 0 && announced.length === 0) {
    // A siren nobody is told about. NOT silent: the rule that set it off has
    // still notified, so the operator is not in the dark — but "no enabled
    // rule is gated on alarm-triggered" is a configuration gap, and it is
    // invisible from the outside.
    host.logger.warn('alarm TRIGGERED but neither a rule nor an announce target heard it', {
      tags,
      meta: {
        candidates: report.candidates,
        ...(source !== undefined ? { sourceRuleId: source.ruleId } : {}),
      },
    })
    return
  }
  if (source === undefined) return
  // EVERY target the alarm reached — through a rule or as one of the panel's
  // own recipients: either way that phone now holds the combined row, and the
  // triggering rule's still-pending row would be a second push about the
  // same incident.
  const combined = new Set([...reached, ...announced])
  // The SOURCE and every follower (D705): the combined row now carries each of
  // their pictures, so each one's still-pending row is the same second push.
  const supersede = (ref: NcRuleFireRef): Promise<number> =>
    host.outbox.supersede({
      ruleId: ref.ruleId,
      // The RECORD, not its id alone (D694): a rowid can be reused.
      recordId: ref.recordId,
      deviceId: ref.deviceId,
      recordAt: ref.timestamp,
      targetIds: [...combined],
    })
  const dropped = await supersede(source)
  const followers = transition.followers ?? []
  let followersSuperseded = 0
  for (const follower of followers) followersSuperseded += await supersede(follower)
  host.logger.info('alarm notification combined with the rule that triggered it', {
    tags,
    meta: {
      sourceRuleId: source.ruleId,
      rule: source.ruleName,
      targets: combined.size,
      announced: announced.length,
      superseded: dropped,
      // The incident's other subjects (D705), tiled with the source, and how many
      // of their own rows were still pending.
      followers: followers.length,
      followersSuperseded,
      alreadyDelivered: combined.size - dropped,
    },
  })
}
/**
 * Deliver to targets the producer named (`controls.directTargetIds`).
 *
 * Skips ids a matching rule already reached so one export is one push.
 * Absent/empty is a no-op — every other producer omits the control.
 */
export async function enqueuePickerTargets(
  host: AlarmRuntimeHost,
  event: NcIncomingEvent,
  reached: ReadonlySet<string>,
  outcomes: NcRuleOutcome[],
): Promise<void> {
  const ids = event.controls?.directTargetIds
  if (ids === undefined || ids.length === 0) return
  const targets = [...new Set(ids)].filter((id) => !reached.has(id))
  if (targets.length === 0) return
  const subject = event.subject
  const entries: readonly NcOutboxEnqueueInput[] = targets.map((targetId) => ({
    ruleId: NC_EXPORT_NOTIFY_RULE_ID,
    targetId,
    deviceId: subject.deviceId,
    recordKind: 'system-event' as const,
    recordId: subject.recordId,
    payload: {
      ruleName: 'export',
      delivery: 'system-event' as const,
      priority: 2,
      media: 'none' as const,
      subject: {
        deviceId: subject.deviceId,
        className: 'export',
        zones: [],
        timestamp: subject.timestamp,
        ...(subject.systemEvent !== undefined ? { systemEvent: subject.systemEvent } : {}),
      },
    },
  }))
  const inserted = await host.outbox.enqueue(entries)
  outcomes.push({
    ruleId: NC_EXPORT_NOTIFY_RULE_ID,
    ruleName: 'export',
    matched: true,
    cooldown: 'n/a',
    enqueued: inserted,
    targetIds: entries.map((entry) => entry.targetId),
  })
  host.logger.info('export picker notification enqueued', {
    tags: { deviceId: subject.deviceId },
    meta: { targets: targets.length, inserted },
  })
}
/**
 * The alarm's transition, through the ordinary intake — and then the two
 * things that are only true of an alarm.
 *
 * On the SAME serialized chain as every other evaluation, because both of
 * those follow-ups read what the evaluation just enqueued:
 *
 *  - Panel `announceTargets` are NOT addressed (retired 2026-10-03): only
 *    alarm-family rules deliver. The announce enqueue is a no-op.
 *  - a TRIGGERED with an attribution supersedes the triggering rule's own
 *    still-pending rows, for exactly the targets the alarm reached. That is
 *    the combined notification: one row carrying the alarm's words and that
 *    rule's pictures, instead of two pushes about one incident.
 */
export function scheduleAlarmTransition(
  host: AlarmRuntimeHost,
  panel: NcAlarmPanelPort,
  transition: NcAlarmTransition,
): void {
  const announcement = host.alarmAnnouncement(panel, transition)
  const incoming = incomingFromAlarmTransition({
    transition,
    panelDeviceId: panel.deviceId,
    lookup: host.deviceDirectory.lookup(),
    ...(announcement.text !== null ? { body: announcement.text } : {}),
  })
  host.evalChain = host.evalChain.then(async () => {
    try {
      const report = await host.evaluateAndEnqueue(incoming)
      const reached = new Set(report.outcomes.flatMap((o) => o.targetIds))
      const announced = await host.enqueueAlarmAnnouncement(panel, incoming, announcement, reached)
      await host.settleCombinedAlarm(transition, incoming, report, reached, announced)
    } catch (err) {
      host.logger.warn('alarm transition evaluation failed', {
        tags: { deviceId: panel.deviceId },
        meta: { kind: transition.kind, state: transition.state, error: String(err) },
      })
    }
  })
}

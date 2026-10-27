/**
 * Extracted from NotificationCenter (applyGrantedSnooze, applyGrantedAlarm, applyGrantedArmAnyway, applyGrantedBypassInput, runGrantedAction, applyGrantedAddonUpdate, applyGrantedServerUpdate, announceServerUpdate, announceAddonUpdate, runGrantedSequence).
 * The class method forwards private state through {@link GrantedActionsHost}.
 */

import type {
  NcActionGrant,
  NcAddonUpdateGrant,
  NcAlarmArmAnywayGrant,
  NcAlarmBypassInputGrant,
  NcAlarmGrant,
  NcDetectionVerdictGrant,
  NcSequenceGrant,
  NcServerUpdateGrant,
  NcSnoozeGrant,
} from './action-token.js'
import { NcActionRefusedError } from './action-token.js'
import type { NcAddonUpdateOutcome, NcAddonUpdateReport } from './addon-update-apply.js'
import { addonUpdateSentence, pendingPackages } from './addon-update-apply.js'
import type {
  NcAlarmArmAnywayRejection,
  NcAlarmInputBypassRefusal,
} from './alarm/alarm-panel-device.js'
import type { NcDetectionVerdictLedger } from './detection-verdict-ledger.js'
import { NcDispatcher } from './dispatcher.js'
import { NcRuleActionRunner, asForcedSequence } from './rule-actions.js'
import type { NcRuleFireRef } from './rule-engine.js'
import { NcRuleStore } from './rule-store.js'
import { NcSequenceStore } from './sequence-store.js'
import { isSnoozeExempt } from './snooze-exempt.js'
import { NcSnoozeStore } from './snooze-store.js'
import { NcTextCatalog } from './text-catalog.js'
import type { IScopedLogger } from '@camstack/types'
import { alarmPanelCapability } from '@camstack/types'
import type { NcAlarmPanelPort, NotificationCenterDeps } from './index.js'

/** The one cap whose `trigger` the combined alarm notification joins on. */
export const ALARM_PANEL_CAP: string = alarmPanelCapability.name
/**
 * What a pressed Arm anyway that did nothing tells the person holding the
 * phone — one sentence per reason the panel refused it.
 */
export const ARM_ANYWAY_REJECTION_COPY: Readonly<Record<NcAlarmArmAnywayRejection, string>> = {
  stale: 'The alarm changed since this notification — nothing was armed',
  expired: 'This button expired — arm again from the app',
  used: 'Already used',
  'unknown-refusal': 'This refusal is no longer current — arm again',
}
/** What a pressed Bypass that did nothing tells the person holding the phone. */
export const BYPASS_INPUT_REFUSAL_COPY: Readonly<Record<NcAlarmInputBypassRefusal, string>> = {
  disarmed: 'The alarm is disarmed — nothing to bypass',
  stale: 'The alarm was re-armed since this notification — nothing was bypassed',
  full: 'Too many inputs are bypassed already — disarm to reset them',
}

export interface GrantedActionsHost {
  readonly actionRunner: NcRuleActionRunner | null
  actuateWithAttribution(input: {
    readonly deviceId: number
    readonly cap: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly origin?: NcRuleFireRef
  }): Promise<void>
  readonly alarmPanel: NcAlarmPanelPort | null
  announceAddonUpdate(
    grant: NcAddonUpdateGrant,
    sentence: 'started' | 'uptodate' | 'done' | 'partial' | 'unknown',
    vars: Readonly<Record<string, string>>,
    report?: NcAddonUpdateReport,
    count?: number,
  ): Promise<void>
  announceServerUpdate(
    grant: NcServerUpdateGrant,
    sentence: 'started' | 'restarting' | 'uptodate' | 'unknown' | 'failed',
    vars: Readonly<Record<string, string>>,
  ): Promise<void>
  applyGrantedAddonUpdate(grant: NcAddonUpdateGrant): Promise<void>
  applyGrantedAlarm(grant: NcAlarmGrant): Promise<void>
  applyGrantedArmAnyway(panel: NcAlarmPanelPort, grant: NcAlarmArmAnywayGrant): Promise<void>
  applyGrantedBypassInput(panel: NcAlarmPanelPort, grant: NcAlarmBypassInputGrant): Promise<void>
  applyGrantedServerUpdate(grant: NcServerUpdateGrant): Promise<void>
  applyGrantedDetectionVerdict(grant: NcDetectionVerdictGrant): Promise<void>
  applyGrantedSnooze(grant: NcSnoozeGrant): Promise<void>
  readonly deps: NotificationCenterDeps
  readonly dispatcher: NcDispatcher
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly rules: NcRuleStore
  runGrantedSequence(grant: NcSequenceGrant): Promise<void>
  readonly sequenceActionsOf: (
    sequenceId: string,
  ) => readonly import('@camstack/types').NcRuleAction[] | undefined
  readonly sequences: NcSequenceStore
  readonly snoozes: NcSnoozeStore
  readonly texts: NcTextCatalog
  readonly verdicts: NcDetectionVerdictLedger
}

/**
 * Open the window a snooze button granted.
 *
 * Personal, always: `grant.userId` was frozen when the notification was
 * addressed, and a tap identifies nobody — so the worst a forwarded
 * notification can do is silence the person it was already sent to.
 *
 * `summary: false`, deliberately, and this is the one place the app's
 * default is inverted. A window opened from the APP is a decision somebody
 * sat down to make ("silence the garden until 18:00"), and a digest of what
 * it hid is what makes that safe. A window opened from a lock screen is a
 * dismissal — answering it half an hour later with a summary of the
 * notifications it hid re-delivers exactly what the operator just said they
 * did not want.
 */
export async function applyGrantedSnooze(
  host: GrantedActionsHost,
  grant: NcSnoozeGrant,
): Promise<void> {
  const rule = host.rules.get(grant.ruleId)
  // The exemption is re-checked at REDEMPTION, not just at mint: a rule
  // edited into an alarm rule between the two must not be silenceable by a
  // token minted before the edit.
  if (rule !== null && isSnoozeExempt(rule, host.sequenceActionsOf)) {
    throw new Error(`"${grant.ruleName}" is an alarm rule and cannot be snoozed`)
  }
  const snooze = await host.snoozes.create({
    userId: grant.userId,
    // A camera window, because that is what the operator pointed at — the
    // rule is provenance (D133). A person silencing the cat on 102 does not
    // know which of their rules produced this notification.
    scope: 'device',
    deviceId: grant.deviceId,
    ...(grant.classes !== undefined && grant.classes.length > 0 ? { classes: grant.classes } : {}),
    durationMinutes: grant.minutes,
    global: false,
    summary: false,
  })
  host.logger.info('snooze opened from a notification button', {
    tags: { deviceId: grant.deviceId },
    meta: {
      snoozeId: snooze.id,
      by: grant.userId,
      minutes: grant.minutes,
      classes: grant.classes ?? null,
      ruleId: grant.ruleId,
    },
  })
}
/** Arm or disarm the panel a button granted. Throws when the panel is gone —
 *  the plane turns that into the page that says so. */
export async function applyGrantedAlarm(
  host: GrantedActionsHost,
  grant: NcAlarmGrant,
): Promise<void> {
  const panel = host.alarmPanel
  if (panel === null) throw new Error('this node has no alarm panel')
  if (panel.deviceId !== grant.panelDeviceId) {
    // The panel was re-created between mint and tap. Refusing is the only
    // safe answer: a token minted for one panel must never move another.
    throw new Error('this button was minted for a different alarm panel')
  }
  // BEFORE the actuator check, deliberately: an Arm anyway never goes through
  // `actuate` — it is `panel.armAnyway(refusalId)` in-process (the cap has
  // no field for a refusal) — so a node with no actuator can still honour it.
  if (grant.action === 'arm-anyway') return host.applyGrantedArmAnyway(panel, grant)
  // In-process too: the alarm-panel cap has no notion of a rule's input.
  if (grant.action === 'bypass-input') return host.applyGrantedBypassInput(panel, grant)
  if (host.deps.actuate === undefined) throw new Error('no actuator is wired on this node')
  // Through the SAME seam a rule's step takes: no `origin`, because nobody
  // is attributing this to a detection — a person pressed it.
  await host.actuateWithAttribution({
    deviceId: panel.deviceId,
    cap: ALARM_PANEL_CAP,
    method: grant.action,
    args: grant.action === 'arm' && grant.mode !== undefined ? { mode: grant.mode } : {},
  })
}
/**
 * The Arm anyway on a refusal notification — IN-PROCESS, `armAnyway(refusalId)`,
 * never the cap: `alarm-panel.arm` has no field for a refusal, and a plain
 * arm would simply be refused again.
 *
 * The token claim is already atomic and single-use; the panel adds its own
 * one-shot on the refusal, so a second phone's copy of the same button is
 * `used`. Every way it does nothing throws a sentence the page shows.
 */
export async function applyGrantedArmAnyway(
  host: GrantedActionsHost,
  panel: NcAlarmPanelPort,
  grant: NcAlarmArmAnywayGrant,
): Promise<void> {
  const outcome = await panel.armAnyway(grant.refusalId)
  switch (outcome.outcome) {
    case 'rejected':
      throw new NcActionRefusedError(ARM_ANYWAY_REJECTION_COPY[outcome.reason])
    case 'refused':
      // A NEW blocker. The new refusal's own notification — with its own
      // Arm anyway — has already been sent by `armAnyway`.
      throw new NcActionRefusedError('Something else is open now — see the new notification')
    case 'arming':
    case 'armed':
      host.logger.info('alarm armed from a refusal notification (Arm anyway)', {
        tags: { deviceId: panel.deviceId },
        meta: {
          refusalId: grant.refusalId,
          outcome: outcome.outcome,
          excluded: outcome.excluded.length,
          targetId: grant.targetId ?? null,
        },
      })
      return
  }
}
/**
 * "Bypass this input until disarm", from a trigger notification — the (rule,
 * input) pair the grant froze, on the panel, in-process. The token is the
 * whole of the authority (D47), exactly as for the Disarm beside it; the
 * panel refuses a disarmed alarm and an arm session that is already over.
 */
export async function applyGrantedBypassInput(
  host: GrantedActionsHost,
  panel: NcAlarmPanelPort,
  grant: NcAlarmBypassInputGrant,
): Promise<void> {
  const outcome = panel.bypassInput({
    ruleId: grant.ruleId,
    ruleName: grant.ruleName,
    deviceId: grant.inputDeviceId,
    cameraId: grant.cameraId,
    notedAt: grant.notedAt,
  })
  if (outcome.outcome === 'refused') {
    throw new NcActionRefusedError(BYPASS_INPUT_REFUSAL_COPY[outcome.reason])
  }
  host.logger.info('alarm input bypassed from a notification button', {
    tags: { deviceId: grant.inputDeviceId },
    meta: {
      panelDeviceId: panel.deviceId,
      ruleId: grant.ruleId,
      rule: grant.ruleName,
      outcome: outcome.outcome,
      targetId: grant.targetId ?? null,
    },
  })
}
/**
 * Run the sequence a spent token granted.
 *
 * **The grant overrides `enabled`, deliberately.** A sequence reachable only
 * by a button is written as `enabled: false` — that is how "do not run this
 * automatically" is expressed — and the runner skips a disabled sequence. For
 * a granted run the BUTTON is the enablement, and the operator tapping it is
 * a more explicit instruction than the flag it overrides. The per-sequence
 * throttle still applies: `minDelaySec` is about how often a gate may
 * physically move, and a tap does not change that.
 *
 * Throws when the sequence is gone or a step failed — the plane turns that
 * into the page that says so.
 */
export async function runGrantedAction(
  host: GrantedActionsHost,
  grant: NcActionGrant,
): Promise<void> {
  switch (grant.kind) {
    case 'snooze':
      return host.applyGrantedSnooze(grant)
    case 'alarm':
      return host.applyGrantedAlarm(grant)
    case 'sequence':
      return host.runGrantedSequence(grant)
    case 'addon-update':
      return host.applyGrantedAddonUpdate(grant)
    case 'server-update':
      return host.applyGrantedServerUpdate(grant)
    case 'detection-verdict':
      return host.applyGrantedDetectionVerdict(grant)
  }
}

/** What a person is told when the retrain lifecycle refuses the mark. */
export const VERDICT_REFUSAL_COPY: Readonly<
  Record<'trained' | 'budget' | 'unknown-track', string>
> = {
  trained: 'This track was already used for training — nothing was changed',
  budget: 'This camera already holds as many tracks for retraining as it may — nothing was changed',
  'unknown-track': 'This track is no longer available — nothing was changed',
}

/**
 * Mark the track one notification reported for retraining, and record who was
 * asked and when.
 *
 * Order matters. The MARK goes first and is the authority: a refusal ("already
 * trained", "budget full") means the operator's answer changed nothing, so no
 * ledger row is written for an answer that was not applied. The token is
 * already spent (D47) — the refusal is shown as the reason, not a retry.
 */
export async function applyGrantedDetectionVerdict(
  host: GrantedActionsHost,
  grant: NcDetectionVerdictGrant,
): Promise<void> {
  const mark = host.deps.markTrackForRetrain
  if (mark === undefined) throw new Error('no retrain mark is wired on this node')
  const outcome = await mark({ deviceId: grant.deviceId, trackId: grant.trackId })
  if (!outcome.ok) {
    host.logger.info('detection verdict changed nothing — the retrain flow refused the mark', {
      tags: { deviceId: grant.deviceId },
      meta: { trackId: grant.trackId, reason: outcome.reason, verdict: grant.verdict },
    })
    throw new NcActionRefusedError(VERDICT_REFUSAL_COPY[outcome.reason])
  }
  await host.verdicts.record({
    trackId: grant.trackId,
    deviceId: grant.deviceId,
    verdict: grant.verdict,
    ...(grant.suggestedClass !== undefined ? { suggestedClass: grant.suggestedClass } : {}),
    userId: grant.userId,
    ruleId: grant.ruleId,
    ruleName: grant.ruleName,
    at: host.now(),
  })
}
/**
 * Apply the addon updates one notification was about.
 *
 * The whole shape of this method is the answer to "a button that reports
 * success for work it did not do":
 *
 *  1. **The cheap question first.** Ask the registry what is still out of
 *     date on that node. A read that FAILS changes nothing and says so — it
 *     is never read as "everything is current" and never as "apply the frozen
 *     list anyway".
 *  2. **Nothing to do is an outcome, not a success.** A frozen list the
 *     operator already applied (from the Addons page, from auto-update, or by
 *     tapping the copy of this notification that went to their other phone)
 *     produces one announcement and zero `updatePackage` calls.
 *  3. **The operator hears twice.** A background POST returns while the
 *     updates run for minutes, so the tap is acknowledged BEFORE the first
 *     apply and the verdict follows it. Tapping into silence is worse than no
 *     button.
 *
 * The announcements go back to `grant.targetId` — the delivery this button
 * was minted for, which is the only addressee a tap can honestly name (a tap
 * identifies nobody; same reasoning as the snooze grant's frozen `userId`).
 *
 * Throws only when NOTHING was applied and something went wrong, so the
 * plane's line says the run failed rather than reporting a spent token as a
 * success.
 */
export async function applyGrantedAddonUpdate(
  host: GrantedActionsHost,
  grant: NcAddonUpdateGrant,
): Promise<void> {
  const apply = host.deps.applyAddonUpdate
  const list = host.deps.listAddonUpdates
  if (apply === undefined || list === undefined) {
    throw new Error('no addon updater is wired on this node')
  }

  let updatable: readonly string[]
  try {
    updatable = await list(grant.nodeId)
  } catch (err) {
    host.logger.warn('addon update button changed nothing — could not read what needs updating', {
      meta: { nodeId: grant.nodeId, packages: grant.packages, error: String(err) },
    })
    await host.announceAddonUpdate(grant, 'unknown', { nodeId: grant.nodeId })
    throw err instanceof Error ? err : new Error(String(err))
  }

  const pending = pendingPackages(grant.packages, updatable)
  const skipped = grant.packages.filter((name) => !pending.includes(name))
  if (pending.length === 0) {
    host.logger.info('addon update button applied nothing — every package is already current', {
      meta: { nodeId: grant.nodeId, packages: grant.packages },
    })
    await host.announceAddonUpdate(
      grant,
      'uptodate',
      { nodeId: grant.nodeId },
      { requested: grant.packages.length, applied: [], skipped, failed: [] },
    )
    return
  }

  await host.announceAddonUpdate(
    grant,
    'started',
    { count: String(pending.length), nodeId: grant.nodeId },
    undefined,
    pending.length,
  )

  const applied: string[] = []
  const failed: string[] = []
  for (const packageName of pending) {
    try {
      const result = await apply({ packageName, nodeId: grant.nodeId })
      if (result.ok) {
        applied.push(packageName)
      } else {
        failed.push(packageName)
        host.logger.warn('addon update from a notification button failed', {
          meta: { nodeId: grant.nodeId, packageName, error: result.error },
        })
      }
    } catch (err) {
      failed.push(packageName)
      host.logger.warn('addon update from a notification button threw', {
        meta: { nodeId: grant.nodeId, packageName, error: String(err) },
      })
    }
  }

  const report: NcAddonUpdateReport = {
    requested: grant.packages.length,
    applied,
    skipped,
    failed,
  }
  host.logger.info('addon updates applied from a notification button', {
    meta: {
      nodeId: grant.nodeId,
      requested: report.requested,
      applied: applied.length,
      skipped: skipped.length,
      failed,
    },
  })
  await host.announceAddonUpdate(
    grant,
    addonUpdateSentence(report),
    {
      nodeId: grant.nodeId,
      applied: String(applied.length),
      skipped: String(skipped.length),
      failed: String(failed.length),
    },
    report,
    applied.length,
  )
  if (applied.length === 0 && failed.length > 0) {
    throw new Error(`no package updated on ${grant.nodeId} (${failed.join(', ')})`)
  }
}
/**
 * Stage the server update one notification was about.
 *
 * The shape matches the addon-update runner, with one extra constraint: the
 * **start announcement leaves BEFORE apply**. Applying the hub kills this
 * process; a tap that went into silence because the process died mid-apply
 * is worse than no button. The reboot itself is confirmed by the existing
 * `server-updated` event on reconnect — this method does not wait for it.
 *
 * Throws when nothing was staged and something went wrong, so the plane's
 * line says the run failed rather than reporting a spent token as a success.
 */
export async function applyGrantedServerUpdate(
  host: GrantedActionsHost,
  grant: NcServerUpdateGrant,
): Promise<void> {
  const apply = host.deps.applyServerUpdate
  const check = host.deps.checkServerUpdate
  if (apply === undefined || check === undefined) {
    throw new Error('no server updater is wired on this node')
  }

  let stillAvailable: boolean
  try {
    stillAvailable = await check(grant.nodeId)
  } catch (err) {
    host.logger.warn(
      'server update button changed nothing — could not read whether an update is still needed',
      { meta: { nodeId: grant.nodeId, error: String(err) } },
    )
    await host.announceServerUpdate(grant, 'unknown', { nodeId: grant.nodeId })
    throw err instanceof Error ? err : new Error(String(err))
  }

  if (!stillAvailable) {
    host.logger.info('server update button applied nothing — already current', {
      meta: { nodeId: grant.nodeId },
    })
    await host.announceServerUpdate(grant, 'uptodate', { nodeId: grant.nodeId })
    return
  }

  // BEFORE apply. The hub dies in apply; this sentence must already have
  // left. An agent (or a hub whose staging returns before restart) hears
  // `restarting` after.
  await host.announceServerUpdate(grant, 'started', { nodeId: grant.nodeId })

  let result: NcAddonUpdateOutcome
  try {
    result = await apply({ nodeId: grant.nodeId })
  } catch (err) {
    host.logger.warn('server update from a notification button threw', {
      meta: { nodeId: grant.nodeId, error: String(err) },
    })
    await host.announceServerUpdate(grant, 'failed', { nodeId: grant.nodeId })
    throw err instanceof Error ? err : new Error(String(err))
  }
  if (!result.ok) {
    host.logger.warn('server update from a notification button was refused', {
      meta: { nodeId: grant.nodeId, error: result.error },
    })
    await host.announceServerUpdate(grant, 'failed', { nodeId: grant.nodeId })
    throw new Error(result.error)
  }

  host.logger.info('server update staged from a notification button', {
    meta: { nodeId: grant.nodeId },
  })
  await host.announceServerUpdate(grant, 'restarting', { nodeId: grant.nodeId })
}
/**
 * One sentence about a server-update tap, to the target the notification
 * went to. Best-effort — `deliverAnnouncement` never throws — because an
 * announcement that failed must not turn a staging that HAPPENED into a run
 * the plane reports as failed.
 */
export async function announceServerUpdate(
  host: GrantedActionsHost,
  grant: NcServerUpdateGrant,
  sentence: 'started' | 'restarting' | 'uptodate' | 'unknown' | 'failed',
  vars: Readonly<Record<string, string>>,
): Promise<void> {
  const targetId = grant.targetId
  if (targetId === undefined) return
  await host.dispatcher.deliverAnnouncement({
    reason: `server-update-${sentence}`,
    targetId,
    title: host.texts.text({ key: 'action.server-update.title' }),
    body: host.texts.text({ key: `action.server-update.${sentence}`, vars }),
  })
}
/**
 * One sentence about an update tap, to the target the notification went to.
 *
 * Best-effort by construction — `deliverAnnouncement` never throws and never
 * retries — because an announcement that failed must not turn an update that
 * HAPPENED into a run the plane reports as failed.
 */
export async function announceAddonUpdate(
  host: GrantedActionsHost,
  grant: NcAddonUpdateGrant,
  sentence: 'started' | 'uptodate' | 'done' | 'partial' | 'unknown',
  vars: Readonly<Record<string, string>>,
  report?: NcAddonUpdateReport,
  count?: number,
): Promise<void> {
  const targetId = grant.targetId
  if (targetId === undefined) return
  const body = host.texts.text({
    key: `action.addon-update.${sentence}`,
    vars,
    ...(count !== undefined ? { count } : {}),
  })
  const failedNames = report?.failed ?? []
  await host.dispatcher.deliverAnnouncement({
    reason: `addon-update-${sentence}`,
    targetId,
    title: host.texts.text({ key: 'action.addon-update.title' }),
    body: failedNames.length > 0 ? `${body}\n${failedNames.join(', ')}` : body,
  })
}
export async function runGrantedSequence(
  host: GrantedActionsHost,
  grant: NcSequenceGrant,
): Promise<void> {
  if (host.actionRunner === null) throw new Error('no actuator is wired on this node')
  const rule = host.rules.get(grant.ruleId)
  if (rule === null) throw new Error(`rule ${grant.ruleId} no longer exists`)
  const sequence = host.sequences.get(grant.sequenceId)
  if (sequence === null) {
    throw new Error(`sequence "${grant.sequenceId}" no longer exists`)
  }
  const [outcome] = await host.actionRunner.run({
    ruleId: rule.id,
    ruleName: rule.name,
    deviceId: grant.deviceId,
    sequences: [asForcedSequence(sequence)],
  })
  if (outcome === undefined) throw new Error('the sequence did not run')
  if (outcome.failedAt !== undefined) {
    throw new Error(`step ${String(outcome.failedAt)} of "${sequence.name}" failed`)
  }
  if (!outcome.ran) {
    throw new Error(`"${sequence.name}" did not run (${outcome.skippedReason ?? 'unknown'})`)
  }
}

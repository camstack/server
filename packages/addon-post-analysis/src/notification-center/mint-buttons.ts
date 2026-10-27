/**
 * Extracted from NotificationCenter (mintButtons, snoozeButtonLabel).
 * The class method forwards private state through {@link MintButtonsHost}.
 */

import type { NcAlarmButtonKind, NcAlarmBypassableInput } from './action-buttons.js'
import { verdictButtonRefusal, verdictButtonSpecs } from './detection-verdict-buttons.js'
import { buildActionButtons, buildAlarmButtons, buildSnoozeButtons } from './action-buttons.js'
import type { NcActionGrant } from './action-token.js'
import { NcActionTokenRegistry, actionTtlMs } from './action-token.js'
import { addonUpdateButtonRefusal, buildAddonUpdateButtons } from './addon-update-buttons.js'
import { intrusionDeviceOf } from './alarm/alarm-push-policy.js'
import type { NcMintButtonsInput, NcOutboxSystemEvent } from './dispatcher.js'
import { NcRuleActionRunner } from './rule-actions.js'
import { NcRuleStore } from './rule-store.js'
import { NcSequenceStore } from './sequence-store.js'
import { buildServerUpdateButtons, serverUpdateButtonRefusal } from './server-update-buttons.js'
import { NcTextCatalog } from './text-catalog.js'
import type { IScopedLogger, NcSystemEventKind, NotificationAction } from '@camstack/types'
import { randomUUID } from 'node:crypto'
import type { NcAlarmPanelPort, NotificationCenterDeps } from './index.js'

/**
 * The synthetic rule id an alarm ANNOUNCEMENT is enqueued under.
 *
 * The arm announcement is addressed to the panel's own `announceTargets`, not
 * to a rule's — but it is a notification like any other and must live in the
 * same table, or "did I get told the alarm armed?" is answerable for every
 * notification this hub sends except the ones about the alarm. It used to ride
 * a parallel fire-and-forget channel (`deliverAnnouncement`) that left no row,
 * no retry and no history.
 */
export const NC_ALARM_ANNOUNCE_RULE_ID = 'nc-alarm-announce'
/**
 * One button on its way to a phone: the id its callback carries, how long that
 * callback lives, and the grant to register once the expiry is known.
 *
 * The grant is a THUNK because the URL is signed over `(id, exp)` and the
 * expiry differs per family — a disarm link outlives its notification by five
 * minutes, a snooze one by an hour.
 */
export interface NcButtonDraft {
  readonly id: string
  readonly ttlMs: number
  readonly grant: (expiresAt: number) => NcActionGrant
}
/**
 * Which alarm buttons a notification of this kind should carry, or `null` for
 * every notification that is not about the panel.
 *
 * Derived from the transition the row REPORTS rather than from the panel's
 * state now: the row may have waited in the outbox, and offering "Disarm" on a
 * notification that says the alarm was disarmed is worse than offering nothing.
 */
export function alarmButtonKind(kind: NcSystemEventKind | undefined): NcAlarmButtonKind | null {
  switch (kind) {
    case 'alarm-triggered':
    case 'alarm-armed':
    case 'alarm-arming':
    case 'alarm-disarmed':
    case 'alarm-pending':
    case 'alarm-rearmed':
    case 'alarm-check-failed':
    case 'alarm-arm-refused':
    case 'alarm-sensor-bypass':
      return kind
    default:
      return null
  }
}
/**
 * The (rule, input) pair an `alarm-triggered` / `alarm-pending` row is about,
 * from the source it FROZE (`alarmSource`). Undefined on a manual trigger.
 */
export function rowBypassableInput(
  systemEvent: NcOutboxSystemEvent | undefined,
): NcAlarmBypassableInput | undefined {
  const kind = systemEvent?.kind
  if (kind !== 'alarm-triggered' && kind !== 'alarm-pending') return undefined
  const source = systemEvent?.alarmSource
  if (source === undefined) return undefined
  return {
    ruleId: source.ruleId,
    ruleName: source.ruleName,
    inputDeviceId: intrusionDeviceOf(source),
    cameraId: source.deviceId,
    notedAt: source.timestamp,
  }
}
/** The refusal id an `alarm-arm-refused` row froze (`incomingFromAlarmTransition`). */
export function rowRefusalId(systemEvent: NcOutboxSystemEvent | undefined): string | undefined {
  const value = systemEvent?.data['refusalId']
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export interface MintButtonsHost {
  readonly actionRunner: NcRuleActionRunner | null
  readonly actionTokens: NcActionTokenRegistry
  readonly alarmPanel: NcAlarmPanelPort | null
  readonly deps: NotificationCenterDeps
  readonly logger: IScopedLogger
  readonly now: () => number
  readonly rules: NcRuleStore
  readonly sequenceActionsOf: (
    sequenceId: string,
  ) => readonly import('@camstack/types').NcRuleAction[] | undefined
  readonly sequences: NcSequenceStore
  snoozeButtonLabel(minutes: number): string
  readonly texts: NcTextCatalog
}

/**
 * The tap-through buttons for ONE delivery, each with its own single-use
 * token.
 *
 * Per delivery, not per notification: the first tap spends the token, so two
 * recipients sharing one would mean the second person's button was already
 * dead when it arrived.
 *
 * Returns `[]` for every ordinary reason — the rule declares no buttons, no
 * actuator is wired, no reachable URL exists. A button is an enhancement; not
 * being able to mint one must never cost the notification.
 */
export async function mintButtons(
  host: MintButtonsHost,
  input: NcMintButtonsInput,
): Promise<readonly NotificationAction[]> {
  const mint = host.deps.mintActionUrl
  if (mint === undefined) return []
  const stored = host.rules.get(input.ruleId)
  // The panel's own ANNOUNCEMENT has no stored rule — it is addressed to
  // `announceTargets` — but it is where the refusal's Arm anyway lives, so it
  // still gets the ALARM buttons (and only those: no sequence, no snooze).
  const announcement = stored === null && input.ruleId === NC_ALARM_ANNOUNCE_RULE_ID
  if (stored === null && !announcement) return []

  // Each family pushes ONE draft per button it returns, in the order it
  // returns them, so a draft and its rendered button share an index. The
  // draft carries its own TTL: a disarm link must not live as long as a
  // snooze one just because they arrived on the same notification.
  const drafts: NcButtonDraft[] = []

  // 0. "Was this detection right?" (#243). First, so that on a channel that
  //    keeps only its first few buttons the question the operator opted into
  //    is never the one dropped. Drafts are pushed in the order the buttons
  //    are returned, so this block must stay ahead of the others.
  const verdictRefusal = verdictButtonRefusal({
    askVerdict: stored?.askVerdict === true,
    ...(input.trackId !== undefined ? { trackId: input.trackId } : {}),
    ...(input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}),
  })
  if (stored?.askVerdict === true && verdictRefusal !== null) {
    // The one refusal an operator can meet after turning the option on, and
    // would otherwise report as "the buttons are missing".
    host.logger.info('detection notification carries no verdict buttons', {
      tags: { deviceId: input.deviceId },
      meta: { ruleId: input.ruleId, reason: verdictRefusal, targetId: input.targetId },
    })
  }
  const verdictTrackId = input.trackId
  const verdictOwner = input.ownerUserId
  const verdictButtons: NotificationAction[] =
    verdictRefusal !== null || verdictTrackId === undefined || verdictOwner === undefined
      ? []
      : verdictButtonSpecs({ className: input.className, maxActions: input.maxActions }).map(
          (spec) => {
            const id = randomUUID()
            drafts.push({
              id,
              ttlMs: actionTtlMs({ kind: 'detection-verdict' }),
              grant: (expiresAt) => ({
                kind: 'detection-verdict',
                id,
                verdict: spec.verdict,
                trackId: verdictTrackId,
                ruleId: input.ruleId,
                ruleName: input.ruleName,
                userId: verdictOwner,
                ...(spec.suggestedClass !== undefined
                  ? { suggestedClass: spec.suggestedClass }
                  : {}),
                // A channel with no buttons shows these as links in the body,
                // where a preview bot will open them: confirm before claiming.
                ...(input.maxActions === 0 ? { viaLink: true } : {}),
                deviceId: input.deviceId,
                actionId: spec.actionId,
                targetId: input.targetId,
                expiresAt,
              }),
            })
            return {
              id: spec.actionId,
              label:
                spec.suggestedClass === undefined
                  ? host.texts.text({
                      key:
                        spec.verdict === 'correct'
                          ? 'button.verdict.correct'
                          : 'button.verdict.wrong',
                    })
                  : host.texts.text({
                      key: 'button.verdict.wrongAs',
                      vars: { class: spec.suggestedClass },
                    }),
              url: id,
              // A background call: the OS shows nothing, the notification stays.
              mode: 'background',
            }
          },
        )

  // 1. The rule's own sequences. Needs an actuator — a button that would
  //    always fail is worse than an absent one.
  const sequenceButtons =
    host.actionRunner === null || stored === null
      ? []
      : buildActionButtons({
          actions: stored.actions,
          knownSequenceIds: host.sequences.knownIds(),
          // Synchronous by contract, so the pure builder stays pure: the id
          // is minted here and the URL is filled in below.
          mintUrl: ({ sequenceId, actionId }) => {
            const id = randomUUID()
            drafts.push({
              id,
              ttlMs: actionTtlMs({ kind: 'sequence' }),
              grant: (expiresAt) => ({
                kind: 'sequence',
                id,
                ruleId: input.ruleId,
                ruleName: input.ruleName,
                sequenceId,
                deviceId: input.deviceId,
                actionId,
                targetId: input.targetId,
                expiresAt,
              }),
            })
            return id
          },
        })

  // 2. "Not now". Only for an OWNED target: the window a tap opens is
  //    personal and its owner is frozen at mint (a tap does not identify
  //    anybody), so a shared destination has nobody to silence — and
  //    minting a button that would open a window for nobody is the armed-
  //    looking-and-inert shape this file exists to refuse.
  const snoozeButtons =
    input.ownerUserId === undefined || stored === null
      ? []
      : buildSnoozeButtons({
          rule: stored,
          sequenceActionsOf: host.sequenceActionsOf,
          label: (minutes) => host.snoozeButtonLabel(minutes),
          mintUrl: ({ actionId, minutes }) => {
            const id = randomUUID()
            const owner = input.ownerUserId ?? ''
            drafts.push({
              id,
              ttlMs: actionTtlMs({ kind: 'snooze' }),
              grant: (expiresAt) => ({
                kind: 'snooze',
                id,
                ruleId: input.ruleId,
                ruleName: input.ruleName,
                userId: owner,
                minutes,
                ...(input.className !== undefined ? { classes: [input.className] } : {}),
                deviceId: input.deviceId,
                actionId,
                targetId: input.targetId,
                expiresAt,
              }),
            })
            return id
          },
        })

  // 3. The panel, from the notification that reports it. A node with no
  //    panel simply gets none — see `alarmButtonKind`.
  const alarmKind = alarmButtonKind(input.systemEvent?.kind)
  const panel = host.alarmPanel
  // The refusal is read off the ROW — the one refusal this notification is
  // about — for the same reason the kind is.
  const refusalId = rowRefusalId(input.systemEvent)
  if (alarmKind === 'alarm-arm-refused' && refusalId === undefined) {
    host.logger.debug('refusal notification carries no Arm anyway — the row names no refusal', {
      tags: { deviceId: input.deviceId },
      meta: { ruleId: input.ruleId, targetId: input.targetId },
    })
  }
  // The input a trigger row is about — off the ROW's frozen source, never the
  // panel's latest trigger.
  const bypassable = rowBypassableInput(input.systemEvent)
  const alarmButtons =
    alarmKind === null
      ? []
      : buildAlarmButtons({
          kind: alarmKind,
          panel:
            panel === null
              ? null
              : { deviceId: panel.deviceId, availableModes: panel.availableModes() },
          ...(refusalId !== undefined ? { refusalId } : {}),
          ...(bypassable !== undefined ? { bypassable } : {}),
          labels: {
            disarm: host.texts.text({ key: 'button.alarm.disarm' }),
            arm: (mode) => host.texts.text({ key: `button.alarm.arm.${mode}` }),
            armAnyway: host.texts.text({ key: 'button.alarm.armAnyway' }),
            bypassInput: host.texts.text({ key: 'button.alarm.bypassInput' }),
          },
          mintUrl: (button) => {
            const id = randomUUID()
            const panelDeviceId = panel?.deviceId ?? 0
            const common = {
              kind: 'alarm' as const,
              id,
              panelDeviceId,
              deviceId: input.deviceId,
              actionId: button.actionId,
              targetId: input.targetId,
            }
            drafts.push({
              id,
              ttlMs: actionTtlMs({ kind: 'alarm', action: button.action }),
              grant: (expiresAt) => {
                switch (button.action) {
                  // ONLY the refusal id: the panel's record decides the mode
                  // and what is excluded, never the URL.
                  case 'arm-anyway':
                    return {
                      ...common,
                      action: 'arm-anyway',
                      refusalId: button.refusalId,
                      expiresAt,
                    }
                  case 'arm':
                    return { ...common, action: 'arm', mode: button.mode, expiresAt }
                  case 'disarm':
                    return { ...common, action: 'disarm', expiresAt }
                  // The (rule, input) pair the ROW reports and nothing else.
                  case 'bypass-input':
                    return {
                      ...common,
                      action: 'bypass-input',
                      ruleId: button.ruleId,
                      ruleName: button.ruleName,
                      inputDeviceId: button.inputDeviceId,
                      cameraId: button.cameraId,
                      notedAt: button.notedAt,
                      expiresAt,
                    }
                }
              },
            })
            return id
          },
        })
  // 4. "Apply these updates", on an `addon-update-available` row. Everything
  //    it acts on is FROZEN on that row — the package names and the one node
  //    — so a row that drains days late still asks for exactly what its own
  //    sentence listed. Nothing is joined here (D305), and no VERSION is
  //    carried at all (D313).
  const systemEvent = input.systemEvent
  const recipient = input.ownerUserId !== undefined ? { ownerUserId: input.ownerUserId } : {}
  const updateRefusal =
    systemEvent === undefined
      ? 'not-an-addon-update'
      : addonUpdateButtonRefusal(systemEvent, recipient)
  const updateButtons =
    systemEvent === undefined
      ? []
      : buildAddonUpdateButtons({
          subject: systemEvent,
          recipient,
          label: ({ count, nodeId }) =>
            host.texts.text({
              key: 'button.addon-update.apply',
              vars: { count: String(count), nodeId },
              count,
            }),
          mintUrl: ({ actionId, packages, nodeId }) => {
            const id = randomUUID()
            drafts.push({
              id,
              ttlMs: actionTtlMs({ kind: 'addon-update' }),
              grant: (expiresAt) => ({
                kind: 'addon-update',
                id,
                packages,
                nodeId,
                deviceId: input.deviceId,
                actionId,
                targetId: input.targetId,
                expiresAt,
              }),
            })
            return id
          },
        })
  if (updateRefusal === 'several-nodes' || updateRefusal === 'unowned-target') {
    // The one refusal an operator can actually meet, and the one they would
    // otherwise report as "the button is missing". Silence here would read as
    // "never happened".
    host.logger.info('addon-update notification carries no apply button', {
      tags: { deviceId: input.deviceId },
      meta: {
        ruleId: input.ruleId,
        reason: updateRefusal,
        targetId: input.targetId,
        nodeIds: systemEvent?.nodeIds ?? [],
        packages: systemEvent?.packageNames ?? [],
      },
    })
  }
  // 5. "Apply this server update", on a `server-update-available` row. WHERE
  //    is frozen (the one node); no VERSION is carried (D313, D325). A row
  //    that spans nodes or an unowned destination gets none — the Cluster
  //    page the notification already links to is where that work belongs.
  const serverRefusal =
    systemEvent === undefined
      ? 'not-a-server-update'
      : serverUpdateButtonRefusal(systemEvent, recipient)
  const serverButtons =
    systemEvent === undefined
      ? []
      : buildServerUpdateButtons({
          subject: systemEvent,
          recipient,
          label: ({ nodeId }) =>
            host.texts.text({
              key: 'button.server-update.apply',
              vars: { nodeId },
            }),
          mintUrl: ({ actionId, nodeId }) => {
            const id = randomUUID()
            drafts.push({
              id,
              ttlMs: actionTtlMs({ kind: 'server-update' }),
              grant: (expiresAt) => ({
                kind: 'server-update',
                id,
                nodeId,
                deviceId: input.deviceId,
                actionId,
                targetId: input.targetId,
                expiresAt,
              }),
            })
            return id
          },
        })
  if (serverRefusal === 'several-nodes' || serverRefusal === 'unowned-target') {
    host.logger.info('server-update notification carries no apply button', {
      tags: { deviceId: input.deviceId },
      meta: {
        ruleId: input.ruleId,
        reason: serverRefusal,
        targetId: input.targetId,
        nodeIds: systemEvent?.nodeIds ?? [],
      },
    })
  }
  if (alarmKind !== null && panel === null) {
    // A dropped branch that logs nothing reads as "never happened", and
    // "why does my alarm notification have no Disarm button" is exactly the
    // question this answers.
    host.logger.info('alarm notification carries no buttons — this node owns no panel', {
      tags: { deviceId: input.deviceId },
      meta: { ruleId: input.ruleId, kind: alarmKind },
    })
  }

  const out = [
    ...verdictButtons,
    ...sequenceButtons,
    ...snoozeButtons,
    ...alarmButtons,
    ...updateButtons,
    ...serverButtons,
  ]
  if (out.length === 0) return []

  const now = host.now()
  const resolved: NotificationAction[] = []
  for (const [index, action] of out.entries()) {
    const slot = drafts[index]
    if (slot === undefined) continue
    const expMs = now + slot.ttlMs
    const url = await mint({ id: slot.id, expMs })
    if (url === null) {
      // Loopback-only: no button on this install can work. Logged once here
      // rather than per button.
      host.logger.debug('no reachable base URL — notification buttons omitted', {
        tags: { deviceId: input.deviceId },
        meta: { ruleId: input.ruleId },
      })
      return []
    }
    host.actionTokens.put(slot.grant(expMs))
    resolved.push({ ...action, url })
  }
  return resolved
}
/** "Silenzia 30 min" / "Silenzia 1 h", in the hub's language. Whole hours
 *  read as hours — `Silenzia 120 min` is arithmetic the operator should not
 *  have to do on a lock screen. */
export function snoozeButtonLabel(host: MintButtonsHost, minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60
    return host.texts.text({
      key: 'button.snooze.hours',
      vars: { hours: String(hours) },
      count: hours,
    })
  }
  return host.texts.text({
    key: 'button.snooze.minutes',
    vars: { minutes: String(minutes) },
    count: minutes,
  })
}

/**
 * Turning a rule's declared buttons into the buttons a notification carries.
 *
 * Pure, and separate from both the dispatcher and the token registry, because
 * the interesting rules are all about REFUSING to mint:
 *
 *  - A button naming a sequence that is not in {@link knownSequenceIds}
 *    produces nothing. The alternative is a live token whose run always fails
 *    — a button that looks armed and is not, which is worse than an absent one.
 *  - A button is dropped when there is no externally-reachable base URL. A
 *    `http://127.0.0.1` callback is one nobody outside the host can open; the
 *    artifact plane learned this the expensive way and the rule is the same
 *    here.
 *  - Duplicate button ids are collapsed. The id travels in the callback and
 *    appears in the audit line; two buttons sharing one would make the log
 *    unable to say which was tapped.
 *
 * What it does NOT do is decide whether the action is safe to expose. That is
 * the token's job and the operator's decision — see `action-token.ts`.
 */

import type {
  AlarmArmMode,
  NcRule,
  NcRuleAction,
  NcRuleActions,
  NotificationAction,
} from '@camstack/types'
import { NC_DEFAULT_SNOOZE_MINUTES, NC_SNOOZE_MAX_MINUTES } from '@camstack/types'
import { isSnoozeExempt } from './snooze-exempt.js'

/** Mint one callback URL for a button, and register what it may run. */
export type NcActionUrlMinter = (input: {
  readonly sequenceId: string
  readonly actionId: string
}) => string

export interface BuildActionButtonsInput {
  /** The rule's `actions` block. Absent = no buttons, which is the common case. */
  readonly actions: NcRuleActions | undefined
  /** Shared sequence ids that currently exist in the store. */
  readonly knownSequenceIds: ReadonlySet<string>
  readonly mintUrl: NcActionUrlMinter
}

/**
 * Build the notification's buttons.
 *
 * Returns an empty array rather than `undefined` — the caller decides whether
 * to set the field, and an empty array is the honest answer to "which buttons
 * survived", which `undefined` would conflate with "the rule declared none".
 */
export function buildActionButtons(input: BuildActionButtonsInput): readonly NotificationAction[] {
  const actions = input.actions
  if (actions === undefined) return []
  const buttons = actions.buttons ?? []
  if (buttons.length === 0) return []

  const known = input.knownSequenceIds
  const seen = new Set<string>()
  const out: NotificationAction[] = []
  for (const button of buttons) {
    if (!known.has(button.sequenceId)) continue
    if (seen.has(button.id)) continue
    seen.add(button.id)
    out.push({
      id: button.id,
      label: button.label,
      url: input.mintUrl({ sequenceId: button.sequenceId, actionId: button.id }),
      // Background POST — same as snooze/arm. A sequence that opens a browser
      // tab (Zentik NAVIGATE) costs more attention than the notification itself;
      // Zentik supports BACKGROUND_CALL and every other NC button already uses it.
      mode: 'background',
      ...(button.icon !== undefined ? { icon: button.icon } : {}),
      ...(button.destructive !== undefined ? { destructive: button.destructive } : {}),
    })
  }
  return out
}

/**
 * Which of a rule's buttons name a sequence that is not known.
 *
 * Exported so the caller can LOG the drop. A button silently missing from a
 * notification is the exact shape of failure this repo keeps paying for — the
 * operator authored it, it never appeared, and nothing said why.
 */
export function unresolvableButtons(
  actions: NcRuleActions | undefined,
  knownSequenceIds: ReadonlySet<string>,
): readonly string[] {
  if (actions === undefined) return []
  const buttons = actions.buttons ?? []
  if (buttons.length === 0) return []
  return buttons
    .filter((b) => !knownSequenceIds.has(b.sequenceId))
    .map((b) => `${b.id}→${b.sequenceId}`)
}

// ── Snooze buttons ──────────────────────────────────────────────────

/** How many snooze choices one notification may carry. The schema caps the
 *  authored list at 4; this is the same bound applied to a stored rule that
 *  somehow carries more, so the notifier's own action budget is never eaten by
 *  a single feature. */
const MAX_SNOOZE_BUTTONS = 4

/** The id a snooze button travels under. Stable and derived from the window it
 *  opens, so the audit line says WHICH choice was tapped. */
function snoozeButtonId(minutes: number): string {
  return `snooze-${minutes}`
}

/** Mint the callback URL for one snooze choice. */
export type NcSnoozeUrlMinter = (input: {
  readonly actionId: string
  readonly minutes: number
}) => string

/** Only the fields a snooze button reads. */
export type SnoozeButtonRule = Pick<NcRule, 'conditions' | 'actions' | 'snoozeOptions'>

export interface BuildSnoozeButtonsInput {
  readonly rule: SnoozeButtonRule
  readonly mintUrl: NcSnoozeUrlMinter
  /** How a choice is worded, in the hub's language. Injected so this stays
   *  pure and the text catalog stays the one place words live. */
  readonly label: (minutes: number) => string
  /** Resolve shared-sequence steps so a sequence-ref alarm actuation is exempt. */
  readonly sequenceActionsOf?: (sequenceId: string) => readonly NcRuleAction[] | undefined
}

/**
 * The durations offered on THIS rule's notification, normalised.
 *
 * `undefined` = the operator never said, so the defaults apply. `[]` is a
 * DIFFERENT statement — "no snooze buttons on this rule" — and it is the one
 * explicit override the surface has, which is why the field is `.optional()`
 * and never `.default()`: a Zod default does not run on the addon cap path, so
 * an absent list and an empty one have to be distinguishable here rather than
 * collapsed by a schema.
 */
export function snoozeChoices(options: readonly number[] | undefined): readonly number[] {
  const raw = options ?? NC_DEFAULT_SNOOZE_MINUTES
  const seen = new Set<number>()
  const out: number[] = []
  for (const minutes of raw) {
    if (!Number.isInteger(minutes)) continue
    if (minutes < 1 || minutes > NC_SNOOZE_MAX_MINUTES) continue
    if (seen.has(minutes)) continue
    seen.add(minutes)
    out.push(minutes)
  }
  return out.toSorted((a, b) => a - b).slice(0, MAX_SNOOZE_BUTTONS)
}

/**
 * "Not now" buttons for one delivery.
 *
 * Two refusals, and both are the point:
 *
 *  - **An ALARM rule gets none** ({@link isSnoozeExempt}). Offering a silence
 *    the gate would then refuse is worse than offering nothing: the operator
 *    would tap it, read "Done", and believe the siren is quiet.
 *  - **`snoozeOptions: []` gets none.** That is the operator saying this rule
 *    is not the kind you dismiss from the lock screen.
 *
 * `mode: 'background'` on every one of them. A snooze is an ANSWER to the
 * notification — being thrown into a browser tab to confirm it costs more
 * attention than the notification did.
 */
export function buildSnoozeButtons(input: BuildSnoozeButtonsInput): readonly NotificationAction[] {
  if (isSnoozeExempt(input.rule, input.sequenceActionsOf)) return []
  const choices = snoozeChoices(input.rule.snoozeOptions)
  return choices.map((minutes) => {
    const actionId = snoozeButtonId(minutes)
    return {
      id: actionId,
      label: input.label(minutes),
      url: input.mintUrl({ actionId, minutes }),
      icon: 'silence',
      mode: 'background',
    }
  })
}

// ── Alarm buttons ───────────────────────────────────────────────────

/**
 * How many ARM buttons one notification may carry.
 *
 * Three, because the modes are a list the panel declares and a disarmed-alarm
 * notification with five buttons is a menu, not a notification. The order is
 * the panel's own `availableModes()` — the operator's configured preference,
 * not an alphabetical guess.
 */
const MAX_ARM_BUTTONS = 3

/** Which alarm transition this notification is about. */
export type NcAlarmButtonKind =
  | 'alarm-arming'
  | 'alarm-triggered'
  | 'alarm-armed'
  | 'alarm-disarmed'
  | 'alarm-pending'
  | 'alarm-rearmed'
  | 'alarm-check-failed'
  | 'alarm-arm-refused'
  | 'alarm-sensor-bypass'

/** What one alarm button's grant is minted for. */
export type NcAlarmButtonMint =
  | { readonly actionId: string; readonly action: 'arm'; readonly mode: AlarmArmMode }
  | { readonly actionId: string; readonly action: 'disarm' }
  | { readonly actionId: string; readonly action: 'arm-anyway'; readonly refusalId: string }
  | ({ readonly actionId: string; readonly action: 'bypass-input' } & NcAlarmBypassableInput)

/**
 * The ONE input a trigger notification is about — the (rule, device) pair whose
 * match set the alarm off, read off the ROW's frozen `alarmSource`. The device
 * is the sensor when the match was about one, else the camera.
 */
export interface NcAlarmBypassableInput {
  readonly ruleId: string
  readonly ruleName: string
  readonly inputDeviceId: number
  readonly cameraId: number
  /** The match's own instant — the panel refuses a bypass about an arm that is over. */
  readonly notedAt: number
}

export type NcAlarmUrlMinter = (input: NcAlarmButtonMint) => string

/** The panel a button would move. `null` on a node that owns none. */
export interface NcAlarmButtonPanel {
  readonly deviceId: number
  readonly availableModes: readonly AlarmArmMode[]
}

export interface BuildAlarmButtonsInput {
  readonly kind: NcAlarmButtonKind
  /** `null` = no panel on this node ⇒ no buttons. A caller that logs the
   *  no-op is doing the right thing; inventing a panel id would not be. */
  readonly panel: NcAlarmButtonPanel | null
  /**
   * The refusal an `alarm-arm-refused` row reports, read off the ROW (frozen
   * at intake) — never the panel's latest one. Absent on a row an older addon
   * wrote, which then carries no Arm anyway.
   */
  readonly refusalId?: string
  /**
   * The input an `alarm-triggered` / `alarm-pending` row is about, read off the
   * ROW. Absent on a manual or API trigger (no rule, no input) — no Bypass then.
   */
  readonly bypassable?: NcAlarmBypassableInput
  readonly mintUrl: NcAlarmUrlMinter
  readonly labels: NcAlarmButtonLabels
}

export interface NcAlarmButtonLabels {
  readonly disarm: string
  readonly arm: (mode: AlarmArmMode) => string
  readonly armAnyway: string
  readonly bypassInput: string
}

/**
 * The one button an alarm notification should carry, and its mirror.
 *
 * The state the notification reports decides it, because the alternative — a
 * fixed set — puts a Disarm button on a notification that says "disarmed":
 *
 * | notification | buttons |
 * | --- | --- |
 * | `alarm-arming`, `alarm-armed`, `alarm-pending` | **Disarma**, destructive |
 * | `alarm-triggered`, `alarm-rearmed`, `alarm-check-failed` | **Disarma**, destructive |
 * | `alarm-disarmed` | **Arma …** per declared (enabled) mode, max three |
 * | `alarm-arm-refused` | **Arma comunque**, bound to the row's refusal |
 * | `alarm-sensor-bypass` | nothing — it reports, there is nothing to undo |
 *
 * `alarm-triggered` and `alarm-pending` rows a RULE caused also carry **Bypass
 * this input**, bound to the row's (rule, input) pair: that one input stops
 * pressing the panel until the next disarm. It never cancels the countdown or
 * the siren already running — Disarm beside it does that.
 *
 * The `alarm-arming` row is the one that earns its keep: that notification
 * arrives at the START of the exit delay, so its Disarm is the only alarm
 * button an operator can press to cancel something rather than to undo it.
 *
 * `destructive` on the disarm is a RENDERING hint and never a gate (D47) — what
 * actually bounds it is the five-minute TTL the minter gives that grant
 * (`ALARM_DISARM_TTL_MS`). Both exist: the hint is for the person, the TTL is
 * for the forwarded screenshot.
 *
 * Every alarm button is `background` — Zentik (and ntfy) fire a POST and leave
 * the lock screen alone. Opening a browser to arm or disarm costs more
 * attention than the notification did.
 *
 * `panel.availableModes` ARE the enabled modes: CamStack has no per-mode
 * disable setting, so the Arm buttons offer exactly what the panel declares.
 */
export function buildAlarmButtons(input: BuildAlarmButtonsInput): readonly NotificationAction[] {
  const panel = input.panel
  if (panel === null) return []
  if (input.kind === 'alarm-sensor-bypass') return []
  if (input.kind === 'alarm-arm-refused') return armAnywayButton(input.refusalId, input)
  if (input.kind === 'alarm-disarmed') {
    return panel.availableModes.slice(0, MAX_ARM_BUTTONS).map((mode) => {
      const actionId = `alarm-arm-${mode}`
      return {
        id: actionId,
        label: input.labels.arm(mode),
        url: input.mintUrl({ actionId, action: 'arm', mode }),
        icon: 'arm',
        mode: 'background',
      }
    })
  }
  const actionId = 'alarm-disarm'
  const disarm: NotificationAction = {
    id: actionId,
    label: input.labels.disarm,
    url: input.mintUrl({ actionId, action: 'disarm' }),
    icon: 'disarm',
    destructive: true,
    mode: 'background',
  }
  const bypassable = input.bypassable
  if (
    bypassable === undefined ||
    (input.kind !== 'alarm-triggered' && input.kind !== 'alarm-pending')
  ) {
    return [disarm]
  }
  const bypassId = 'alarm-bypass-input'
  return [
    disarm,
    {
      id: bypassId,
      label: input.labels.bypassInput,
      url: input.mintUrl({ actionId: bypassId, action: 'bypass-input', ...bypassable }),
      // Not destructive: it narrows what is watched for THIS arm only, and the
      // disarm ends it. Background, like every alarm button.
      mode: 'background',
    },
  ]
}

/**
 * The one Arm anyway a refusal notification carries — or none, when the row
 * names no refusal. Destructive + background: it arms around an open door via
 * POST (Zentik BACKGROUND_CALL), same as disarm. Its TTL is the refusal's own
 * (`ARM_ANYWAY_TTL_MS`, priced by the minter).
 */
function armAnywayButton(
  refusalId: string | undefined,
  input: BuildAlarmButtonsInput,
): readonly NotificationAction[] {
  if (refusalId === undefined) return []
  const actionId = 'alarm-arm-anyway'
  return [
    {
      id: actionId,
      label: input.labels.armAnyway,
      url: input.mintUrl({ actionId, action: 'arm-anyway', refusalId }),
      icon: 'arm',
      destructive: true,
      mode: 'background',
    },
  ]
}

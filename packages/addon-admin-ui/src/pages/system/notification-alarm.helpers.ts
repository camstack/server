/**
 * Pure helpers for the alarm tab.
 *
 * Split out because every one of them answers a question the operator asks in
 * words, not in numbers — "how long is the exit delay", "what does Away arm",
 * "does this mode do anything at all" — and a wrong answer to the last one is
 * the whole reason the tab exists. A component test cannot pin those cheaply;
 * these can.
 */

import {
  NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC,
  resolveModeDelays,
  type AlarmArmMode,
  type AlarmState,
  type NcAlarmConfig,
  type NcAlarmDelayField,
  type NcAlarmDelaySettings,
  type NcAlarmModeCoverage,
  type NcAlarmModeDelaysEdit,
  type NcAlarmNotifyField,
  type NcAlarmSettings,
  type NcAlarmSkippedDevice,
  type NcSchedule,
} from '@camstack/types'
import type { AlarmDeviceNamer } from './alarm-nonblocking.helpers'
import i18n from '../../i18n/index'

/**
 * The panel as it is now. Derived from the published config type rather than
 * imported by name: the per-part schemas are not re-exported by
 * `@camstack/types`, and a derived alias cannot drift from the shape the hub
 * answers with.
 */
export type NcAlarmLiveView = NonNullable<NcAlarmConfig['live']>
export type NcAlarmExclusionPhase = NcAlarmLiveView['exclusions'][number]['phase']

/**
 * Modes in the order a keypad shows them, whatever order the panel returns.
 *
 * The three a camstack panel OFFERS, and no more. `vacation` and
 * `custom_bypass` are members of the shared `AlarmArmMode` enum (a Home
 * Assistant panel may report them) but this tab renders the coverage of the
 * panel's own `availableModes()`, so a label for a mode it never returns was a
 * row that could not appear — and reading it made the tab look like it offered
 * five. Unknown falls back to the raw value rather than vanishing.
 */
export const ALARM_MODE_LABEL: Readonly<Record<string, string>> = {
  home: 'Home',
  away: 'Away',
  night: 'Night',
}

export function alarmModeLabel(mode: string): string {
  return ALARM_MODE_LABEL[mode] ?? mode
}

/**
 * A duration in the words a person would use.
 *
 * **0 is never "0 seconds"** — for every one of these three fields zero means a
 * behaviour, not a quantity: no delay, or no limit. Rendering it as a number
 * would leave the operator reading "0 s" and guessing which.
 */
export function delayLabel(seconds: number, zeroMeans: string): string {
  if (seconds <= 0) return zeroMeans
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0
    ? i18n.t('helpers.notificationAlarm.delayMin', { minutes })
    : i18n.t('helpers.notificationAlarm.delayMinSec', { minutes, seconds: rest })
}

/**
 * What a mode covers, as one sentence.
 *
 * The ZERO case is the important one and it is deliberately blunt: an operator
 * who arms a mode nothing is gated on gets no protection and, today, no
 * indication of it either. This line is that indication.
 */
export function coverageSummary(coverage: NcAlarmModeCoverage, nameOf: AlarmDeviceNamer): string {
  if (coverage.ruleCount === 0) return i18n.t('helpers.notificationAlarm.armsNothing')
  // D641: every unscoped rule EXCLUDES these, and no named rule covers them —
  // "every device" would promise a garage nobody watches. Named through the
  // fleet's verdict, so an unanswered fleet says "Device #id", never "removed".
  if (coverage.allDevices && coverage.allDevicesExcept.length > 0) {
    const names = coverage.allDevicesExcept.map(nameOf)
    return i18n.t('helpers.notificationAlarm.allExcept', {
      count: names.length,
      names: names.join(', '),
    })
  }
  if (coverage.allDevices) {
    return i18n.t('helpers.notificationAlarm.everyDevice', { count: coverage.ruleCount })
  }
  if (coverage.deviceIds.length === 0) {
    return i18n.t('helpers.notificationAlarm.noRestriction', { count: coverage.ruleCount })
  }
  return coverage.deviceIds.map(nameOf).join(', ')
}

/**
 * "2 excluded: Garage (muted), Gate (offline)."
 *
 * The half of the coverage answer that makes it honest. "Away armed — 12
 * cameras" is a promise, and a muted one among those twelve breaks it in
 * exactly the way nobody notices until an incident. Empty string when nothing
 * is excluded, so the caller renders nothing rather than "0 excluded".
 */
export function skippedSummary(
  skipped: readonly NcAlarmSkippedDevice[],
  nameOf: AlarmDeviceNamer,
): string {
  if (skipped.length === 0) return ''
  const parts = skipped.map((s) => `${nameOf(s.deviceId)} (${SKIP_REASON_LABEL[s.reason]})`)
  return i18n.t('helpers.notificationAlarm.skipped', {
    count: skipped.length,
    parts: parts.join(', '),
  })
}

/** Each word names the switch the operator actually used — never "broken"
 *  (D62: a device somebody turned off is reported off, not faulty). */
const SKIP_REASON_LABEL: Readonly<Record<NcAlarmSkippedDevice['reason'], string>> = {
  muted: 'notifications muted',
  'detection-off': 'detection off',
  offline: 'offline',
}

/** True when the operator should be warned rather than reassured. */
export function coverageIsEmpty(coverage: NcAlarmModeCoverage): boolean {
  return coverage.ruleCount === 0
}

/**
 * Parse a number field without letting an empty box become 0.
 *
 * An operator clearing the entry-delay box to retype it would otherwise commit
 * "0 seconds" — an alarm that fires the instant the door opens — on the way to
 * typing "45". Null means "leave it alone".
 */
export function parseDelayInput(raw: string, max: number): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null
  if (value < 0 || value > max) return null
  return value
}

// ── Live panel ──────────────────────────────────────────────────────

/** How often the tab re-reads the panel. Fast only while something is
 *  counting down — an exit delay shown 15 s late is a delay that looks stuck. */
const FAST_POLL_MS = 2000
const SLOW_POLL_MS = 15000
const FAST_POLL_STATES: ReadonlySet<AlarmState> = new Set(['arming', 'pending', 'triggered'])

export function alarmPollIntervalMs(state: AlarmState | undefined): number {
  return state !== undefined && FAST_POLL_STATES.has(state) ? FAST_POLL_MS : SLOW_POLL_MS
}

const STATE_WORD: Readonly<Record<AlarmState, string>> = {
  disarmed: 'Disarmed',
  armed_home: 'Armed',
  armed_away: 'Armed',
  armed_night: 'Armed',
  armed_vacation: 'Armed',
  armed_custom_bypass: 'Armed',
  arming: 'Arming',
  disarming: 'Disarming',
  pending: 'Entry delay',
  triggered: 'Triggered',
}

/**
 * "Arming — Away", "Triggered — Night", "Disarmed".
 *
 * The mode is named whenever the panel has one: while arming or pending it is
 * the mode the operator is about to be in, and that is exactly when a wrong
 * one can still be undone.
 */
export function alarmStateLabel(live: NcAlarmLiveView): string {
  const word = STATE_WORD[live.state]
  if (live.state === 'disarmed' || live.targetMode === null) return word
  return `${word} — ${alarmModeLabel(live.targetMode)}`
}

/** True while the panel is armed or on its way there — Disarm is the answer. */
export function alarmIsActive(state: AlarmState): boolean {
  return state !== 'disarmed'
}

export function exclusionPhaseLabel(phase: NcAlarmExclusionPhase): string {
  return phase === 'open'
    ? i18n.t('helpers.notificationAlarm.phaseOpen')
    : i18n.t('helpers.notificationAlarm.phaseClosed')
}

/** The lists as an answer may carry them: a hub older than D636 sends none. */
export interface NcAlarmNonBlockingSettings {
  readonly nonBlocking?: NcAlarmSettings['nonBlocking']
}

/** One mode's non-blocking ids. A mode with no list (or an answer with none) tolerates nothing open. */
export function nonBlockingFor(
  settings: NcAlarmNonBlockingSettings,
  mode: AlarmArmMode,
): readonly number[] {
  return (settings.nonBlocking ?? []).find((l) => l.mode === mode)?.deviceIds ?? []
}

export function blockingFor(
  settings: Pick<NcAlarmSettings, 'blocking'> | { readonly blocking?: NcAlarmSettings['blocking'] },
  mode: AlarmArmMode,
): readonly number[] {
  return (settings.blocking ?? []).find((l) => l.mode === mode)?.deviceIds ?? []
}

export function secureOnArmOffFor(
  settings:
    | Pick<NcAlarmSettings, 'secureOnArmOff'>
    | { readonly secureOnArmOff?: NcAlarmSettings['secureOnArmOff'] },
  mode: AlarmArmMode,
): readonly number[] {
  return (settings.secureOnArmOff ?? []).find((l) => l.mode === mode)?.deviceIds ?? []
}

/** The stored override of one field for a mode; undefined = the mode inherits it. */
function storedModeDelay(
  settings: NcAlarmDelaySettings,
  mode: AlarmArmMode,
  field: NcAlarmDelayField,
): number | undefined {
  const entry = (settings.modeDelays ?? []).find((e) => e.mode === mode)
  switch (field) {
    case 'exitDelaySec':
      return entry?.exitDelaySec
    case 'entryDelaySec':
      return entry?.entryDelaySec
    case 'triggeredDurationSec':
      return entry?.triggeredDurationSec
  }
}

/** The edit for ONE field of a mode, in the shape the patch carries. */
function modeDelayEditOf(
  mode: AlarmArmMode,
  field: NcAlarmDelayField,
  value: number | null,
): NcAlarmModeDelaysEdit {
  switch (field) {
    case 'exitDelaySec':
      return { mode, exitDelaySec: value }
    case 'entryDelaySec':
      return { mode, entryDelaySec: value }
    case 'triggeredDurationSec':
      return { mode, triggeredDurationSec: value }
  }
}

/**
 * The edit a typed value or "Use default" sends — decided on the PRESENCE of the override, never
 * on whether the effective value changes: an override equal to the global must still be
 * clearable, and an explicit value equal to the global must still be settable. Null = nothing to
 * send.
 */
export function modeDelayEdit(
  settings: NcAlarmDelaySettings,
  mode: AlarmArmMode,
  field: NcAlarmDelayField,
  next: number | 'default',
): NcAlarmModeDelaysEdit | null {
  const stored = storedModeDelay(settings, mode, field)
  if (next === 'default') return stored === undefined ? null : modeDelayEditOf(mode, field, null)
  return stored === next ? null : modeDelayEditOf(mode, field, next)
}

/**
 * Edit the mode's post-triggered action (or clear the override to inherit).
 * Choosing a timed action while the resolved duration is still 0 also sets
 * the stock duration (30 s, D706) — otherwise the select sticks on "re-arm" with an immediate clear and
 * looks broken. Null = nothing to send.
 */
export function modePostTriggeredEdit(
  settings: NcAlarmDelaySettings,
  mode: AlarmArmMode,
  next: import('@camstack/types').NcAlarmPostTriggeredAction | 'default',
): NcAlarmModeDelaysEdit | null {
  const stored = (settings.modeDelays ?? []).find((e) => e.mode === mode)?.postTriggeredAction
  if (next === 'default') {
    return stored === undefined ? null : { mode, postTriggeredAction: null }
  }
  const resolved = resolveModeDelays(settings, mode)
  const actionChanged = stored !== next
  const needDuration = next !== 'doNothing' && resolved.triggeredDurationSec === 0
  if (!actionChanged && !needDuration) return null
  return {
    mode,
    ...(actionChanged ? { postTriggeredAction: next } : {}),
    ...(needDuration ? { triggeredDurationSec: NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC } : {}),
  }
}

/**
 * Set or clear the mode's activation schedule. `undefined` clears (always
 * allowed). Null = nothing to send.
 */
export function modeScheduleEdit(
  settings: NcAlarmDelaySettings,
  mode: AlarmArmMode,
  next: NcSchedule | undefined,
): NcAlarmModeDelaysEdit | null {
  const stored = (settings.modeDelays ?? []).find((e) => e.mode === mode)?.schedule
  if (next === undefined) {
    return stored === undefined ? null : { mode, schedule: null }
  }
  if (
    stored !== undefined &&
    stored.invert === next.invert &&
    stored.timezone === next.timezone &&
    stored.windows.length === next.windows.length &&
    stored.windows.every((w, i) => {
      const o = next.windows[i]
      return (
        o !== undefined &&
        w.startMinute === o.startMinute &&
        w.endMinute === o.endMinute &&
        w.days.length === o.days.length &&
        w.days.every((d, j) => d === o.days[j])
      )
    })
  ) {
    return null
  }
  return { mode, schedule: next }
}

export interface NcAlarmOpeningsSummary {
  readonly blocking: number
  readonly nonBlocking: number
  readonly unknown: number
}

/**
 * What arming `mode` would find right now. NULL when the hub gave no openings
 * for that mode — "nothing open" is a claim only an answer can make (D315).
 */
export function openingsSummary(
  live: NcAlarmLiveView,
  mode: AlarmArmMode,
): NcAlarmOpeningsSummary | null {
  const row = live.openings.find((o) => o.mode === mode)
  if (row === undefined) return null
  const blocking = row.devices.filter((d) => d.blocking).length
  return {
    blocking,
    nonBlocking: row.devices.length - blocking,
    unknown: row.unknown.length,
  }
}

// ── Arm outcome (mirror of the addon's `NcAlarmArmOutcomeSchema`) ────

/**
 * WHY A HAND-WRITTEN MIRROR: the authority is `NcAlarmArmOutcomeSchema` in
 * `addon-post-analysis/notification-center/alarm/alarm-arm-guard.ts`, an
 * ADDON schema reached through `addons.custom`, whose output is `unknown`. The
 * admin may not import addon source, so the shape is mirrored once here, next
 * to the parser that checks it at runtime: a drift shows as "unreadable
 * answer", never as a silently wrong "armed".
 */
export interface NcAlarmOpenDeviceView {
  readonly deviceId: number
  readonly name: string
  readonly state: string
}

export type NcAlarmRejectReason = 'unknown-refusal' | 'stale' | 'expired' | 'used'
const REJECT_REASONS: readonly NcAlarmRejectReason[] = [
  'unknown-refusal',
  'stale',
  'expired',
  'used',
]

export type NcAlarmArmOutcomeView =
  | {
      readonly outcome: 'armed' | 'arming'
      readonly excluded: readonly NcAlarmOpenDeviceView[]
    }
  | {
      readonly outcome: 'refused'
      readonly refusalId: string
      readonly blocking: readonly NcAlarmOpenDeviceView[]
    }
  | { readonly outcome: 'rejected'; readonly reason: NcAlarmRejectReason }
  | { readonly outcome: 'outside-schedule' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseOpenDevices(value: unknown): NcAlarmOpenDeviceView[] | null {
  if (!Array.isArray(value)) return null
  const out: NcAlarmOpenDeviceView[] = []
  for (const entry of value) {
    if (!isRecord(entry)) return null
    const { deviceId, name, state } = entry
    if (typeof deviceId !== 'number' || typeof name !== 'string' || typeof state !== 'string') {
      return null
    }
    out.push({ deviceId, name, state })
  }
  return out
}

/** Narrow an `addons.custom` answer to an arm outcome, or null. */
export function parseArmOutcome(value: unknown): NcAlarmArmOutcomeView | null {
  if (!isRecord(value)) return null
  const outcome = value.outcome
  if (outcome === 'armed' || outcome === 'arming') {
    const excluded = parseOpenDevices(value.excluded)
    return excluded === null ? null : { outcome, excluded }
  }
  if (outcome === 'refused') {
    const blocking = parseOpenDevices(value.blocking)
    const refusalId = value.refusalId
    if (blocking === null || typeof refusalId !== 'string' || refusalId === '') return null
    return { outcome, refusalId, blocking }
  }
  if (outcome === 'rejected') {
    const reason = REJECT_REASONS.find((r) => r === value.reason)
    return reason === undefined ? null : { outcome, reason }
  }
  if (outcome === 'outside-schedule') return { outcome }
  return null
}

const REJECT_REASON_LABEL: Readonly<Record<NcAlarmRejectReason, string>> = {
  'unknown-refusal': 'the hub no longer knows that refusal',
  stale: 'the panel changed since it refused — arm again',
  expired: 'the refusal expired — arm again',
  used: 'that refusal was already used',
}

export function rejectReasonLabel(reason: NcAlarmRejectReason): string {
  return REJECT_REASON_LABEL[reason]
}

/**
 * Turn ONE of the mode's notification switches (D706) on or off. Off is the default, so
 * "off" CLEARS the stored value (`null`) rather than storing `false` — a mode that sets
 * nothing reads exactly like one that never did. Null = nothing to send.
 */
export function modeNotifyEdit(
  settings:
    | Pick<NcAlarmSettings, 'modeDelays'>
    | { readonly modeDelays?: NcAlarmSettings['modeDelays'] },
  mode: AlarmArmMode,
  field: NcAlarmNotifyField,
  next: boolean,
): NcAlarmModeDelaysEdit | null {
  const stored = (settings.modeDelays ?? []).find((e) => e.mode === mode)?.[field]
  if (next && stored === true) return null
  if (!next && stored === undefined) return null
  const value = next ? true : null
  switch (field) {
    case 'notifyDuringEntryDelay':
      return { mode, notifyDuringEntryDelay: value }
    case 'notifySensorRewatched':
      return { mode, notifySensorRewatched: value }
    case 'notifySensorIgnored':
      return { mode, notifySensorIgnored: value }
  }
}

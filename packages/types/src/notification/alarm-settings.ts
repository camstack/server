/**
 * Alarm settings, as pure functions (D697). Inheritance of per-mode delays, application of a
 * patch's per-field edits and single-membership edit, and the "did my patch land" check.
 *
 * The engine and both clients call these; nobody re-implements them. No I/O, no clock.
 */
import type { AlarmArmMode } from '../capabilities/alarm-panel.cap.js'
import {
  NC_ALARM_NONBLOCKING_MAX,
  type NcAlarmBlocking,
  type NcAlarmBlockingEdit,
  type NcAlarmModeDelays,
  type NcAlarmModeDelaysEdit,
  type NcAlarmModeDeviceList,
  type NcAlarmNonBlocking,
  type NcAlarmNonBlockingEdit,
  type NcAlarmPostTriggeredAction,
  type NcAlarmSecureOnArmEdit,
  type NcAlarmSecureOnArmOff,
  type NcAlarmSettings,
  type NcAlarmSettingsPatch,
  type NcSchedule,
} from '../capabilities/notification-rules.cap.js'

export type NcAlarmDelayField = 'exitDelaySec' | 'entryDelaySec' | 'triggeredDurationSec'
export const NC_ALARM_DELAY_FIELDS: readonly NcAlarmDelayField[] = [
  'exitDelaySec',
  'entryDelaySec',
  'triggeredDurationSec',
]
export type NcAlarmDelaySource = 'mode' | 'default'

/**
 * The STOCK after-trigger duration a panel seeds and every mode inherits unless it sets its
 * own (D706: 30 s, was 10 s under D701). Only the seed: a persisted value is never rewritten.
 * The panel's defaults, its one-shot migration and the admin UI's "pick a timed action" fill
 * all read this one constant.
 */
export const NC_ALARM_DEFAULT_TRIGGERED_DURATION_SEC = 30

/** The per-mode notification switches (D706, D735), all off unless the mode sets them. */
export type NcAlarmNotifyField =
  | 'notifyDuringEntryDelay'
  | 'notifySensorRewatched'
  | 'notifySensorIgnored'
export const NC_ALARM_NOTIFY_FIELDS: readonly NcAlarmNotifyField[] = [
  'notifyDuringEntryDelay',
  'notifySensorRewatched',
  'notifySensorIgnored',
]

/** What one mode's notification switches resolve to (D706). */
export interface NcAlarmModeNotifyPolicy {
  /** The alarm rules' own pushes go out during this mode's entry delay. */
  readonly notifyDuringEntryDelay: boolean
  /** A bypassed sensor that rejoins the watch is announced. */
  readonly notifySensorRewatched: boolean
  /** A bypassed sensor that really MOVED while armed, and was ignored, is announced (D735). */
  readonly notifySensorIgnored: boolean
}

/**
 * The switches `mode` runs on. There is no global value: absent is OFF (operator decision
 * 2026-10-06 — the entry-delay notification is the only one by default, and "watched again"
 * is not sent; 2026-10-07 — nor is "ignored", D735). An answer from an older hub carries no
 * switch and reads as off.
 */
export function resolveModeNotifyPolicy(
  settings: { readonly modeDelays?: readonly NcAlarmModeDelays[] },
  mode: AlarmArmMode,
): NcAlarmModeNotifyPolicy {
  const entry = (settings.modeDelays ?? []).find((e) => e.mode === mode)
  return {
    notifyDuringEntryDelay: entry?.notifyDuringEntryDelay === true,
    notifySensorRewatched: entry?.notifySensorRewatched === true,
    notifySensorIgnored: entry?.notifySensorIgnored === true,
  }
}

/**
 * Derive the post-triggered action from a stored blob that may predate the field:
 * a positive duration meant re-arm; zero/absent meant stay triggered.
 */
export function derivePostTriggeredAction(
  action: NcAlarmPostTriggeredAction | undefined,
  triggeredDurationSec: number,
): NcAlarmPostTriggeredAction {
  if (action !== undefined) return action
  return triggeredDurationSec > 0 ? 'rearmAfter' : 'doNothing'
}

export interface NcAlarmResolvedDelays {
  readonly exitDelaySec: number
  readonly entryDelaySec: number
  readonly triggeredDurationSec: number
  readonly postTriggeredAction: NcAlarmPostTriggeredAction
  readonly source: Readonly<Record<NcAlarmDelayField | 'postTriggeredAction', NcAlarmDelaySource>>
}

/**
 * A settings answer as it travels on the wire. Clients do not parse answers, so a hub older
 * than D697 sends no `modeDelays` (nor, before D636, `nonBlocking`); every reader here treats an absent key as "no overrides".
 */
export type NcAlarmSettingsAnswer = Omit<
  NcAlarmSettings,
  'modeDelays' | 'nonBlocking' | 'blocking' | 'secureOnArmOff'
> & {
  readonly modeDelays?: readonly NcAlarmModeDelays[]
  /** Absent on a hub older than D636: read as "no lists". */
  readonly nonBlocking?: readonly NcAlarmNonBlocking[]
  /** Absent on a hub older than secure-on-arm: read as "no lists". */
  readonly blocking?: readonly NcAlarmBlocking[]
  readonly secureOnArmOff?: readonly NcAlarmSecureOnArmOff[]
}

export type NcAlarmDelaySettings = Pick<
  NcAlarmSettingsAnswer,
  NcAlarmDelayField | 'modeDelays' | 'postTriggeredAction'
>

interface NcAlarmPickedDelay {
  readonly value: number
  readonly source: NcAlarmDelaySource
}

/** The mode's value when it overrides the field, else the global one. */
function pick(override: number | undefined, global: number): NcAlarmPickedDelay {
  return override === undefined
    ? { value: global, source: 'default' }
    : { value: override, source: 'mode' }
}

/** What `mode` actually runs on: its own overrides, the global value for every other field. */
export function resolveModeDelays(
  settings: NcAlarmDelaySettings,
  mode: AlarmArmMode,
): NcAlarmResolvedDelays {
  const entry = (settings.modeDelays ?? []).find((e) => e.mode === mode)
  const exit = pick(entry?.exitDelaySec, settings.exitDelaySec)
  const entryDelay = pick(entry?.entryDelaySec, settings.entryDelaySec)
  const triggered = pick(entry?.triggeredDurationSec, settings.triggeredDurationSec)
  const actionOverride = entry?.postTriggeredAction
  const actionSource: NcAlarmDelaySource = actionOverride !== undefined ? 'mode' : 'default'
  const postTriggeredAction = derivePostTriggeredAction(
    actionOverride ?? settings.postTriggeredAction,
    triggered.value,
  )
  return {
    exitDelaySec: exit.value,
    entryDelaySec: entryDelay.value,
    triggeredDurationSec: triggered.value,
    postTriggeredAction,
    source: {
      exitDelaySec: exit.source,
      entryDelaySec: entryDelay.source,
      triggeredDurationSec: triggered.source,
      postTriggeredAction: actionSource,
    },
  }
}

/** One field of an entry after an edit: number sets, null clears, undefined keeps. */
function edited(current: number | undefined, edit: number | null | undefined): number | undefined {
  if (edit === undefined) return current
  return edit === null ? undefined : edit
}

function editedAction(
  current: NcAlarmPostTriggeredAction | undefined,
  edit: NcAlarmPostTriggeredAction | null | undefined,
): NcAlarmPostTriggeredAction | undefined {
  if (edit === undefined) return current
  return edit === null ? undefined : edit
}

function editedFlag(
  current: boolean | undefined,
  edit: boolean | null | undefined,
): boolean | undefined {
  if (edit === undefined) return current
  return edit === null ? undefined : edit
}

function editedSchedule(
  current: NcSchedule | undefined,
  edit: NcSchedule | null | undefined,
): NcSchedule | undefined {
  if (edit === undefined) return current
  return edit === null ? undefined : edit
}

function sameSchedule(a: NcSchedule | undefined, b: NcSchedule | undefined): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  if (a.invert !== b.invert || a.timezone !== b.timezone) return false
  if (a.windows.length !== b.windows.length) return false
  for (let i = 0; i < a.windows.length; i++) {
    const wa = a.windows[i]
    const wb = b.windows[i]
    if (wa === undefined || wb === undefined) return false
    if (wa.startMinute !== wb.startMinute || wa.endMinute !== wb.endMinute) return false
    if (wa.days.length !== wb.days.length) return false
    for (let d = 0; d < wa.days.length; d++) {
      if (wa.days[d] !== wb.days[d]) return false
    }
  }
  return true
}

/**
 * Apply per-field edits to the stored overrides. Returns new arrays, never mutates the input;
 * an entry with no field left is dropped (the mode inherits everything again).
 */
export function applyModeDelaysEdits(
  current: readonly NcAlarmModeDelays[],
  edits: readonly NcAlarmModeDelaysEdit[],
): NcAlarmModeDelays[] {
  const out: NcAlarmModeDelays[] = current.map((e) => ({ ...e }))
  for (const edit of edits) {
    const at = out.findIndex((e) => e.mode === edit.mode)
    const base: NcAlarmModeDelays = at >= 0 ? (out[at] ?? { mode: edit.mode }) : { mode: edit.mode }
    const next: NcAlarmModeDelays = { mode: edit.mode }
    const exit = edited(base.exitDelaySec, edit.exitDelaySec)
    const entry = edited(base.entryDelaySec, edit.entryDelaySec)
    const triggered = edited(base.triggeredDurationSec, edit.triggeredDurationSec)
    const action = editedAction(base.postTriggeredAction, edit.postTriggeredAction)
    const schedule = editedSchedule(base.schedule, edit.schedule)
    const duringEntry = editedFlag(base.notifyDuringEntryDelay, edit.notifyDuringEntryDelay)
    const rewatched = editedFlag(base.notifySensorRewatched, edit.notifySensorRewatched)
    const ignored = editedFlag(base.notifySensorIgnored, edit.notifySensorIgnored)
    if (exit !== undefined) next.exitDelaySec = exit
    if (entry !== undefined) next.entryDelaySec = entry
    if (triggered !== undefined) next.triggeredDurationSec = triggered
    if (action !== undefined) next.postTriggeredAction = action
    if (schedule !== undefined) next.schedule = schedule
    if (duringEntry !== undefined) next.notifyDuringEntryDelay = duringEntry
    if (rewatched !== undefined) next.notifySensorRewatched = rewatched
    if (ignored !== undefined) next.notifySensorIgnored = ignored
    if (at >= 0) out[at] = next
    else out.push(next)
  }
  return out.filter(
    (e) =>
      e.exitDelaySec !== undefined ||
      e.entryDelaySec !== undefined ||
      e.triggeredDurationSec !== undefined ||
      e.postTriggeredAction !== undefined ||
      e.schedule !== undefined ||
      e.notifyDuringEntryDelay !== undefined ||
      e.notifySensorRewatched !== undefined ||
      e.notifySensorIgnored !== undefined,
  )
}

export type NcAlarmModeDeviceListEditResult =
  | { readonly kind: 'applied'; readonly lists: NcAlarmModeDeviceList[]; readonly changed: boolean }
  | {
      readonly kind: 'refused'
      readonly reason: 'list-full'
      readonly mode: AlarmArmMode
      readonly max: number
    }

/** Alias kept for callers that name the non-blocking edit result. */
export type NcAlarmNonBlockingEditResult = NcAlarmModeDeviceListEditResult

/**
 * Put ONE device on, or take it off, ONE mode's device-id list. A no-op answers
 * `changed: false`; an add to a full list is REFUSED by reason (never silently
 * dropped); an emptied list drops its entry.
 */
export function applyModeDeviceListEdit(
  lists: readonly NcAlarmModeDeviceList[],
  edit: { readonly mode: AlarmArmMode; readonly deviceId: number; readonly present: boolean },
): NcAlarmModeDeviceListEditResult {
  const copy: NcAlarmModeDeviceList[] = lists.map((l) => ({
    mode: l.mode,
    deviceIds: [...l.deviceIds],
  }))
  const at = copy.findIndex((l) => l.mode === edit.mode)
  const held = at >= 0 ? (copy[at]?.deviceIds ?? []) : []
  const present = held.includes(edit.deviceId)
  if (edit.present === present) return { kind: 'applied', lists: copy, changed: false }
  if (edit.present) {
    if (held.length >= NC_ALARM_NONBLOCKING_MAX) {
      return {
        kind: 'refused',
        reason: 'list-full',
        mode: edit.mode,
        max: NC_ALARM_NONBLOCKING_MAX,
      }
    }
    const next: NcAlarmModeDeviceList = { mode: edit.mode, deviceIds: [...held, edit.deviceId] }
    if (at >= 0) copy[at] = next
    else copy.push(next)
  } else {
    const next: NcAlarmModeDeviceList = {
      mode: edit.mode,
      deviceIds: held.filter((id) => id !== edit.deviceId),
    }
    if (at >= 0) copy[at] = next
  }
  return { kind: 'applied', lists: copy.filter((l) => l.deviceIds.length > 0), changed: true }
}

/**
 * Put ONE device on, or take it off, ONE mode's non-blocking list.
 */
export function applyNonBlockingEdit(
  lists: readonly NcAlarmNonBlocking[],
  edit: NcAlarmNonBlockingEdit,
): NcAlarmNonBlockingEditResult {
  return applyModeDeviceListEdit(lists, {
    mode: edit.mode,
    deviceId: edit.deviceId,
    present: edit.nonBlocking,
  })
}

/** Controllable opt-in to blocking. */
export function applyBlockingEdit(
  lists: readonly NcAlarmBlocking[],
  edit: NcAlarmBlockingEdit,
): NcAlarmModeDeviceListEditResult {
  return applyModeDeviceListEdit(lists, {
    mode: edit.mode,
    deviceId: edit.deviceId,
    present: edit.blocking,
  })
}

/**
 * Controllable secure-on-arm: `secureOnArm: true` removes from the opt-out list;
 * `false` adds to it.
 */
export function applySecureOnArmEdit(
  lists: readonly NcAlarmSecureOnArmOff[],
  edit: NcAlarmSecureOnArmEdit,
): NcAlarmModeDeviceListEditResult {
  return applyModeDeviceListEdit(lists, {
    mode: edit.mode,
    deviceId: edit.deviceId,
    present: !edit.secureOnArm,
  })
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  return sa.size === sb.size && [...sa].every((x) => sb.has(x))
}

/** Per-mode id sets of a lists value, empty lists ignored. */
function listsByMode(lists: readonly NcAlarmModeDeviceList[]): Map<AlarmArmMode, Set<number>> {
  const out = new Map<AlarmArmMode, Set<number>>()
  for (const l of lists) if (l.deviceIds.length > 0) out.set(l.mode, new Set(l.deviceIds))
  return out
}

function sameLists(
  a: readonly NcAlarmModeDeviceList[],
  b: readonly NcAlarmModeDeviceList[],
): boolean {
  const ma = listsByMode(a)
  const mb = listsByMode(b)
  if (ma.size !== mb.size) return false
  for (const [mode, ids] of ma) {
    const other = mb.get(mode)
    if (other === undefined || !sameSet([...ids], [...other])) return false
  }
  return true
}

/** The returned entry's value for one field of a mode-delays edit. */
function fieldOf(
  entry: NcAlarmModeDelays | undefined,
  field: NcAlarmDelayField,
): number | undefined {
  if (entry === undefined) return undefined
  switch (field) {
    case 'exitDelaySec':
      return entry.exitDelaySec
    case 'entryDelaySec':
      return entry.entryDelaySec
    case 'triggeredDurationSec':
      return entry.triggeredDurationSec
  }
}

/** The edit's value for one field. */
function editFieldOf(
  edit: NcAlarmModeDelaysEdit,
  field: NcAlarmDelayField,
): number | null | undefined {
  switch (field) {
    case 'exitDelaySec':
      return edit.exitDelaySec
    case 'entryDelaySec':
      return edit.entryDelaySec
    case 'triggeredDurationSec':
      return edit.triggeredDurationSec
  }
}

function listHolds(
  lists: readonly NcAlarmModeDeviceList[] | undefined,
  mode: AlarmArmMode,
  deviceId: number,
): boolean {
  return lists?.find((l) => l.mode === mode)?.deviceIds.includes(deviceId) ?? false
}

/**
 * True iff every key the patch sent is reflected in what the host returned. A host older than
 * this build strips the keys it does not know; this is how a client tells "saved" from "parsed
 * and dropped". `announceArm` is ignored (parsed, never read). A `null` clear "lands" on a host
 * that stripped the key (it lacks the field) — harmless, because such a host stores no overrides.
 * A whole-list `nonBlocking` naming a mode the panel does not offer reads as "not landed" (the host
 * drops it); only older clients and the prune send whole lists, and they do not call this.
 */
export function alarmPatchLanded(
  patch: NcAlarmSettingsPatch,
  returned: NcAlarmSettingsAnswer,
): boolean {
  if (patch.exitDelaySec !== undefined && patch.exitDelaySec !== returned.exitDelaySec) return false
  if (patch.entryDelaySec !== undefined && patch.entryDelaySec !== returned.entryDelaySec)
    return false
  if (
    patch.triggeredDurationSec !== undefined &&
    patch.triggeredDurationSec !== returned.triggeredDurationSec
  ) {
    return false
  }
  if (
    patch.postTriggeredAction !== undefined &&
    patch.postTriggeredAction !==
      derivePostTriggeredAction(returned.postTriggeredAction, returned.triggeredDurationSec)
  ) {
    return false
  }
  if (
    patch.announceTargets !== undefined &&
    !sameSet(patch.announceTargets, returned.announceTargets)
  )
    return false
  if (patch.nonBlocking !== undefined && !sameLists(patch.nonBlocking, returned.nonBlocking ?? []))
    return false
  if (patch.blocking !== undefined && !sameLists(patch.blocking, returned.blocking ?? []))
    return false
  if (
    patch.secureOnArmOff !== undefined &&
    !sameLists(patch.secureOnArmOff, returned.secureOnArmOff ?? [])
  )
    return false
  for (const edit of patch.modeDelays ?? []) {
    const entry = (returned.modeDelays ?? []).find((e) => e.mode === edit.mode)
    for (const field of NC_ALARM_DELAY_FIELDS) {
      const want = editFieldOf(edit, field)
      if (want === undefined) continue
      const got = fieldOf(entry, field)
      if (want === null ? got !== undefined : got !== want) return false
    }
    if (edit.postTriggeredAction !== undefined) {
      const got = entry?.postTriggeredAction
      if (
        edit.postTriggeredAction === null ? got !== undefined : got !== edit.postTriggeredAction
      ) {
        return false
      }
    }
    for (const field of NC_ALARM_NOTIFY_FIELDS) {
      const want = edit[field]
      if (want === undefined) continue
      const got = entry?.[field]
      if (want === null ? got !== undefined : got !== want) return false
    }
    if (edit.schedule !== undefined) {
      const got = entry?.schedule
      if (edit.schedule === null ? got !== undefined : !sameSchedule(got, edit.schedule)) {
        return false
      }
    }
  }
  if (patch.nonBlockingEdit !== undefined) {
    const e = patch.nonBlockingEdit
    if (listHolds(returned.nonBlocking, e.mode, e.deviceId) !== e.nonBlocking) return false
  }
  if (patch.blockingEdit !== undefined) {
    const e = patch.blockingEdit
    if (listHolds(returned.blocking, e.mode, e.deviceId) !== e.blocking) return false
  }
  if (patch.secureOnArmEdit !== undefined) {
    const e = patch.secureOnArmEdit
    // secureOnArm true ⇔ NOT on the opt-out list
    const off = listHolds(returned.secureOnArmOff, e.mode, e.deviceId)
    if (off === e.secureOnArm) return false
  }
  return true
}

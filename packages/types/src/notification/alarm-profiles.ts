/**
 * Alarm configuration profiles — named snapshots of {@link NcAlarmSettings}.
 *
 * One active profile globally (not per arm mode): summer vs winter is a whole
 * membership set, and arm decisions always read the flat settings the active
 * profile last applied. Pure functions only — no I/O, no clock.
 *
 * Create without a source → system defaults (empty memberships, stock delays).
 * Create with `cloneFromId` → a copy of that profile's settings.
 * The Default profile always exists after {@link ensureAlarmProfiles}; it cannot
 * be deleted. Switching active applies that profile's blob for arm decisions.
 */
import type { NcAlarmSettings } from '../capabilities/notification-rules.cap.js'

/** Stable id of the always-present Default profile (migrated from flat settings). */
export const NC_ALARM_DEFAULT_PROFILE_ID = 'default'
export const NC_ALARM_DEFAULT_PROFILE_NAME = 'Default'

/** Stock delays — re-arm 10 s after trigger (inherited by every mode). */
export const NC_ALARM_SYSTEM_DEFAULT_DELAYS = {
  exitDelaySec: 30,
  entryDelaySec: 20,
  triggeredDurationSec: 10,
  postTriggeredAction: 'rearmAfter' as const,
}

/** Empty memberships + stock delays + no announce targets. */
export function ncAlarmSystemDefaultSettings(): NcAlarmSettings {
  return {
    ...NC_ALARM_SYSTEM_DEFAULT_DELAYS,
    announceTargets: [],
    nonBlocking: [],
    blocking: [],
    secureOnArmOff: [],
    modeDelays: [],
  }
}

export interface NcAlarmProfileRecord {
  readonly id: string
  readonly name: string
  readonly settings: NcAlarmSettings
}

export interface NcAlarmProfilesState {
  readonly activeId: string
  readonly profiles: readonly NcAlarmProfileRecord[]
}

export type NcAlarmProfileCreateSource =
  | { readonly kind: 'defaults' }
  | { readonly kind: 'clone'; readonly fromId: string }

export type NcAlarmProfilesMutationResult =
  | { readonly kind: 'ok'; readonly state: NcAlarmProfilesState }
  | {
      readonly kind: 'refused'
      readonly reason: NcAlarmProfilesRefuseReason
      readonly detail?: string
    }

export type NcAlarmProfilesRefuseReason =
  | 'not-found'
  | 'name-empty'
  | 'name-taken'
  | 'cannot-delete-default'
  | 'cannot-rename-default-id'
  | 'clone-source-missing'

export function isDefaultAlarmProfileId(id: string): boolean {
  return id === NC_ALARM_DEFAULT_PROFILE_ID
}

/** Deep-enough copy of a settings blob (arrays replaced, never mutated). */
export function cloneAlarmSettings(settings: NcAlarmSettings): NcAlarmSettings {
  return {
    exitDelaySec: settings.exitDelaySec,
    entryDelaySec: settings.entryDelaySec,
    triggeredDurationSec: settings.triggeredDurationSec,
    ...(settings.postTriggeredAction !== undefined
      ? { postTriggeredAction: settings.postTriggeredAction }
      : {}),
    ...(settings.announceArm !== undefined ? { announceArm: settings.announceArm } : {}),
    announceTargets: [...settings.announceTargets],
    nonBlocking: settings.nonBlocking.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
    blocking: settings.blocking.map((l) => ({ mode: l.mode, deviceIds: [...l.deviceIds] })),
    secureOnArmOff: settings.secureOnArmOff.map((l) => ({
      mode: l.mode,
      deviceIds: [...l.deviceIds],
    })),
    modeDelays: settings.modeDelays.map((e) => ({
      mode: e.mode,
      ...(e.exitDelaySec !== undefined ? { exitDelaySec: e.exitDelaySec } : {}),
      ...(e.entryDelaySec !== undefined ? { entryDelaySec: e.entryDelaySec } : {}),
      ...(e.triggeredDurationSec !== undefined
        ? { triggeredDurationSec: e.triggeredDurationSec }
        : {}),
      ...(e.postTriggeredAction !== undefined
        ? { postTriggeredAction: e.postTriggeredAction }
        : {}),
      ...(e.schedule !== undefined
        ? {
            schedule: {
              windows: e.schedule.windows.map((w) => ({
                days: [...w.days],
                startMinute: w.startMinute,
                endMinute: w.endMinute,
              })),
              ...(e.schedule.timezone !== undefined ? { timezone: e.schedule.timezone } : {}),
              ...(e.schedule.invert === true ? { invert: true as const } : {}),
            },
          }
        : {}),
    })),
  }
}

/**
 * Seed Default from the panel's current flat settings when no profiles exist yet
 * (first boot after this feature, or a wiped profiles key).
 */
export function ensureAlarmProfiles(
  state: NcAlarmProfilesState | null | undefined,
  currentSettings: NcAlarmSettings,
): NcAlarmProfilesState {
  if (state !== null && state !== undefined && state.profiles.length > 0) {
    const hasDefault = state.profiles.some((p) => p.id === NC_ALARM_DEFAULT_PROFILE_ID)
    if (!hasDefault) {
      return {
        activeId: state.activeId,
        profiles: [
          {
            id: NC_ALARM_DEFAULT_PROFILE_ID,
            name: NC_ALARM_DEFAULT_PROFILE_NAME,
            settings: cloneAlarmSettings(currentSettings),
          },
          ...state.profiles,
        ],
      }
    }
    const activeOk = state.profiles.some((p) => p.id === state.activeId)
    return activeOk ? state : { activeId: NC_ALARM_DEFAULT_PROFILE_ID, profiles: state.profiles }
  }
  return {
    activeId: NC_ALARM_DEFAULT_PROFILE_ID,
    profiles: [
      {
        id: NC_ALARM_DEFAULT_PROFILE_ID,
        name: NC_ALARM_DEFAULT_PROFILE_NAME,
        settings: cloneAlarmSettings(currentSettings),
      },
    ],
  }
}

function normalizeName(name: string): string {
  return name.trim()
}

function nameTaken(state: NcAlarmProfilesState, name: string, exceptId?: string): boolean {
  const lower = name.toLowerCase()
  return state.profiles.some((p) => p.id !== exceptId && p.name.trim().toLowerCase() === lower)
}

export function createAlarmProfile(
  state: NcAlarmProfilesState,
  input: {
    readonly name: string
    readonly id: string
    readonly source: NcAlarmProfileCreateSource
  },
): NcAlarmProfilesMutationResult {
  const name = normalizeName(input.name)
  if (name.length === 0) return { kind: 'refused', reason: 'name-empty' }
  if (nameTaken(state, name)) return { kind: 'refused', reason: 'name-taken', detail: name }
  if (isDefaultAlarmProfileId(input.id)) {
    return { kind: 'refused', reason: 'cannot-rename-default-id' }
  }
  let settings: NcAlarmSettings
  if (input.source.kind === 'defaults') {
    settings = ncAlarmSystemDefaultSettings()
  } else {
    const fromId = input.source.fromId
    const src = state.profiles.find((p) => p.id === fromId)
    if (src === undefined) {
      return { kind: 'refused', reason: 'clone-source-missing', detail: fromId }
    }
    settings = cloneAlarmSettings(src.settings)
  }
  return {
    kind: 'ok',
    state: {
      activeId: state.activeId,
      profiles: [...state.profiles, { id: input.id, name, settings }],
    },
  }
}

export function renameAlarmProfile(
  state: NcAlarmProfilesState,
  input: { readonly id: string; readonly name: string },
): NcAlarmProfilesMutationResult {
  const name = normalizeName(input.name)
  if (name.length === 0) return { kind: 'refused', reason: 'name-empty' }
  const at = state.profiles.findIndex((p) => p.id === input.id)
  if (at < 0) return { kind: 'refused', reason: 'not-found', detail: input.id }
  if (nameTaken(state, name, input.id))
    return { kind: 'refused', reason: 'name-taken', detail: name }
  const next = state.profiles.map((p, i) => (i === at ? { ...p, name } : p))
  return { kind: 'ok', state: { activeId: state.activeId, profiles: next } }
}

export function deleteAlarmProfile(
  state: NcAlarmProfilesState,
  id: string,
): NcAlarmProfilesMutationResult {
  if (isDefaultAlarmProfileId(id)) return { kind: 'refused', reason: 'cannot-delete-default' }
  if (!state.profiles.some((p) => p.id === id)) {
    return { kind: 'refused', reason: 'not-found', detail: id }
  }
  const profiles = state.profiles.filter((p) => p.id !== id)
  const activeId = state.activeId === id ? NC_ALARM_DEFAULT_PROFILE_ID : state.activeId
  return { kind: 'ok', state: { activeId, profiles } }
}

export function activateAlarmProfile(
  state: NcAlarmProfilesState,
  id: string,
): NcAlarmProfilesMutationResult {
  if (!state.profiles.some((p) => p.id === id)) {
    return { kind: 'refused', reason: 'not-found', detail: id }
  }
  return { kind: 'ok', state: { activeId: id, profiles: state.profiles } }
}

/** Persist the live flat settings into the active profile's blob. */
export function syncActiveAlarmProfileSettings(
  state: NcAlarmProfilesState,
  settings: NcAlarmSettings,
): NcAlarmProfilesState {
  return {
    activeId: state.activeId,
    profiles: state.profiles.map((p) =>
      p.id === state.activeId ? { ...p, settings: cloneAlarmSettings(settings) } : p,
    ),
  }
}

export function alarmProfileById(
  state: NcAlarmProfilesState,
  id: string,
): NcAlarmProfileRecord | undefined {
  return state.profiles.find((p) => p.id === id)
}

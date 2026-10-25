/**
 * D14 device-config archetype — framework-side contribution derivation.
 *
 * A `deviceConfig` cap with `ui.kind: 'derived-form'` names a `builderId`.
 * This module owns the registry of `builderId → reducer` pure functions
 * that build the UI section from the cap's `getOptions` + `getStatus`
 * output and route a flat form patch back through the cap's `set*`
 * mutation. No per-vendor UI code: reolink and hikvision produce the same
 * section from the same inputs.
 *
 * Two reducer shapes exist, one per save-path surface a `derived-form` cap
 * can expose:
 *   - `kind: 'profile'` — the cap mutates one of several named profiles
 *     via `setProfile({ deviceId, profile, patch })` (`stream-params`).
 *   - `kind: 'settings'` — the cap has no profile axis and mutates via a
 *     single `setSettings({ deviceId, settings })` (`day-night`,
 *     `image-settings`).
 *
 * `device-aggregation.ts` picks which apply function to call by
 * inspecting the bound provider's actual method surface (`setProfile` vs
 * `setSettings`), never by branching on the cap name.
 */
import {
  buildStreamParamsConfigSchema,
  parseStreamParamsFormPatch,
  STREAM_PROFILE_META,
} from '@camstack/types'
import type {
  ConfigUISchema,
  DayNightOptions,
  DayNightStatus,
  ImageSettingsOptions,
  ImageSettingsStatus,
  StreamParamsOptions,
  StreamParamsStatus,
  RecordingOnboardOptions,
  RecordingOnboardStatus,
  StreamProfile,
  StreamProfilePatch,
} from '@camstack/types'
import { buildDayNightConfigSchema, parseDayNightFormPatch } from './day-night-config-schema.js'
import {
  buildImageSettingsConfigSchema,
  parseImageSettingsFormPatch,
} from './image-settings-config-schema.js'
import {
  buildRecordingOnboardConfigSchema,
  parseRecordingOnboardFormPatch,
} from './recording-onboard-config-schema.js'

/** A framework-derived contribution shape — sections[] (+ optional tabs[]). */
export interface DerivedContributionShape {
  readonly tabs?: ReadonlyArray<{ id: string; label: string; icon: string; order?: number }>
  readonly sections: ReadonlyArray<{
    id: string
    title: string
    tab?: string
    order?: number
    description?: string
    columns?: 1 | 2 | 3 | 4
    fields: readonly unknown[]
  }>
}

/** A per-profile mutation callback the cap's provider supplies (profile-based caps only). */
export type ProfileSetter = (profile: StreamProfile, patch: StreamProfilePatch) => Promise<void>

/** Registered builderIds today. New device-config caps add their own reducer below. */
export const STREAM_PARAMS_BUILDER_ID = 'stream-params' as const
export const DAY_NIGHT_BUILDER_ID = 'day-night' as const
export const IMAGE_SETTINGS_BUILDER_ID = 'image-settings' as const
export const RECORDING_ONBOARD_BUILDER_ID = 'recording-onboard' as const

/** Reducer for a profile-based derived-form cap (`stream-params`). */
interface ProfileFormReducer {
  readonly kind: 'profile'
  buildSchema(options: unknown, status: unknown): ConfigUISchema | null
  applyPatch(patch: Record<string, unknown>, setProfile: ProfileSetter): Promise<void>
}

/** Reducer for a `setSettings`-based derived-form cap (`day-night`, `image-settings`). */
interface SettingsFormReducer {
  readonly kind: 'settings'
  buildSchema(options: unknown, status: unknown): ConfigUISchema | null
  parsePatch(patch: Record<string, unknown>): Record<string, unknown>
}

type DerivedFormReducer = ProfileFormReducer | SettingsFormReducer

// `options`/`status` arrive as `unknown` from the dynamically-dispatched
// cap provider call (`registry.getProviderForDevice` resolves structurally,
// not by the cap's Zod schema identity — see capability-system.md). The
// builderId lookup below is the runtime guarantee that the concrete shape
// matches; the narrowing cast at each reducer boundary is the documented
// type boundary, mirroring the pre-existing `stream-params` convention.
const STREAM_PARAMS_REDUCER: ProfileFormReducer = {
  kind: 'profile',
  buildSchema: (options, status) =>
    buildStreamParamsConfigSchema(
      options as StreamParamsOptions,
      (status as StreamParamsStatus | null) ?? null,
    ),
  applyPatch: async (patch, setProfile) => {
    for (const meta of STREAM_PROFILE_META) {
      const profilePatch = parseStreamParamsFormPatch(patch, meta.prefix)
      if (profilePatch) await setProfile(meta.profile, profilePatch)
    }
  },
}

const DAY_NIGHT_REDUCER: SettingsFormReducer = {
  kind: 'settings',
  buildSchema: (options, status) =>
    buildDayNightConfigSchema(
      options as DayNightOptions,
      (status as DayNightStatus | null) ?? null,
    ),
  parsePatch: (patch) => parseDayNightFormPatch(patch),
}

const IMAGE_SETTINGS_REDUCER: SettingsFormReducer = {
  kind: 'settings',
  buildSchema: (options, status) =>
    buildImageSettingsConfigSchema(
      options as ImageSettingsOptions,
      (status as ImageSettingsStatus | null) ?? null,
    ),
  parsePatch: (patch) => parseImageSettingsFormPatch(patch),
}

const RECORDING_ONBOARD_REDUCER: SettingsFormReducer = {
  kind: 'settings',
  buildSchema: (options, status) =>
    buildRecordingOnboardConfigSchema(
      options as RecordingOnboardOptions,
      (status as RecordingOnboardStatus | null) ?? null,
    ),
  parsePatch: (patch) => parseRecordingOnboardFormPatch(patch),
}

const BUILDER_REDUCERS: Readonly<Record<string, DerivedFormReducer>> = {
  [STREAM_PARAMS_BUILDER_ID]: STREAM_PARAMS_REDUCER,
  [DAY_NIGHT_BUILDER_ID]: DAY_NIGHT_REDUCER,
  [IMAGE_SETTINGS_BUILDER_ID]: IMAGE_SETTINGS_REDUCER,
  [RECORDING_ONBOARD_BUILDER_ID]: RECORDING_ONBOARD_REDUCER,
}

function resolveReducer(builderId: string): DerivedFormReducer {
  const reducer = BUILDER_REDUCERS[builderId]
  if (!reducer) {
    throw new Error(`device-config: unknown derived-form builderId "${builderId}"`)
  }
  return reducer
}

/**
 * Build the device-detail form section for a `derived-form` device-config
 * cap. Returns null when the camera exposes no configurable property.
 */
export function deriveFormContribution(
  builderId: string,
  options: unknown,
  status: unknown,
): DerivedContributionShape | null {
  const reducer = resolveReducer(builderId)
  const schema = reducer.buildSchema(options, status)
  if (!schema) return null
  return {
    sections: schema.sections.map((s) => ({
      id: s.id,
      title: s.title,
      ...(s.tab !== undefined ? { tab: s.tab } : {}),
      ...(s.order !== undefined ? { order: s.order } : {}),
      ...(s.description !== undefined ? { description: s.description } : {}),
      ...(s.columns !== undefined ? { columns: s.columns } : {}),
      fields: [...s.fields],
    })),
  }
}

/**
 * Route a flat form patch back through a profile-based cap's per-profile
 * `setProfile` mutation (`stream-params`). Throws if `builderId` isn't
 * registered as a profile-based reducer — callers dispatch here only
 * after confirming the bound provider exposes `setProfile`.
 */
export async function applyDerivedFormProfilePatch(
  builderId: string,
  patch: Record<string, unknown>,
  setProfile: ProfileSetter,
): Promise<void> {
  const reducer = resolveReducer(builderId)
  if (reducer.kind !== 'profile') {
    throw new Error(`device-config: builderId "${builderId}" is not a profile-based derived-form`)
  }
  await reducer.applyPatch(patch, setProfile)
}

/**
 * Parse a flat form patch into the settings payload for a `setSettings`-
 * based cap (`day-night`, `image-settings`). The caller forwards the
 * result verbatim to `dcProvider.setSettings({ deviceId, settings })`.
 * Throws if `builderId` isn't registered as a settings-based reducer.
 */
export function parseDerivedFormSettingsPatch(
  builderId: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const reducer = resolveReducer(builderId)
  if (reducer.kind !== 'settings') {
    throw new Error(`device-config: builderId "${builderId}" is not a settings-based derived-form`)
  }
  return reducer.parsePatch(patch)
}

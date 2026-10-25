/**
 * The per-camera `cameraSensors` setting (D672): stored in the orchestrator's
 * device store beside `motionSources`, keyed by stable refs. This module reads
 * it (a failed read is UNREADABLE, never "not configured" — D49, D393) and
 * gates the write `applyDeviceSettingsPatch` performs.
 */
import {
  CAMERA_SENSORS_SETTINGS_KEY,
  type CameraSensorsConfig,
  CameraSensorsConfigSchema,
  errMsg,
} from '@camstack/types'

export type CameraSensorsSetting =
  | { readonly state: 'not-configured' }
  | { readonly state: 'configured'; readonly config: CameraSensorsConfig }
  | { readonly state: 'unreadable'; readonly reason: string }

export type CameraSensorsPatchVerdict =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly value: CameraSensorsConfig | null }
  | { readonly kind: 'refused'; readonly reason: string }

/** The part of a Zod issue a refusal names. */
interface SettingIssue {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

const NOT_CONFIGURED: CameraSensorsSetting = Object.freeze({ state: 'not-configured' })

function describeIssues(issues: readonly SettingIssue[]): string {
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ')
}

/** Absent or `null` (the operator removed it) is not configured; anything else must parse. */
export function parseCameraSensorsSetting(
  raw: Readonly<Record<string, unknown>>,
): CameraSensorsSetting {
  const value = raw[CAMERA_SENSORS_SETTINGS_KEY]
  if (value === undefined || value === null) return NOT_CONFIGURED
  const parsed = CameraSensorsConfigSchema.safeParse(value)
  return parsed.success
    ? { state: 'configured', config: parsed.data }
    : {
        state: 'unreadable',
        reason: `stored cameraSensors does not parse — ${describeIssues(parsed.error.issues)}`,
      }
}

/** A failed read is UNREADABLE, never "not configured" (D49, D393). */
export async function readCameraSensorsSetting(
  read: () => Promise<Record<string, unknown>>,
): Promise<CameraSensorsSetting> {
  try {
    return parseCameraSensorsSetting(await read())
  } catch (err: unknown) {
    return { state: 'unreadable', reason: `settings read failed — ${errMsg(err)}` }
  }
}

/** The write gate `applyDeviceSettingsPatch` runs before anything is written. */
export function validateCameraSensorsPatch(
  patch: Readonly<Record<string, unknown>>,
): CameraSensorsPatchVerdict {
  if (!(CAMERA_SENSORS_SETTINGS_KEY in patch)) return { kind: 'absent' }
  const value = patch[CAMERA_SENSORS_SETTINGS_KEY]
  if (value === null) return { kind: 'valid', value: null }
  const parsed = CameraSensorsConfigSchema.safeParse(value)
  return parsed.success
    ? { kind: 'valid', value: parsed.data }
    : { kind: 'refused', reason: describeIssues(parsed.error.issues) }
}

/**
 * The knobs D62 retired, and the one-time announcement an operator gets for
 * each device that had set one.
 *
 * ## Why an announcement, and not a silent delete
 *
 * [D61](../../../../../docs/decisions/adr-0061.md) made object events, faces,
 * plates, crops and CLIP vectors TRACK-OWNED: they leave through the track
 * cascade and by no other path. That silently disconnected four settings from
 * the things they were named after. The form kept accepting them; the sweep
 * stopped reading them. An operator who had set `retentionObjectDays: 30` was
 * already losing object events at 7 days before this change — the value on
 * screen had been a lie since D61 shipped.
 *
 * Removing the field only makes that lie stop. It does NOT tell the operator
 * their 30 became 7, and a change discovered three weeks later reads as a bug.
 * So the first retention sweep after the upgrade emits one `warn` per affected
 * device naming the old value and the window that governs now, then unsets the
 * key. Absence of the key IS the migration marker — no flag, no version row,
 * and re-running is a no-op.
 *
 * ## Why the patch uses `undefined` rather than `null`
 *
 * `writeDeviceStore` MERGES (`{ ...existing, ...patch }`) and preserves an
 * explicit `null` as a stored value, which would leave exactly the
 * accepted-but-ignored residue this change exists to remove. `undefined`
 * survives the merge as a key with no value and is dropped by the JSON
 * serialisation the settings blob round-trips through, so the row is gone.
 */

/** A per-device setting the form used to expose that no code consumes any more. */
export type RetiredDeviceSettingKey =
  | 'retentionObjectDays'
  | 'retentionMotionDays'
  | 'retentionAudioDays'
  | 'bufferRetentionDays'

export interface RetiredDeviceSetting {
  readonly key: RetiredDeviceSettingKey
  /** What it used to claim to do. */
  readonly claimed: string
  /** What actually decides that now. */
  readonly nowDecidedBy: string
  /** Why it stopped deciding anything — the record, not a paraphrase. */
  readonly why: string
}

/**
 * Every retired knob, with the sentence that explains it. The list is the
 * declaration `scripts/check-retention-settings-consumed.ts` reads to fail the
 * build if one of these names comes back into the analytics source.
 */
export const RETIRED_DEVICE_SETTINGS: readonly RetiredDeviceSetting[] = [
  {
    key: 'retentionObjectDays',
    claimed: 'how long object events are kept',
    nowDecidedBy: "the device's retention window, through the track cascade",
    why: 'an object event is a state transition OF a track and carries its trackId. D61 made it track-owned, so it dies with its track — measured 19.8 days of object events against 7.0 days of tracks, i.e. the 30 on screen was already not what happened.',
  },
  {
    key: 'retentionMotionDays',
    claimed: 'how long motion events are kept',
    nowDecidedBy: "the device's retention window",
    why: 'motion is a TERMINAL root — it owns nothing and nothing owns it — so it needs a clock, but not a SECOND one. It now takes the same per-device window as the track (D62).',
  },
  {
    key: 'retentionAudioDays',
    claimed: 'how long audio events are kept',
    nowDecidedBy: "the device's retention window",
    why: 'the audio mirror of retentionMotionDays.',
  },
  {
    key: 'bufferRetentionDays',
    claimed: 'how long unassigned face/plate buffer rows are kept',
    nowDecidedBy: "the device's retention window (via the cascade) and bufferMaxPerDevice",
    why: 'a face/plate buffer row carries a trackId. D61 deleted the age half of the buffer prune — it was aging crops out from under tracks still inside their own window — and left the setting in the form reading nothing.',
  },
]

export const RETIRED_DEVICE_SETTING_KEYS: readonly RetiredDeviceSettingKey[] =
  RETIRED_DEVICE_SETTINGS.map((s) => s.key)

/** One retired value found in a device's stored blob. */
export interface RetiredSettingValue {
  readonly key: RetiredDeviceSettingKey
  readonly was: unknown
}

/** What governs the device instead — the two keys that survived. */
export interface GoverningRetention {
  readonly retentionMode: string
  readonly trackRetentionDays: number
}

export interface RetiredSettingsMigration {
  /** Every retired key the device had set, with the operator's value. */
  readonly retired: readonly RetiredSettingValue[]
  /** The policy that replaces all of them. */
  readonly nowGovernedBy: GoverningRetention
  /** The patch to write: each retired key unset, nothing else touched. */
  readonly patch: Record<string, undefined>
}

const DEFAULT_MODE = 'follow-recordings'
const DEFAULT_WINDOW_DAYS = 7

/** Read the surviving pair out of a raw blob for the log line. Deliberately
 *  tolerant — this is a message, not a policy decision, and it must not throw
 *  on a blob that `resolveRetentionSettings` would salvage differently. */
function governingRetention(raw: Record<string, unknown>): GoverningRetention {
  const mode = raw['retentionMode']
  const days = raw['trackRetentionDays']
  return {
    retentionMode: mode === 'custom' || mode === 'follow-recordings' ? mode : DEFAULT_MODE,
    trackRetentionDays: typeof days === 'number' && days >= 0 ? days : DEFAULT_WINDOW_DAYS,
  }
}

/**
 * Plan the migration for one device. `null` = nothing to do, which is the
 * steady state after the first pass and for every device that never set one of
 * these. Pure: the caller logs and writes.
 */
export function planRetiredSettingsMigration(
  raw: Record<string, unknown>,
): RetiredSettingsMigration | null {
  const retired: RetiredSettingValue[] = []
  const patch: Record<string, undefined> = {}
  for (const setting of RETIRED_DEVICE_SETTINGS) {
    if (raw[setting.key] === undefined) continue
    retired.push({ key: setting.key, was: raw[setting.key] })
    patch[setting.key] = undefined
  }
  if (retired.length === 0) return null
  return { retired, nowGovernedBy: governingRetention(raw), patch }
}

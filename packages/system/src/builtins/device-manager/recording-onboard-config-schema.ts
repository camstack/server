/**
 * `recording-onboard` — server-side `ConfigUISchema` builder + form-patch
 * parser. Sibling of `day-night-config-schema.ts`, registered against the
 * `recording-onboard` builderId in `device-config-contribution.ts`.
 *
 * Field keys use the `recordingOnboard_<prop>` prefix so a flat form
 * patch can be re-parsed by {@link parseRecordingOnboardFormPatch}.
 *
 * Two deliberate choices:
 *
 *   - **The schedule is ONE field**, an `editable-array` of windows,
 *     not a field per trigger per day. The device-manager save path has
 *     a single-field entry point (`updateDeviceField`), so a patch may
 *     legitimately carry one key; a schedule spread over many keys could
 *     not be reassembled from such a patch, and reassembling it from a
 *     stale mirror is exactly the second-authority failure D62 forbids.
 *     One key means the value that arrives is always complete.
 *
 *   - **Every field is rendered on every camera**, and one this camera
 *     cannot write is rendered DISABLED with its reason in the
 *     description. Not hidden: a control that vanishes is
 *     indistinguishable from a feature CamStack never built, and
 *     disabled must not look like broken.
 */
import type {
  ConfigField,
  ConfigOption,
  ConfigSection,
  ConfigUISchema,
  OnboardAllowedValues,
  OnboardFieldSupport,
  RecordTrigger,
  RecordWindow,
  RecordingOnboardOptions,
  RecordingOnboardStatus,
} from '@camstack/types'
import { DAY_NAMES, MINUTES_PER_DAY, formatMinutes } from '@camstack/types'

const KEY_PREFIX = 'recordingOnboard_'

export const RECORDING_ONBOARD_KEYS: {
  readonly storageBanner: string
  readonly volumes: string
  readonly tracks: string
  readonly enabled: string
  readonly overwriteWhenFull: string
  readonly preRecordSec: string
  readonly postRecordSec: string
  readonly segmentMinutes: string
  readonly windows: string
} = {
  storageBanner: `${KEY_PREFIX}storageBanner`,
  volumes: `${KEY_PREFIX}volumes`,
  tracks: `${KEY_PREFIX}tracks`,
  enabled: `${KEY_PREFIX}enabled`,
  overwriteWhenFull: `${KEY_PREFIX}overwriteWhenFull`,
  preRecordSec: `${KEY_PREFIX}preRecordSec`,
  postRecordSec: `${KEY_PREFIX}postRecordSec`,
  segmentMinutes: `${KEY_PREFIX}segmentMinutes`,
  windows: `${KEY_PREFIX}windows`,
}

/** Row keys inside the windows `editable-array`. Local, not prefixed. */
export const WINDOW_ROW_KEYS = {
  trigger: 'trigger',
  day: 'day',
  startMinute: 'startMinute',
  endMinute: 'endMinute',
} as const

const TRIGGER_LABELS: Readonly<Record<RecordTrigger, string>> = {
  continuous: 'Continuous',
  motion: 'Motion',
  person: 'Person',
  vehicle: 'Vehicle',
  animal: 'Animal',
  lineCrossing: 'Line crossing',
  intrusion: 'Intrusion',
  loitering: 'Loitering',
  alarmInput: 'Alarm input',
}

/**
 * Append a support reason to a description, so a disabled control always
 * says WHY. Returns undefined when there is nothing to say, because an
 * empty description renders as a stray blank line.
 */
function describeSupport(base: string, support: OnboardFieldSupport): string | undefined {
  if (support.writable) return base.length > 0 ? base : undefined
  const reason = support.reason ?? 'this camera does not expose it'
  const suffix = `Read-only on this camera: ${reason}`
  return base.length > 0 ? `${base} ${suffix}` : suffix
}

function storageBanner(status: RecordingOnboardStatus | null): ConfigField {
  if (!status) {
    return {
      type: 'info',
      key: RECORDING_ONBOARD_KEYS.storageBanner,
      label: 'Onboard storage',
      variant: 'info',
      content: 'Not read from the camera yet.',
    }
  }
  if (status.recordingToNowhere) {
    return {
      type: 'info',
      key: RECORDING_ONBOARD_KEYS.storageBanner,
      label: 'Onboard storage',
      variant: 'danger',
      content:
        'This camera is scheduled to record and has no usable storage. Everything it records is discarded.',
    }
  }
  if (status.storage.kind === 'absent') {
    return {
      type: 'info',
      key: RECORDING_ONBOARD_KEYS.storageBanner,
      label: 'Onboard storage',
      variant: 'warning',
      content: `No usable storage. ${status.storage.reason}`,
    }
  }
  if (status.storage.kind === 'unknown') {
    return {
      type: 'info',
      key: RECORDING_ONBOARD_KEYS.storageBanner,
      label: 'Onboard storage',
      variant: 'warning',
      content: `CamStack could not read this camera's storage, so its state is unknown — not empty. ${status.storage.reason}`,
    }
  }
  return {
    type: 'info',
    key: RECORDING_ONBOARD_KEYS.storageBanner,
    label: 'Onboard storage',
    variant: 'info',
    content:
      'Free space is not a measure of how much footage is held: a card that has wrapped once sits at a fixed reserve forever.',
  }
}

function volumesField(status: RecordingOnboardStatus | null): ConfigField {
  const rows =
    status && status.storage.kind === 'present'
      ? status.storage.volumes.map((volume) => ({
          id: volume.id,
          label: volume.label ?? null,
          status: volume.status === 'ok' ? 'ok' : 'warn',
          capacity: volume.capacityMb === null ? null : `${String(volume.capacityMb)} MB`,
          free: volume.freeMb === null ? null : `${String(volume.freeMb)} MB`,
        }))
      : []
  return {
    type: 'object-array',
    key: RECORDING_ONBOARD_KEYS.volumes,
    label: 'Cards',
    columns: [
      {
        key: 'id',
        label: 'Id',
        labelKey: 'server:volumesField.id.label',
        kind: 'monospace',
        width: '70px',
      },
      {
        key: 'label',
        label: 'Name',
        labelKey: 'server:volumesField.label.label',
        kind: 'monospace',
      },
      {
        key: 'status',
        label: 'Status',
        labelKey: 'server:volumesField.status.label',
        kind: 'status',
      },
      { key: 'capacity', label: 'Capacity', labelKey: 'server:volumesField.capacity.label' },
      { key: 'free', label: 'Free', labelKey: 'server:volumesField.free.label' },
    ],
    value: rows,
    emptyMessage: 'The camera reports no storage.',
  }
}

function tracksField(status: RecordingOnboardStatus | null): ConfigField {
  const rows = (status?.tracks ?? []).map((track) => ({
    id: track.id,
    primary: track.id === status?.primaryTrackId ? 'yes' : '',
    enabled: track.enabled ? 'ok' : 'idle',
    codec: track.codec,
    resolution: track.resolution,
  }))
  return {
    type: 'object-array',
    key: RECORDING_ONBOARD_KEYS.tracks,
    label: 'Recording tracks',
    description:
      'Some cameras keep several tracks with independent schedules. Settings below apply to the primary one. Frame rate is deliberately absent — the value these cameras declare for it is wrong.',
    columns: [
      {
        key: 'id',
        label: 'Track',
        labelKey: 'server:tracksField.id.label',
        kind: 'monospace',
        width: '80px',
      },
      {
        key: 'primary',
        label: 'Primary',
        labelKey: 'server:tracksField.primary.label',
        width: '80px',
      },
      {
        key: 'enabled',
        label: 'Enabled',
        labelKey: 'server:tracksField.enabled.label',
        kind: 'status',
        width: '90px',
      },
      { key: 'codec', label: 'Codec', labelKey: 'server:tracksField.codec.label' },
      { key: 'resolution', label: 'Resolution', labelKey: 'server:tracksField.resolution.label' },
    ],
    value: rows,
    emptyMessage: 'The camera reports no recording track.',
  }
}

function booleanField(
  key: string,
  label: string,
  description: string,
  support: OnboardFieldSupport,
  current: boolean | null,
): ConfigField {
  const field: ConfigField = {
    type: 'boolean',
    key,
    label,
    default: current ?? false,
    disabled: !support.writable,
  }
  const text = describeSupport(description, support)
  return text === undefined ? field : { ...field, description: text }
}

/**
 * Label one member of an allowed SET.
 *
 * Zero is "Off" in every field that carries a set here — no pre-roll and
 * no post-roll are both the feature switched off, and "0 s" is a
 * duration an operator would read as a very short one. A sentinel is
 * named by its meaning rather than printed: Hikvision's no-limit member
 * is `2147483647`, which as a number on a form is nonsense.
 *
 * Whole minutes are shown as minutes because that is how the vendor's
 * own UI offers them — 120, 300 and 600 read back to the operator as
 * "2 min", "5 min", "10 min", which is the list they picked from.
 */
function describeChoice(value: number, unit: string, allowed: OnboardAllowedValues): string {
  const sentinel = allowed.sentinel
  if (sentinel !== undefined && sentinel.value === value) {
    return sentinel.meaning === 'no-limit' ? 'No limit' : 'Off'
  }
  if (value === 0) return 'Off'
  if (unit === 's' && value >= 60 && value % 60 === 0) return `${String(value / 60)} min`
  return `${String(value)} ${unit}`
}

/**
 * A numeric camera setting.
 *
 * An allowed SET is preferred over a range whenever the camera stated
 * one, and it renders a SELECT rather than a number input. A spinner
 * over a set is a control that offers values the camera answers 200 to
 * and then discards — measured on both vendors, and the reason
 * `*Allowed` exists at all. The cap says the set wins; before this, the
 * builder read only the range and the set was declared and rendered by
 * nobody.
 */
function numberField(
  key: string,
  label: string,
  unit: string,
  description: string,
  support: OnboardFieldSupport,
  range: { min: number; max: number; step: number } | undefined,
  current: number | null,
  allowed?: OnboardAllowedValues,
): ConfigField {
  const text = describeSupport(description, support)
  if (allowed !== undefined) {
    const options: ConfigOption[] = allowed.values.map((value) => ({
      value: String(value),
      label: describeChoice(value, unit, allowed),
    }))
    // The camera's CURRENT value may not be a member — a firmware that
    // stores something outside its own offer is exactly what these sets
    // were measured against. Showing it as the default anyway is the
    // truth about the camera; dropping to the first member would
    // misreport it, and saving unchanged would then rewrite it.
    const fallback = allowed.values[0]
    const selected =
      current !== null && allowed.values.includes(current) ? current : (current ?? fallback)
    const field: ConfigField = {
      type: 'select',
      key,
      label,
      options:
        current !== null && !allowed.values.includes(current)
          ? [...options, { value: String(current), label: describeChoice(current, unit, allowed) }]
          : options,
      default: String(selected),
      disabled: !support.writable,
    }
    return text === undefined ? field : { ...field, description: text }
  }
  const field: ConfigField = {
    type: 'number',
    key,
    label,
    unit,
    default: current ?? range?.min ?? 0,
    disabled: !support.writable,
    ...(range ? { min: range.min, max: range.max, step: range.step } : {}),
  }
  return text === undefined ? field : { ...field, description: text }
}

/**
 * The time-of-day offer for a window edge.
 *
 * Stepped at the camera's own granularity when that is coarse (Reolink's
 * 60), and at 15 minutes when it is fine (Hikvision's 1) — a 1-minute
 * offer would be 1 441 options. 15 is a multiple of 1, so every value
 * offered is one the camera accepts; the converse is not true, and a
 * window the camera already holds that falls between the offered values
 * still round-trips because it is carried in the row's value, not
 * re-derived from the offer.
 */
function timeOptions(granularityMinutes: number): ConfigOption[] {
  const step = granularityMinutes >= 30 ? granularityMinutes : 15
  const out: ConfigOption[] = []
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += step) {
    out.push({ value: String(minute), label: formatMinutes(minute) })
  }
  out.push({ value: String(MINUTES_PER_DAY), label: '24:00' })
  return out
}

function windowsField(
  options: RecordingOnboardOptions,
  status: RecordingOnboardStatus | null,
): ConfigField {
  const schedule = options.schedule
  const triggerOptions: ConfigOption[] = schedule.triggers.map((trigger) => ({
    value: trigger,
    label: TRIGGER_LABELS[trigger],
  }))
  const dayOptions: ConfigOption[] = DAY_NAMES.map((name, index) => ({
    value: String(index),
    label: name,
  }))
  const times = timeOptions(schedule.granularityMinutes)

  const itemFields: ConfigField[] = [
    {
      type: 'select',
      key: WINDOW_ROW_KEYS.trigger,
      label: 'Record on',
      options: triggerOptions,
      default: schedule.triggers[0] ?? '',
    },
    { type: 'select', key: WINDOW_ROW_KEYS.day, label: 'Day', options: dayOptions, default: '0' },
    {
      type: 'select',
      key: WINDOW_ROW_KEYS.startMinute,
      label: 'From',
      options: times,
      default: '0',
    },
    {
      type: 'select',
      key: WINDOW_ROW_KEYS.endMinute,
      label: 'To',
      options: times,
      default: String(MINUTES_PER_DAY),
    },
  ]

  const rows = (status?.windows ?? []).map((window) => ({
    [WINDOW_ROW_KEYS.trigger]: window.trigger,
    [WINDOW_ROW_KEYS.day]: String(window.day),
    [WINDOW_ROW_KEYS.startMinute]: String(window.startMinute),
    [WINDOW_ROW_KEYS.endMinute]: String(window.endMinute),
  }))

  const base =
    schedule.granularityMinutes > 1
      ? `This camera's schedule moves in ${String(schedule.granularityMinutes)}-minute steps.`
      : ''
  const overlap = schedule.supportsOverlappingTriggers
    ? ''
    : ' It stores one trigger per time range, so two triggers cannot cover the same minutes on one day.'
  const description = describeSupport(`${base}${overlap}`.trim(), schedule.support)

  const field: ConfigField = {
    type: 'editable-array',
    key: RECORDING_ONBOARD_KEYS.windows,
    label: 'Weekly schedule',
    itemFields,
    defaultItem: {
      [WINDOW_ROW_KEYS.trigger]: schedule.triggers[0] ?? '',
      [WINDOW_ROW_KEYS.day]: '0',
      [WINDOW_ROW_KEYS.startMinute]: '0',
      [WINDOW_ROW_KEYS.endMinute]: String(MINUTES_PER_DAY),
    },
    default: rows,
    disabled: !schedule.support.writable,
    addLabel: 'Add window',
    emptyMessage: 'The camera records on no schedule.',
    rowTitleTemplate: '{day} · {trigger}',
  }
  return description === undefined ? field : { ...field, description }
}

/**
 * Build the `recording-onboard` `ConfigUISchema`.
 *
 * Never returns null. The storage read works on every camera in the
 * fleet, so the section always has something true to say — and a camera
 * CamStack has not reached yet says exactly that, rather than
 * disappearing (D315: not-yet-known must not look like not-installed).
 */
export function buildRecordingOnboardConfigSchema(
  options: RecordingOnboardOptions,
  status: RecordingOnboardStatus | null,
): ConfigUISchema | null {
  const storageSection: ConfigSection = {
    id: 'recording-onboard-storage',
    tab: 'recording',
    title: 'Camera storage',
    titleKey: 'server:storageSection.s_recording-onboard-storage.title',
    description: 'The card in the camera, as the camera itself describes it.',
    descriptionKey: 'server:storageSection.s_recording-onboard-storage.description',
    columns: 1,
    fields: [storageBanner(status), volumesField(status), tracksField(status)],
  }

  const recordingSection: ConfigSection = {
    id: 'recording-onboard-recording',
    tab: 'recording',
    title: 'Camera recording',
    titleKey: 'server:recordingSection.s_recording-onboard-recording.title',
    description:
      "What the camera records to its own card. This writes the camera, not CamStack's recorder.",
    descriptionKey: 'server:recordingSection.s_recording-onboard-recording.description',
    columns: 2,
    fields: [
      booleanField(
        RECORDING_ONBOARD_KEYS.enabled,
        'Record to card',
        'The camera-side master switch.',
        options.enabled,
        status?.enabled ?? null,
      ),
      booleanField(
        RECORDING_ONBOARD_KEYS.overwriteWhenFull,
        'Overwrite when full',
        'Keep recording by discarding the oldest footage.',
        options.overwriteWhenFull,
        status?.overwriteWhenFull ?? null,
      ),
      numberField(
        RECORDING_ONBOARD_KEYS.preRecordSec,
        'Pre-record',
        's',
        'Seconds kept from before the trigger.',
        options.preRecordSec,
        options.preRecordSecRange,
        status?.preRecordSec ?? null,
        options.preRecordSecAllowed,
      ),
      numberField(
        RECORDING_ONBOARD_KEYS.postRecordSec,
        'Post-record',
        's',
        'Seconds kept after the trigger clears.',
        options.postRecordSec,
        options.postRecordSecRange,
        status?.postRecordSec ?? null,
        options.postRecordSecAllowed,
      ),
      numberField(
        RECORDING_ONBOARD_KEYS.segmentMinutes,
        'File length',
        'min',
        'How long one recorded file runs before the camera starts another.',
        options.segmentMinutes,
        options.segmentMinutesRange,
        status?.segmentMinutes ?? null,
        options.segmentMinutesAllowed,
      ),
      windowsField(options, status),
    ],
  }

  return { sections: [storageSection, recordingSection] }
}

// ── Patch parsing ────────────────────────────────────────────────────

function readBoolean(patch: Record<string, unknown>, key: string): boolean | undefined {
  if (!(key in patch)) return undefined
  const value = patch[key]
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function readNumber(patch: Record<string, unknown>, key: string): number | undefined {
  if (!(key in patch)) return undefined
  const value = Number(patch[key])
  return Number.isFinite(value) ? value : undefined
}

/** Is this string one of the cap's triggers? A guard, never a cast. */
function isRecordTrigger(value: unknown): value is RecordTrigger {
  return typeof value === 'string' && value in TRIGGER_LABELS
}

/**
 * Read one row of the windows `editable-array`.
 *
 * Returns null for a row that is not a window. Validation of whether
 * THIS camera accepts the window is deliberately not done here: the
 * provider refuses it by name through `describeOnboardRefusal`, which is
 * the one refusal vocabulary, and duplicating a weaker copy of it in the
 * form parser would give the operator two different answers.
 */
function readWindowRow(row: unknown): RecordWindow | null {
  if (typeof row !== 'object' || row === null) return null
  const record: Record<string, unknown> = { ...row }
  const trigger = record[WINDOW_ROW_KEYS.trigger]
  if (!isRecordTrigger(trigger)) return null
  const day = Number(record[WINDOW_ROW_KEYS.day])
  const startMinute = Number(record[WINDOW_ROW_KEYS.startMinute])
  const endMinute = Number(record[WINDOW_ROW_KEYS.endMinute])
  if (!Number.isInteger(day) || day < 0 || day > 6) return null
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) return null
  return { trigger, day, startMinute, endMinute }
}

/**
 * Re-parse a flat `ConfigFormBuilder` patch into a
 * `RecordingOnboardPatch`-shaped object.
 *
 * Returns only the keys the patch actually carried. The windows key is
 * all-or-nothing on purpose: the field is a single editable array, so
 * its presence means the operator submitted the COMPLETE window set. A
 * row that cannot be read is DROPPED and the remaining set is still
 * submitted — the provider then refuses or applies a set the operator
 * can see in the form, rather than the form and the camera silently
 * disagreeing about a row neither shows.
 */
export function parseRecordingOnboardFormPatch(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  const enabled = readBoolean(patch, RECORDING_ONBOARD_KEYS.enabled)
  if (enabled !== undefined) out.enabled = enabled

  const overwrite = readBoolean(patch, RECORDING_ONBOARD_KEYS.overwriteWhenFull)
  if (overwrite !== undefined) out.overwriteWhenFull = overwrite

  const pre = readNumber(patch, RECORDING_ONBOARD_KEYS.preRecordSec)
  if (pre !== undefined) out.preRecordSec = pre

  const post = readNumber(patch, RECORDING_ONBOARD_KEYS.postRecordSec)
  if (post !== undefined) out.postRecordSec = post

  const segment = readNumber(patch, RECORDING_ONBOARD_KEYS.segmentMinutes)
  if (segment !== undefined) out.segmentMinutes = segment

  if (RECORDING_ONBOARD_KEYS.windows in patch) {
    const raw = patch[RECORDING_ONBOARD_KEYS.windows]
    if (Array.isArray(raw)) {
      const windows: RecordWindow[] = []
      for (const row of raw) {
        const parsed = readWindowRow(row)
        if (parsed) windows.push(parsed)
      }
      out.windows = windows
    }
  }

  return out
}

/**
 * day-night — server-side `ConfigUISchema` builder + form-patch parser.
 *
 * Sibling of `stream-params-config-schema.ts` (which lives in
 * `@camstack/types` because both vendor providers call it directly from
 * their `getConfigSchema` cap method). `day-night` has no such method —
 * it follows the plain D14 `derived-form` archetype (`getOptions` +
 * `getStatus` + one `setSettings` mutation, no per-vendor schema code) —
 * so this builder lives here in `@camstack/system`, registered against
 * the `day-night` builderId in `device-config-contribution.ts`.
 *
 * Field keys use the `dayNight_<prop>` prefix so a flat form patch can be
 * re-parsed into a `DayNightSettingsPatch` by `parseDayNightFormPatch`.
 */
import type {
  ConfigField,
  ConfigSection,
  ConfigUISchema,
  DayNightMode,
  DayNightOptions,
  DayNightSettingsPatch,
  DayNightStatus,
} from '@camstack/types'

const MODE_LABELS: Readonly<Record<DayNightMode, string>> = {
  auto: 'Auto',
  day: 'Day',
  night: 'Night',
  schedule: 'Schedule',
}

/**
 * Build the `day-night` `ConfigUISchema` from the camera-probed options +
 * current status. Returns `null` when the camera exposes no configurable
 * property — the cap then reports "no schema" and the renderer shows the
 * unsupported-camera message.
 */
export function buildDayNightConfigSchema(
  options: DayNightOptions,
  status: DayNightStatus | null,
): ConfigUISchema | null {
  const fields: ConfigField[] = []

  if (options.modes.length > 0) {
    fields.push({
      type: 'select',
      key: 'dayNight_mode',
      label: 'Mode',
      labelKey: 'server:dayNightConfig.dayNight_mode.label',
      options: options.modes.map((m) => ({ value: m, label: MODE_LABELS[m] })),
      default: status?.mode ?? options.modes[0],
    })
  }

  if (options.supportsSensitivity && options.sensitivity) {
    fields.push({
      type: 'slider',
      key: 'dayNight_sensitivity',
      label: 'IR-cut sensitivity',
      labelKey: 'server:dayNightConfig.dayNight_sensitivity.label',
      min: options.sensitivity.min,
      max: options.sensitivity.max,
      step: options.sensitivity.step,
      showValue: true,
      default: status?.sensitivity ?? options.sensitivity.min,
    })
  }

  if (options.supportsSwitchDelay && options.switchDelaySec) {
    fields.push({
      type: 'number',
      key: 'dayNight_switchDelaySec',
      label: 'Switch delay',
      labelKey: 'server:dayNightConfig.dayNight_switchDelaySec.label',
      unit: 's',
      min: options.switchDelaySec.min,
      max: options.switchDelaySec.max,
      step: options.switchDelaySec.step,
      default: status?.switchDelaySec ?? options.switchDelaySec.min,
    })
  }

  if (fields.length === 0) return null

  const section: ConfigSection = {
    id: 'day-night',
    tab: 'image',
    title: 'Day / Night',
    titleKey: 'server:section.s_day-night.title',
    description: 'IR-cut switching mode and the photocell knobs that gate it.',
    descriptionKey: 'server:section.s_day-night.description',
    columns: 2,
    fields,
  }
  return { sections: [section] }
}

const DAY_NIGHT_MODES: ReadonlySet<string> = new Set<DayNightMode>([
  'auto',
  'day',
  'night',
  'schedule',
])

function isDayNightMode(value: unknown): value is DayNightMode {
  return typeof value === 'string' && DAY_NIGHT_MODES.has(value)
}

/**
 * Re-parse a flat `ConfigFormBuilder` patch into a `DayNightSettingsPatch`.
 * Returns an empty object when no `dayNight_*` field changed — the caller
 * (`parseDerivedFormSettingsPatch`) forwards the result verbatim to the
 * cap's `setSettings` mutation, which itself ignores fields it doesn't
 * support.
 */
export function parseDayNightFormPatch(patch: Record<string, unknown>): DayNightSettingsPatch {
  const out: DayNightSettingsPatch = {}

  if ('dayNight_mode' in patch && isDayNightMode(patch.dayNight_mode)) {
    out.mode = patch.dayNight_mode
  }
  if ('dayNight_sensitivity' in patch) {
    const value = Number(patch.dayNight_sensitivity)
    if (Number.isFinite(value)) out.sensitivity = value
  }
  if ('dayNight_switchDelaySec' in patch) {
    const value = Number(patch.dayNight_switchDelaySec)
    if (Number.isFinite(value)) out.switchDelaySec = value
  }

  return out
}

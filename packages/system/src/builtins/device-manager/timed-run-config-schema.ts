/**
 * `timed-run` - server-side `ConfigUISchema` builder + form-patch parser (D14).
 * Sibling of `day-night-config-schema.ts`, registered against the `timed-run`
 * builderId in `device-config-contribution.ts`.
 *
 * One field: the duration the one-tap "Run" button starts this device for, in
 * the unit the type thinks in. The bound is the type's maximum - the same safety
 * bound `runFor` refuses above - so the form cannot offer what the cap refuses.
 */
import type {
  ConfigSection,
  ConfigUISchema,
  TimedRunOptions,
  TimedRunSettingsPatch,
  TimedRunStatus,
} from '@camstack/types'

export const TIMED_RUN_QUICK_RUN_KEY = 'timedRun_quickRunDuration'

export function buildTimedRunConfigSchema(
  options: TimedRunOptions,
  status: TimedRunStatus | null,
): ConfigUISchema | null {
  const section: ConfigSection = {
    id: 'timed-run',
    tab: 'general',
    title: 'One-tap run',
    titleKey: 'server:section.s_timed-run.title',
    description:
      'How long the Run button starts this device for. The hub switches it off when the time is up.',
    descriptionKey: 'server:section.s_timed-run.description',
    columns: 1,
    fields: [
      {
        type: 'number',
        key: TIMED_RUN_QUICK_RUN_KEY,
        label: 'One-tap run',
        labelKey: 'server:timedRunConfig.timedRun_quickRunDuration.label',
        unit: options.unit,
        min: 1,
        max: options.maxDuration,
        step: 1,
        default: status?.quickRun?.duration ?? options.defaultDuration,
      },
    ],
  }
  return { sections: [section] }
}

/**
 * Re-parse a flat form patch into a `TimedRunSettingsPatch`. Empty when the field did not
 * change; a cleared field is `null` (back to the type's default); a value that is not a
 * positive number is REFUSED by name, never dropped to an empty patch that looks saved.
 */
export function parseTimedRunFormPatch(patch: Record<string, unknown>): TimedRunSettingsPatch {
  if (!(TIMED_RUN_QUICK_RUN_KEY in patch)) return {}
  const raw = patch[TIMED_RUN_QUICK_RUN_KEY]
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { quickRunDuration: null }
  }
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`timed-run: the one-tap run must be a positive number, got ${String(raw)}`)
  }
  return { quickRunDuration: value }
}

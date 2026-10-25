/**
 * Resolution of the native-frame hold / tile knobs for one decode session —
 * PARENT side. The result travels to the decode worker on its `start` message
 * (`native-lease-knobs.ts` is the wire half, and the only half the child sees).
 *
 * ## Where the values come from
 *
 * The knobs are cluster-wide `pipeline-orchestrator` settings
 * (`@camstack/types` → `pipeline/native-lease.ts`). The pipeline-runner reads
 * them over the hub-routed `addon-settings` cap
 * (`pipeline-runner/native-lease-settings-source.ts`) and resolves them HERE,
 * once per session, at the moment the session starts — so a changed setting
 * reaches the next session and leaves running ones alone, exactly as before.
 *
 * Until D453 the resolution ran inside the CHILD, from `*_SETTING` env vars the
 * parent wrote at fork time. That bound a worker to the knobs it was forked
 * with (a pre-forked worker cannot be), and it dragged the Zod schemas — the
 * whole `@camstack/types` index — into the child bundle: ~130 ms and ~140 MB
 * per fork, measured. Moving the resolution up one process removed both.
 *
 * ## Precedence — setting > env > default
 *
 * 1. **setting** — the operator set the knob in the orchestrator's global
 *    settings. Wins, because a value someone deliberately chose in the UI must
 *    not be silently overruled by a shell variable nobody can see from there.
 * 2. **env** — {@link NATIVE_LEASE_ENV_VARS}, the pre-settings mechanism, kept
 *    as an emergency / dev override. It applies only while the corresponding
 *    setting is UNSET. "Unset" includes a knob sitting AT its shipped default:
 *    `addon-settings.getGlobalSettings` hydrates an unstored field with the
 *    schema default and offers no way to tell the two apart, so treating the
 *    default as a choice would have retired every env var on the day this
 *    shipped. Move the slider off the default and the setting takes over; move
 *    it back and the env var returns. See `readNativeLeaseOverride`.
 * 3. **default** — {@link DEFAULT_NATIVE_LEASE_SETTINGS}, byte-for-byte the
 *    constants the worker shipped with.
 *
 * A value that fails its bounds at ANY level falls through to the next one
 * rather than being clamped: clamping turns a typo into a number nobody chose,
 * and this one governs how much RAM a busy camera holds.
 *
 * The GPU surface ring (`CAMSTACK_SESSION_NATIVE_CROP_RING`) is deliberately
 * NOT here — see its docblock in `decode-worker-child.ts` for why it stays
 * env-only.
 */
import {
  DEFAULT_NATIVE_LEASE_SETTINGS,
  type NativeLeaseAdmission,
  NativeLeaseAdmissionSchema,
  type NativeLeaseKnob,
  type NativeLeaseNumberKnob,
  type NativeLeaseSettingsOverride,
  NativeLeaseSettingsSchema,
} from '@camstack/types'
import type { NativeLeaseKnobSource, WorkerLeaseKnobs } from './native-lease-knobs.js'

export type { NativeLeaseKnob } from '@camstack/types'
export type { NativeLeaseKnobSource, WorkerLeaseKnobs } from './native-lease-knobs.js'
export { formatNativeLeaseKnobs } from './native-lease-knobs.js'

/** Emergency / dev override env vars (pre-settings; lowest precedence but the default). */
export const NATIVE_LEASE_ENV_VARS: Readonly<Record<NativeLeaseKnob, string>> = {
  holdFrames: 'CAMSTACK_SESSION_NATIVE_LEASE_HOLD_FRAMES',
  budgetMb: 'CAMSTACK_SESSION_NATIVE_LEASE_BUDGET_MB',
  activityMs: 'CAMSTACK_SESSION_NATIVE_LEASE_ACTIVITY_MS',
  admission: 'CAMSTACK_SESSION_NATIVE_LEASE_ADMISSION',
  tileBudgetMb: 'CAMSTACK_SESSION_NATIVE_TILE_BUDGET_MB',
  sceneBudgetMb: 'CAMSTACK_SESSION_NATIVE_SCENE_BUDGET_MB',
}

/** A read-only view of `process.env` — injectable so the resolver is testable. */
export type NativeLeaseEnv = Readonly<Record<string, string | undefined>>

/**
 * Validate one candidate through the knob's own Zod bound. `null` for absent,
 * non-numeric, or out-of-bounds input — the caller then falls through to the
 * next precedence level.
 */
function parseKnob(knob: NativeLeaseNumberKnob, raw: string | number | undefined): number | null {
  if (raw === undefined) return null
  if (typeof raw === 'string' && raw.trim() === '') return null
  const parsed = NativeLeaseSettingsSchema.shape[knob].safeParse(Number(raw))
  return parsed.success ? parsed.data : null
}

/** {@link parseKnob} for the one knob whose value is a word, not a number. */
function parseAdmission(raw: string | undefined): NativeLeaseAdmission | null {
  if (raw === undefined) return null
  const parsed = NativeLeaseAdmissionSchema.safeParse(raw.trim())
  return parsed.success ? parsed.data : null
}

interface ResolvedKnob<T> {
  readonly value: T
  readonly source: NativeLeaseKnobSource
}

/** Resolve one NUMERIC knob across the three precedence levels. */
function resolveKnob(
  knob: NativeLeaseNumberKnob,
  env: NativeLeaseEnv,
  override: NativeLeaseSettingsOverride,
): ResolvedKnob<number> {
  const fromSetting = parseKnob(knob, override[knob])
  if (fromSetting !== null) return { value: fromSetting, source: 'setting' }
  const fromEnv = parseKnob(knob, env[NATIVE_LEASE_ENV_VARS[knob]])
  if (fromEnv !== null) return { value: fromEnv, source: 'env' }
  return { value: DEFAULT_NATIVE_LEASE_SETTINGS[knob], source: 'default' }
}

/** {@link resolveKnob} for `admission`. Same precedence, different parser. */
function resolveAdmission(
  env: NativeLeaseEnv,
  override: NativeLeaseSettingsOverride,
): ResolvedKnob<NativeLeaseAdmission> {
  const fromSetting = parseAdmission(override.admission)
  if (fromSetting !== null) return { value: fromSetting, source: 'setting' }
  const fromEnv = parseAdmission(env[NATIVE_LEASE_ENV_VARS.admission])
  if (fromEnv !== null) return { value: fromEnv, source: 'env' }
  return { value: DEFAULT_NATIVE_LEASE_SETTINGS.admission, source: 'default' }
}

/**
 * Resolve every lease knob for one session. Pure.
 *
 * `override` carries ONLY the knobs the operator actually SET (see
 * `native-lease-settings-source.ts`); an empty object leaves the env override
 * fully functional, which is the whole point of the distinction.
 */
export function resolveNativeLeaseKnobs(
  env: NativeLeaseEnv,
  override: NativeLeaseSettingsOverride,
): WorkerLeaseKnobs {
  const holdFrames = resolveKnob('holdFrames', env, override)
  const budgetMb = resolveKnob('budgetMb', env, override)
  const activityMs = resolveKnob('activityMs', env, override)
  const admission = resolveAdmission(env, override)
  const tileBudgetMb = resolveKnob('tileBudgetMb', env, override)
  const sceneBudgetMb = resolveKnob('sceneBudgetMb', env, override)
  return {
    values: {
      holdFrames: holdFrames.value,
      budgetMb: budgetMb.value,
      activityMs: activityMs.value,
      admission: admission.value,
      tileBudgetMb: tileBudgetMb.value,
      sceneBudgetMb: sceneBudgetMb.value,
    },
    sources: {
      holdFrames: holdFrames.source,
      budgetMb: budgetMb.source,
      activityMs: activityMs.source,
      admission: admission.source,
      tileBudgetMb: tileBudgetMb.source,
      sceneBudgetMb: sceneBudgetMb.source,
    },
  }
}

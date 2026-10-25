/**
 * audio-condition — the authoring logic behind the sustained-sound condition
 * (`NcConditions.audio`), pure and UI-framework-free.
 *
 * WHY IT LIVES HERE
 * ─────────────────
 * Same reason as `condition-taxonomy.ts` next door: two editors author this
 * condition (the admin UI and the viewer), the vocabulary it offers is already
 * in this package (`AUDIO_MACRO_LABELS`), and a second copy of "what a cleared
 * threshold writes" is a mirror free to drift. The viewer keeps its own copy
 * because it is a separate app with its own toolchain; every surface that CAN
 * import `@camstack/types` uses this one.
 *
 * Four behaviours here are not cosmetic:
 *
 *  1. **dBFS is negative-going.** `0` is full scale; digital silence reads
 *     {@link NC_AUDIO_DBFS_FLOOR}. A control that let an operator author `60`
 *     meaning "loud" would write a threshold no sample can reach, and the rule
 *     would look broken rather than mis-configured. Every write is clamped.
 *  2. **Neither filter given = the engine REFUSES.** With no level floor and no
 *     labels every sample is trivially a hit, so the window would fire on
 *     silence. {@link audioIsFailClosed} is how an editor says that BEFORE the
 *     save instead of shipping a rule that never notifies and never says why.
 *  3. **Both label spellings are the same label.** The hub's taxonomy serves
 *     `audio-dog`; the macro catalog and an operator both say `dog`, and the
 *     matcher normalizes the prefix away on both sides. Selection therefore
 *     compares NORMALIZED ids — a rule authored in the admin UI must not read
 *     as "nothing selected" on the phone.
 *  4. **A stored label the build does not know stays visible.** It is offered
 *     as an explicitly-unknown, removable choice, never silently dropped:
 *     rewriting the rule the operator is looking at is worse than showing a
 *     stale id.
 */
import { ituDbfsFromPreEpoch } from '../audio/audio-scale-epoch.js'
import {
  NC_AUDIO_DBFS_FLOOR,
  type NcAudioCondition,
} from '../capabilities/notification-rules.cap.js'
import { AUDIO_MACRO_LABELS } from '../catalogs/audio-classmap.js'
import type { NcTaxonomy } from '../catalogs/nc-taxonomy.js'

/** The `audio-` namespace the NC taxonomy uses for these same macro ids. */
const AUDIO_KIND_PREFIX = 'audio-'

/** Strip the taxonomy's `audio-` namespace: `audio-dog` and `dog` are one label. */
export function normalizeAudioLabel(value: string): string {
  return value.startsWith(AUDIO_KIND_PREFIX) ? value.slice(AUDIO_KIND_PREFIX.length) : value
}

/**
 * The inverse: a macro id in the taxonomy's namespace (`dog` → `audio-dog`),
 * which is the `iconId` every UI resolves to a glyph (`EVENT_KIND_ICONS` in
 * `@camstack/ui-library`, `event-kind-icons.ts` in the viewer). Idempotent, so
 * a value that already carries the namespace is passed through unchanged.
 *
 * This lives here — beside `normalizeAudioLabel` and next to the vocabulary
 * itself — rather than in a UI package, because the *id* is data and the *glyph*
 * is presentation: the server puts the id on a config option, and whichever
 * renderer picks it up (lucide-react on the web, lucide-react-native in the
 * viewer) supplies its own component for it.
 */
export function audioKindId(macroId: string): string {
  return macroId.startsWith(AUDIO_KIND_PREFIX) ? macroId : `${AUDIO_KIND_PREFIX}${macroId}`
}

// ── Cap bounds and offered defaults ─────────────────────────────────

/** Level bounds, in dBFS. Negative-going: the ceiling is full scale. */
export const NC_AUDIO_DB_MIN = NC_AUDIO_DBFS_FLOOR
/**
 * Full scale. The ceiling of dBFS itself on any decoder, not a calibration —
 * untouched by D459 and untouchable by anything like it.
 *
 * @dbfs-era scale-bound
 */
export const NC_AUDIO_DB_MAX = 0
/**
 * Step of the level control — 3 dB is one perceptual notch, not one unit.
 *
 * A step between two levels, so it survives any uniform scale change: 3 dB is
 * the same interval before and after the D459 epoch.
 *
 * @dbfs-era relative
 */
export const NC_AUDIO_DB_STEP = 3
/**
 * Offered when the operator turns the level filter ON. NOT a schema default:
 * an absent `dbThreshold` means "any level" and stays absent until asked for,
 * and a stepper seeded at the -96 floor would need thirty taps to reach a
 * threshold that can actually fire.
 *
 * **It was -30 and -30 is a trap.** dBFS is negative-going, so a HIGHER number
 * is a NARROWER filter, and the sounds this hub is actually asked about are not
 * loud: measured on the live installation, real crying sits between -55 and
 * -26 dBFS. A floor at -30 therefore rejects most of the very sound the
 * operator turned the filter on for, and the rule looks broken rather than
 * mis-seeded. The offered floor is the QUIET end of that measured band; the
 * editor says which way the number runs rather than leaving it to be inferred.
 *
 * ⚠ **That measurement was taken on the pre-D459 scale, and D460 moved this
 * constant because of it.** Until {@link AUDIO_SCALE_EPOCH_MS} the native RTP
 * G.711 decoder reported levels 12.04 dB low (PCMU) or 18.06 dB low (PCMA).
 *
 * This is the ONE absolute-dBFS number in the repo that is a MEASUREMENT
 * rather than a statement about the scale, and it is the only one with a
 * recorded provenance — which is exactly why it is also the only shared
 * constant that converts. Three things agree that the camera it was measured
 * on spoke PCMU:
 *
 *  - 19 of this hub's 25 cameras with audio are PCMU, 5 AAC, 1 L16, 0 PCMA
 *    (codec census over 10 h of `audio: track detected`, 2026-09-11);
 *  - **-55..-26 dBFS is not a close cry on a true scale.** -26 is a quiet
 *    room. Read as a PCMU measurement the band is -43..-14, which is exactly
 *    where a cry a metre from the microphone sits;
 *  - there is no PCMA camera on this installation, so the only candidate
 *    correction is mu-law's.
 *
 * So the band is restated, not re-guessed: the offered floor stays "the QUIET
 * end of the measured band", and the band moves to where it was always really
 * sitting. {@link ituDbfsFromPreEpoch} does the arithmetic so the derivation
 * survives in the source instead of becoming a number somebody preferred.
 *
 * `Math.round` is the control's own granularity, not a fudge: the editor's
 * level field is an integer stepper and `patchAudio` clamps through
 * `clampInt`, so a fractional seed could never reach storage anyway.
 *
 * **This changes no existing rule.** It is what an editor OFFERS when the
 * level filter is switched on with nothing stored; every `dbThreshold` an
 * operator already authored is untouched, and those are a separate question
 * — see D460 on why they are declared rather than migrated.
 *
 * @dbfs-era pre-itu-pcmu
 */
export const NC_AUDIO_DB_OFFERED = Math.round(ituDbfsFromPreEpoch('PCMU', -55))

export const NC_AUDIO_HIT_PERCENT_MIN = 1
export const NC_AUDIO_HIT_PERCENT_MAX = 100
export const NC_AUDIO_SAMPLING_MIN_SEC = 1
export const NC_AUDIO_SAMPLING_MAX_SEC = 300

/**
 * LABEL-mode confirm-count defaults. Chosen against the live "Pianti" rule
 * (2026-08-23): 15 notifies in 12 h, each a single YAMNet `crying` frame,
 * nobody actually crying. Two labelled frames in 5 s drops the single-frame
 * false positives and still catches a real episode (YAMNet labels 2–3
 * frames of a genuine cry).
 */
export const NC_AUDIO_CONFIRM_HITS_DEFAULT = 2
export const NC_AUDIO_CONFIRM_WINDOW_SEC_DEFAULT = 5
export const NC_AUDIO_CONFIRM_HITS_MIN = 1
export const NC_AUDIO_CONFIRM_HITS_MAX = 20
export const NC_AUDIO_CONFIRM_WINDOW_MIN_SEC = 1
export const NC_AUDIO_CONFIRM_WINDOW_MAX_SEC = 60

/** Schema defaults — an untouched sub-field must author exactly these. */
export const NC_AUDIO_DEFAULTS: NcAudioCondition = { hitPercent: 60, samplingSeconds: 10 }

/** What an editor SHOWS for an unset condition — without authoring it. */
export function audioOrDefaults(value: NcAudioCondition | undefined): NcAudioCondition {
  return value ?? NC_AUDIO_DEFAULTS
}

/**
 * The two EXCLUSIVE ways an audio rule works (operator decision, 2026-08-14 —
 * see `docs/decisions/D157-audio-rule-label-mode.md`).
 *
 *  - `label` — the rule NAMES SOUNDS. It fires when `confirmHits` labelled
 *    frames land inside `confirmWindowSec` (default 2 in 5 s), above the
 *    analyzer's own per-device confidence floor. A percentage of frames is
 *    the wrong question; a count of those sparse frames is the brake.
 *  - `level` — the rule NAMES A LEVEL. The sampling window is the whole point:
 *    `hitPercent`% of the samples over `samplingSeconds` must clear
 *    `dbThreshold`.
 */
export type NcAudioMode = 'label' | 'level'

/**
 * Which mode this condition is in — the ONE place that question is answered.
 *
 * The mode is NOT a stored field, deliberately. It is which filter the rule
 * carries, so every rule authored before the modes existed migrates for free
 * and there is no second switch that can disagree with the first (the failure
 * this repo has shipped twice). `null` = neither filter, which the engine
 * refuses (see {@link audioIsFailClosed}).
 *
 * A LEGACY rule carrying BOTH resolves to `label`: it is the mode that fires,
 * and the alternative is silently keeping a window the operator can no longer
 * see in the editor. Nothing new can reach this branch — {@link patchAudio}
 * clears the other filter on every write.
 */
export function audioModeOf(value: NcAudioCondition | undefined): NcAudioMode | null {
  if (value === undefined) return null
  if (value.labels !== undefined && value.labels.length > 0) return 'label'
  if (value.dbThreshold !== undefined) return 'level'
  return null
}

/**
 * True when the condition names NEITHER a level floor NOR any label. The engine
 * refuses such a rule (every sample is a hit, so the window fires on silence) —
 * an editor warns instead of letting the operator ship a rule that never
 * notifies and says nothing about why.
 *
 * An ABSENT condition is not flagged: a rule with no `audio` key is not an
 * audio rule at all.
 */
export function audioIsFailClosed(value: NcAudioCondition | undefined): boolean {
  if (value === undefined) return false
  return (
    value.dbThreshold === undefined && (value.labels === undefined || value.labels.length === 0)
  )
}

/**
 * A patch over the composite condition. A key present with `undefined` CLEARS
 * the (optional) filter; an absent key leaves it alone.
 *
 * `mode` is the explicit switch an editor's mode picker sends. It is not
 * stored — {@link patchAudio} turns it into which filter survives.
 */
export interface NcAudioPatch {
  readonly mode?: NcAudioMode
  readonly labels?: readonly string[] | undefined
  readonly dbThreshold?: number | undefined
  readonly hitPercent?: number
  readonly samplingSeconds?: number
  readonly confirmHits?: number
  readonly confirmWindowSec?: number
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function has(patch: NcAudioPatch, key: keyof NcAudioPatch): boolean {
  return Object.prototype.hasOwnProperty.call(patch, key)
}

/**
 * Apply a sub-field edit, seeding from the defaults when nothing is stored yet.
 * The result is always in-bounds for `NcAudioConditionSchema`, and a cleared
 * filter is OMITTED rather than written as an explicit `undefined` (which
 * survives a merge patch as a deliberate erase and reads as authored).
 *
 * **The two modes are exclusive here, structurally.** Writing labels drops any
 * stored `dbThreshold`; writing a `dbThreshold` drops the labels. The schema
 * cannot say "exactly one of" without becoming a ZodEffects the cap path would
 * have to special-case, so the exclusivity lives in the ONE function every
 * editor writes through — which also means a legacy both-filters rule is
 * normalized the first time it is touched, onto the mode {@link audioModeOf}
 * already reads it as.
 *
 * Switching to `level` with nothing stored seeds {@link NC_AUDIO_DB_OFFERED}:
 * a level rule with no floor is fail-closed, and handing the operator a mode
 * that cannot fire is the trap this whole change exists to remove.
 */
export function patchAudio(
  current: NcAudioCondition | undefined,
  patch: NcAudioPatch,
): NcAudioCondition {
  const base = audioOrDefaults(current)
  const wantedLabels = has(patch, 'labels') ? patch.labels : base.labels
  const wantedDb = has(patch, 'dbThreshold') ? patch.dbThreshold : base.dbThreshold
  const hasLabels = wantedLabels !== undefined && wantedLabels.length > 0
  // Which mode this write lands in: the explicit picker first, then the filter
  // the write itself touched, then whatever the stored condition already was.
  const mode: NcAudioMode | null =
    patch.mode ??
    (has(patch, 'labels') && hasLabels
      ? 'label'
      : has(patch, 'dbThreshold') && wantedDb !== undefined
        ? 'level'
        : hasLabels
          ? 'label'
          : wantedDb !== undefined
            ? 'level'
            : null)
  const labels = mode === 'label' && hasLabels ? wantedLabels : undefined
  const dbThreshold =
    mode !== 'level'
      ? undefined
      : (wantedDb ?? (patch.mode === 'level' ? NC_AUDIO_DB_OFFERED : undefined))
  return {
    ...(labels !== undefined ? { labels: [...labels] } : {}),
    ...(dbThreshold !== undefined
      ? { dbThreshold: clampInt(dbThreshold, NC_AUDIO_DB_MIN, NC_AUDIO_DB_MAX) }
      : {}),
    hitPercent: clampInt(
      patch.hitPercent ?? base.hitPercent,
      NC_AUDIO_HIT_PERCENT_MIN,
      NC_AUDIO_HIT_PERCENT_MAX,
    ),
    samplingSeconds: clampInt(
      patch.samplingSeconds ?? base.samplingSeconds,
      NC_AUDIO_SAMPLING_MIN_SEC,
      NC_AUDIO_SAMPLING_MAX_SEC,
    ),
    ...((): { confirmHits?: number; confirmWindowSec?: number } => {
      const hits = has(patch, 'confirmHits') ? patch.confirmHits : base.confirmHits
      const windowSec = has(patch, 'confirmWindowSec')
        ? patch.confirmWindowSec
        : base.confirmWindowSec
      return {
        ...(hits !== undefined
          ? {
              confirmHits: clampInt(hits, NC_AUDIO_CONFIRM_HITS_MIN, NC_AUDIO_CONFIRM_HITS_MAX),
            }
          : {}),
        ...(windowSec !== undefined
          ? {
              confirmWindowSec: clampInt(
                windowSec,
                NC_AUDIO_CONFIRM_WINDOW_MIN_SEC,
                NC_AUDIO_CONFIRM_WINDOW_MAX_SEC,
              ),
            }
          : {}),
      }
    })(),
  }
}

/**
 * One offered label. `unknown` = stored by the rule, offered by neither the hub
 * nor the local catalog — kept so the operator can SEE it and drop it.
 */
export interface NcAudioLabelChoice {
  readonly value: string
  readonly label: string
  /**
   * Event-taxonomy icon id (`audio-dog`), NOT a glyph. The editor resolves it
   * with its own icon set — `resolveEventKindIcon` (lucide-react) in the admin,
   * `lucide-react-native` in the viewer — so both draw the same icon the
   * timeline and the events tree already use for that class. This used to be an
   * emoji, which is one vocabulary, chosen here, that no other surface spoke.
   */
  readonly iconId: string
  readonly unknown: boolean
}

/**
 * The label choices: the hub's `audioKinds` when it serves them (its WORDS,
 * keyed by the normalized id), else the local macro catalog — plus any stored
 * label neither side knows, marked unknown.
 *
 * The hub's list wins on membership because it knows which macros this cluster
 * actually classifies. The icon id is DERIVED from the id rather than looked
 * up, so a class the hub serves and this build has never heard of still gets a
 * drawable id (the renderer falls back to the audio glyph for an unmapped
 * `audio-*`) instead of a question mark.
 */
export function audioLabelChoices(
  taxonomy: NcTaxonomy | undefined,
  selected: readonly string[] | undefined,
): {
  readonly choices: readonly NcAudioLabelChoice[]
  readonly unknownLabels: readonly string[]
} {
  const fromHub = taxonomy?.audioKinds ?? []
  const choices: NcAudioLabelChoice[] =
    fromHub.length > 0
      ? fromHub.map((entry) => {
          const id = normalizeAudioLabel(entry.kind)
          return {
            value: id,
            label: entry.label,
            iconId: audioKindId(id),
            unknown: false,
          }
        })
      : AUDIO_MACRO_LABELS.map((macro) => ({
          value: macro.id,
          label: macro.name,
          iconId: audioKindId(macro.id),
          unknown: false,
        }))

  const known = new Set(choices.map((choice) => choice.value))
  const unknownLabels: string[] = []
  for (const stored of selected ?? []) {
    const id = normalizeAudioLabel(stored)
    if (known.has(id) || unknownLabels.includes(id)) continue
    unknownLabels.push(id)
    choices.push({ value: id, label: id, iconId: audioKindId(id), unknown: true })
  }
  return { choices, unknownLabels }
}

/**
 * Is this macro id selected? Compares NORMALIZED ids, so a rule authored with
 * the taxonomy spelling (`audio-dog`) reads as selected here.
 */
export function isAudioLabelSelected(labels: readonly string[] | undefined, id: string): boolean {
  const wanted = normalizeAudioLabel(id)
  return (labels ?? []).some((stored) => normalizeAudioLabel(stored) === wanted)
}

/**
 * Toggle one macro id. Removing drops EVERY stored spelling of it; adding
 * appends the bare macro id. Returns `undefined` when the last label goes — the
 * field is optional and absent means "any sound", never an empty array (which
 * `NcAudioConditionSchema` rejects outright).
 */
export function toggleAudioLabel(
  labels: readonly string[] | undefined,
  id: string,
): readonly string[] | undefined {
  const wanted = normalizeAudioLabel(id)
  const current = labels ?? []
  if (isAudioLabelSelected(current, wanted)) {
    const next = current.filter((stored) => normalizeAudioLabel(stored) !== wanted)
    return next.length > 0 ? next : undefined
  }
  return [...current, wanted]
}

/**
 * Pure sentence builders for the scene editor.
 *
 * Split out of the component because these are the whole point of the card and
 * they are the part that can be wrong: this feature's failure mode is SILENCE
 * that reads as "nothing has happened", and the difference between a
 * five-minute fix and a session of guessing is one sentence naming which
 * lighting the scene has never been captured in.
 */

import type { SceneMonitor, SceneUnavailable } from '@camstack/types'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text'

/** The lighting variants an operator is OFFERED. The resolver can also report
 *  `night`, `dawn` and `dusk`; those are shown when present but never demanded,
 *  because most installs only ever see day and IR. */
export const SCENE_CAPTURE_VARIANTS = ['day', 'ir'] as const
export type SceneCaptureVariant = (typeof SCENE_CAPTURE_VARIANTS)[number]

/**
 * The one variant that is genuinely optional.
 *
 * Nobody stands outside at 22:00 to photograph a wheelie bin in infrared, and
 * plenty of scenes are daytime questions that never need a night reference at
 * all. Every sentence about IR in this file is written from that premise: a
 * missing night reference is a CHOICE the scene accommodates, never a fault it
 * reports. The engine backs that up — under the default
 * `onUncoveredCondition: 'skip'` the night checks are simply not made.
 */
export const SCENE_OPTIONAL_VARIANT: SceneCaptureVariant = 'ir'

interface VariantLabelEntry {
  readonly labelKey: string
  readonly labelFallback: string
}

export const VARIANT_LABEL: Readonly<Record<string, VariantLabelEntry>> = {
  day: { labelKey: 'uiLibrary.sceneMonitor.variant.day', labelFallback: 'Daylight' },
  ir: { labelKey: 'uiLibrary.sceneMonitor.variant.ir', labelFallback: 'Night (IR)' },
  night: { labelKey: 'uiLibrary.sceneMonitor.variant.night', labelFallback: 'Night' },
  dawn: { labelKey: 'uiLibrary.sceneMonitor.variant.dawn', labelFallback: 'Dawn' },
  dusk: { labelKey: 'uiLibrary.sceneMonitor.variant.dusk', labelFallback: 'Dusk' },
}

export function variantLabel(condition: string, t: UiTextFn = defaultUiText): string {
  const entry = VARIANT_LABEL[condition]
  return entry === undefined ? condition : t(entry.labelKey, entry.labelFallback)
}

/**
 * "Daylight ✓ · Night (IR) ✗ — optional; checks in night (ir) are skipped."
 *
 * Converts the silent cross-condition fallback this engine used to have into an
 * operator-visible fact. Without it, a scene with only a daylight reference
 * simply stops answering after sunset and nothing anywhere says why.
 *
 * It used to end *"reports 'can't tell' in night (ir)"*, which was accurate and
 * read as a defect: the operator saw a ✗ and a complaint for a scene that was
 * configured exactly as they meant it. The missing half is now named as what it
 * is — the part you do not have to do — and the sentence says what actually
 * happens instead, which differs by the scene's own policy.
 */
export function coverageLine(monitor: SceneMonitor, t: UiTextFn = defaultUiText): string {
  const covered = new Set(monitor.coveredConditions)
  const parts = SCENE_CAPTURE_VARIANTS.map(
    (v) => `${variantLabel(v, t)} ${covered.has(v) ? '✓' : '✗'}`,
  )
  const extra = [...covered].filter((c) => !SCENE_CAPTURE_VARIANTS.some((v) => (v as string) === c))
  for (const c of extra) parts.push(`${variantLabel(c, t)} ✓`)
  const missing = SCENE_CAPTURE_VARIANTS.filter((v) => !covered.has(v))
  if (missing.length === 0) return parts.join(' · ')

  // With nothing captured at all there is no "optional half" to reassure
  // anybody about — the scene is not watching anything yet, and saying so is
  // the only useful sentence.
  if (covered.size === 0) {
    return t(
      'uiLibrary.sceneMonitor.coverage.empty',
      '{{parts}} — nothing captured yet, so this scene is not watching.',
      {
        parts: parts.join(' · '),
      },
    )
  }

  const missingNames = missing.map((v) => variantLabel(v, t).toLowerCase())
  const [first = '', second] = missingNames
  const names =
    second === undefined
      ? first
      : t('uiLibrary.sceneMonitor.coverage.namesJoin', '{{first}} and {{second}}', {
          first,
          second,
        })
  const vars = { parts: parts.join(' · '), names }
  return monitor.onUncoveredCondition === 'judge-anyway'
    ? t(
        'uiLibrary.sceneMonitor.coverage.judgeAnyway',
        '{{parts}} — {{names}} judged against the references you do have.',
        vars,
      )
    : t(
        'uiLibrary.sceneMonitor.coverage.skip',
        '{{parts}} — optional; checks in {{names}} are skipped.',
        vars,
      )
}

/**
 * The calm sentence for a scene that is sitting the current light out — `null`
 * whenever it is checking normally.
 *
 * Separate from {@link statusLine} because it is not a verdict and must not
 * read like one. A paused scene has not failed, has not lost its flag, and
 * needs nothing from the operator; the only thing worth saying is which light
 * it is waiting out and that it will pick itself back up.
 */
export function suspensionLine(monitor: SceneMonitor, t: UiTextFn = defaultUiText): string | null {
  if (monitor.suspendedCondition === null) return null
  const light = variantLabel(monitor.suspendedCondition, t).toLowerCase()
  return t(
    'uiLibrary.sceneMonitor.suspension',
    'Paused — nothing was captured in {{light}}, so checks are on hold until the light changes back. Capture {{light}} if you want it watched around the clock.',
    { light },
  )
}

interface SentenceEntry {
  readonly key: string
  readonly fallback: string
}

const UNAVAILABLE_SENTENCE: Readonly<Record<SceneUnavailable, SentenceEntry>> = {
  // Reachable only when NOTHING has been captured in any light (a scene the
  // operator started and did not finish) — a light with no reference of its own
  // is a pause, not a complaint. See `suspensionLine`.
  'no-reference-for-condition': {
    key: 'uiLibrary.sceneMonitor.unavailable.no_reference_for_condition',
    fallback:
      'can’t tell — nothing has been captured for this scene yet. Press “Capture daylight” to photograph what normal looks like.',
  },
  'view-shifted': {
    key: 'uiLibrary.sceneMonitor.unavailable.view_shifted',
    fallback:
      'can’t tell — the camera view has moved since the reference was captured. Re-capture it.',
  },
  'no-vision-profile': {
    key: 'uiLibrary.sceneMonitor.unavailable.no_vision_profile',
    fallback: 'can’t tell — the vision model is unreachable, so the change is on hold.',
  },
  'encoder-model-changed': {
    key: 'uiLibrary.sceneMonitor.unavailable.encoder_model_changed',
    fallback:
      'can’t tell — the embedding model changed, so the stored references are unreadable. Re-capture them.',
  },
  'no-snapshot': {
    key: 'uiLibrary.sceneMonitor.unavailable.no_snapshot',
    fallback: 'can’t tell — this camera did not return a frame.',
  },
}

/**
 * The one line under a scene's name. It answers, in order: can it judge, what
 * does it say, and how long has it said it.
 */
export function statusLine(
  monitor: SceneMonitor,
  now: number,
  t: UiTextFn = defaultUiText,
): string {
  if (monitor.states.length === 0) {
    return t(
      'uiLibrary.sceneMonitor.status.notArmed',
      'Not armed yet — capture the initial state to start watching.',
    )
  }
  if (monitor.verdict === 'unknown') {
    if (monitor.unavailable === null)
      return t('uiLibrary.sceneMonitor.status.cantTellNow', 'can’t tell right now.')
    const sentence = UNAVAILABLE_SENTENCE[monitor.unavailable]
    return t(sentence.key, sentence.fallback)
  }
  const since = monitor.verdict === 'diverged' ? monitor.divergedAt : monitor.armedAt
  const held =
    since !== null
      ? ` ${t('uiLibrary.sceneMonitor.status.heldFor', 'for {{duration}}', { duration: humanDuration(Math.max(0, now - since)) })}`
      : ''
  // The latch OUTRANKS the pause: a scene that is flagged stays flagged through
  // the night, and burying that under "paused" would be the feature quietly
  // dropping the one thing the operator asked to be told.
  if (monitor.latched) {
    return monitor.verdict === 'diverged'
      ? t(
          'uiLibrary.sceneMonitor.status.changedLatched',
          'CHANGED{{held}} — press Reset when you have dealt with it.',
          { held },
        )
      : t(
          'uiLibrary.sceneMonitor.status.backToNormal',
          'Back to normal, but still flagged as changed{{held}}. Press Reset to clear it.',
          { held },
        )
  }
  const paused = suspensionLine(monitor, t)
  if (paused !== null) return paused
  return monitor.verdict === 'diverged'
    ? t('uiLibrary.sceneMonitor.status.changed', 'CHANGED{{held}}', { held })
    : t('uiLibrary.sceneMonitor.status.normal', 'Normal{{held}}', { held })
}

/** The badge word. `latched` wins over `verdict`, because the latch is the
 *  thing the operator asked to be told and it outlives the live state.
 *
 *  A scene sitting out an uncovered light reads `Paused`, in the NEUTRAL tone —
 *  never `alarm`, and never the `danger` variant the page maps that to. A
 *  missing IR reference must not be able to paint a red badge on a scene that
 *  is doing exactly what it was configured to do. */
export function badgeFor(
  monitor: SceneMonitor,
  t: UiTextFn = defaultUiText,
): {
  text: string
  tone: 'alarm' | 'ok' | 'unknown'
} {
  if (monitor.states.length === 0)
    return { text: t('uiLibrary.sceneMonitor.badge.notArmed', 'Not armed'), tone: 'unknown' }
  if (monitor.latched)
    return { text: t('uiLibrary.sceneMonitor.badge.changed', 'Changed'), tone: 'alarm' }
  if (monitor.suspendedCondition !== null)
    return { text: t('uiLibrary.sceneMonitor.badge.paused', 'Paused'), tone: 'unknown' }
  if (monitor.verdict === 'unknown')
    return { text: t('uiLibrary.sceneMonitor.badge.cantTell', 'Can’t tell'), tone: 'unknown' }
  return monitor.verdict === 'diverged'
    ? { text: t('uiLibrary.sceneMonitor.badge.changed', 'Changed'), tone: 'alarm' }
    : { text: t('uiLibrary.sceneMonitor.badge.normal', 'Normal'), tone: 'ok' }
}

/** A rect covering most of the frame is dominated by weather, sky and parked
 *  cars: the bin is 2 % of the pixels and CLIP will not notice it leaving. The
 *  failure is silent INSENSITIVITY, which is the worst kind — hence a warning
 *  rather than a refusal. */
export const ROI_AREA_WARN_FRACTION = 0.4

export function roiTooLarge(roi: { width: number; height: number }): boolean {
  return roi.width * roi.height > ROI_AREA_WARN_FRACTION
}

export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

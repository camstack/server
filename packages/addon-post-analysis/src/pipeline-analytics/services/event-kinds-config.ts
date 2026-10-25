/**
 * What a camera's CONFIGURED pipeline can emit — the detection macro classes
 * and whether the audio classifier is on — read off `resolvePipeline`.
 *
 * Configuration, not status. `getCameraStatus.detection` is a RUNTIME block:
 * an on-motion camera holds no session between motion events and answers
 * `detection: null` with `reasons.detection: 'armed:on-motion'`. Deriving the
 * taxonomy from it described a camera with 95 person / 48 vehicle / 30 animal
 * tracks in 24 h as one that detects nothing — 24 of the hub's 32 cameras at
 * the time of measurement, and the Events page only looked right because it
 * unions every camera and three of them happened to hold a session (D449).
 * "No session right now" must never read as "not installed" (D315).
 *
 * The class list is {@link FIRST_LEVEL_MACRO_CLASSES} — the one authority the
 * `object-detection` step's `enabledMacroClasses` offer is guarded against —
 * never a second list built here. An explicit, non-empty `enabledMacroClasses`
 * on the step narrows it (the executor's rule: empty means every class);
 * anything in it that is not a first-level macro is dropped, so a stored
 * `'package'` (the COCO proxy the step no longer offers) never advertises the
 * package lane — that lane belongs to the dedicated step and its zone rule.
 */
import type { CameraPipelineConfig } from '@camstack/types'
import { FIRST_LEVEL_MACRO_CLASSES } from '@camstack/types'
import { OBJECT_STEP_ID } from '../retrain/retrain-assist.js'

type PipelineStep = CameraPipelineConfig['steps'][number]

/** What the configured pipeline can emit, for `composeEventKinds`. */
export interface EmittableFromConfig {
  /** First-level macro classes the enabled detector can emit; empty when it is off. */
  readonly macroClasses: readonly string[]
  /** True when the pipeline's audio classifier is enabled. */
  readonly audioEnabled: boolean
}

/** The honest answer for a pipeline that could not be read: nothing advertised. */
export const NO_EMITTABLE: EmittableFromConfig = { macroClasses: [], audioEnabled: false }

/** Depth-first walk of the step tree; the detector is a root today, but the
 *  question is "is it enabled anywhere", not "is it a root". */
function* walkSteps(steps: readonly PipelineStep[]): Generator<PipelineStep> {
  for (const step of steps) {
    yield step
    if (step.children !== undefined) yield* walkSteps(step.children)
  }
}

/**
 * The macro classes an enabled `object-detection` step emits. Order follows
 * the authority, not the stored array, so two cameras narrowed to the same
 * set render the same lanes in the same order.
 */
function macroClassesOf(step: PipelineStep): readonly string[] {
  const stored = step.settings?.['enabledMacroClasses']
  if (!Array.isArray(stored) || stored.length === 0) return [...FIRST_LEVEL_MACRO_CLASSES]
  const chosen = new Set(stored.filter((v): v is string => typeof v === 'string'))
  return FIRST_LEVEL_MACRO_CLASSES.filter((macro) => chosen.has(macro))
}

export function emittableFromPipelineConfig(config: CameraPipelineConfig): EmittableFromConfig {
  let macroClasses: readonly string[] = []
  for (const step of walkSteps(config.steps)) {
    if (step.addonId !== OBJECT_STEP_ID || step.enabled === false) continue
    macroClasses = macroClassesOf(step)
    break
  }
  return { macroClasses, audioEnabled: config.audio?.enabled === true }
}

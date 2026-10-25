/**
 * The OPERATOR's gate on a detection: which classes they enabled, and how sure
 * the detector has to be about each one.
 *
 * Two sliders and a checklist, and they are the whole contract between what an
 * operator sets in the UI and what the system acts on. Everything downstream —
 * an event, a recording, a notification — is only as honest as this.
 *
 * It lived as a private method on the executor, which was correct while the
 * executor was the only root detector. It is not any more: a camera can run the
 * CAMERA's own firmware as its root step, and that path never enters the
 * executor. On device 106 the consequence was that `enabledMacroClasses` and
 * `minConfidence<Macro>` had simply never run on a single one of its
 * detections — and the recorder refused to act on them for exactly that reason
 * (`not-pipeline`), because acting would have been a SECOND TRUTH: the sliders
 * describing one detection and the recording following another.
 *
 * So the gate is one authority in one place, and both roots ask it. That is
 * what lets the refusal downstream be removed instead of weakened.
 */

/**
 * Which gate a detection failed, rather than a bare boolean: the two are
 * remediated differently — enable the class, or lower a slider — and a discard
 * trail that cannot say which is a trail nobody can act on.
 */
export type MacroGateVerdict = 'pass' | 'class-filter' | 'below-threshold'

/**
 * The shape the settings are read from — a loose bag, because it arrives as
 * step settings and is not this module's to define.
 *
 *   - `enabledMacroClasses`: `readonly string[]`. EMPTY MEANS ALL: that is the
 *     legacy behaviour and changing it would silently mute every camera whose
 *     operator never opened the list.
 *   - `minConfidence<Macro>`: `number`, e.g. `minConfidencePerson: 0.5`.
 */
export type MacroGateSettings = Readonly<Record<string, unknown>>

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Apply the operator's class list and per-macro confidence floor. */
export function macroGateVerdict(
  macroClass: string,
  score: number,
  settings?: MacroGateSettings,
): MacroGateVerdict {
  if (!settings) return 'pass'

  const enabled = settings['enabledMacroClasses']
  if (Array.isArray(enabled) && enabled.length > 0) {
    if (!enabled.includes(macroClass)) return 'class-filter'
  }

  const perMacroKey = `minConfidence${capitalize(macroClass)}`
  const perMacroThreshold = settings[perMacroKey]
  if (typeof perMacroThreshold === 'number' && score < perMacroThreshold) {
    return 'below-threshold'
  }

  return 'pass'
}

/** A pipeline step as the attach payload carries it, narrowed to what the gate
 *  needs. */
export interface GateBearingStep {
  readonly enabled?: boolean
  readonly settings?: MacroGateSettings
}

/**
 * The operator's gate, read off the ROOT step.
 *
 * The root is the first ENABLED step — the same one `executor.ts` picks
 * (`enabledSteps[0]`) — because that is the step whose settings the device
 * UI writes `enabledMacroClasses` and `minConfidence<Macro>` into. `undefined`
 * when there is no enabled step or it carries no settings, which the gate
 * itself reads as "pass everything": an absent gate must never mute a camera.
 */
export function rootObjectGate(
  steps: readonly GateBearingStep[] | undefined,
): MacroGateSettings | undefined {
  const root = steps?.find((s) => s.enabled !== false)
  return root?.settings
}

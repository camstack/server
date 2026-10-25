export interface AudioRouterConfig {
  readonly classificationMinScore: number
  /**
   * Macro classes allowed to become an event on this camera. EMPTY means no
   * policy — every class passes. This is the event GENERATOR's allowlist: the
   * classifier still hears and reports everything, and `audioLabels` on the
   * track still carries what it heard. Only the decision "does this become an
   * event" is filtered here, next to the score gate, so there is exactly one
   * place that answers it.
   */
  readonly allowedClasses: readonly string[]
}

export interface TopClassification {
  readonly className: string
  readonly score: number
}

export type AudioRoute =
  | {
      readonly kind: 'classification'
      readonly className: string
      readonly score: number
    }
  | { readonly kind: 'level' }

/**
 * Decide whether an audio frame is a (meaningful) classification event or a
 * level event. `silence` is never a classification — it falls to the level
 * path so only a genuine loudness peak/heartbeat can surface it.
 *
 * A class the operator did not allow takes the SAME route as a class that
 * failed the score: the level path. Both mean "not a classification event on
 * this camera", and giving the allowlist its own harder outcome (a silent
 * drop) would be a second arithmetic for one question.
 */
export function classifyAudioFrame(
  top: TopClassification | undefined,
  cfg: AudioRouterConfig,
): AudioRoute {
  const allowed =
    cfg.allowedClasses.length === 0 || cfg.allowedClasses.includes(top?.className ?? '')
  if (allowed && top && top.className !== 'silence' && top.score >= cfg.classificationMinScore) {
    return {
      kind: 'classification',
      className: top.className,
      score: top.score,
    }
  }
  return { kind: 'level' }
}

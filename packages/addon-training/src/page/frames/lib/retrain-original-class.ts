/**
 * "cat → dog", or "animal/cat → person" when the macro changed too — the class a
 * RECLASSIFIED box used to carry next to the one it carries now. Pure. Anything
 * but a reclassified box with a known original says nothing (`null`).
 */
import type { RetrainMacroClass } from '@camstack/types'
import type { BoxDiff } from './retrain-live-review.js'

export interface OriginalClassText {
  readonly original: string
  readonly current: string
}

export function originalClassText(
  diff: BoxDiff | undefined,
  macroClass: RetrainMacroClass,
  label: string | undefined,
): OriginalClassText | null {
  if (diff?.kind !== 'reclassified' || diff.originMacroClass === undefined) return null
  const originLabel = diff.originLabel ?? ''
  const nowLabel = label ?? ''
  const macroChanged = diff.originMacroClass !== macroClass
  if (!macroChanged && originLabel === nowLabel) return null
  const side = (macro: RetrainMacroClass, text: string): string => {
    if (macroChanged) return text === '' ? macro : `${macro}/${text}`
    return text === '' ? macro : text
  }
  return {
    original: side(diff.originMacroClass, originLabel),
    current: side(macroClass, nowLabel),
  }
}

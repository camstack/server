/**
 * The detector's linked label (D715, D730): when the model that RAN declares a
 * LABEL supply for a step, a detection whose raw class names that step's effect
 * carries the effect as a `ScoredLabel` attributed to `detector-link:<stepId>`
 * — in the step's own vocabulary and tier, so tier 1 means one thing whichever
 * writer produced it.
 *
 * Written at score 0 here, always: the executor cannot see the camera's whole
 * step tree (a detail step placed on another pool is pruned from the dispatch),
 * so it cannot know whether the camera USES the supply. The runner, which holds
 * the attach config, decides with `resolveRootSupply` (`pipeline-runner/root-supply.ts`):
 * effective ⇒ the label is raised to the detection's score, or dropped when the
 * step's class list switched it off; otherwise it stays the score-0 fallback
 * any scored answer of the step outranks.
 */
import {
  LABEL_SUPPLY_MACRO,
  linkedLabelStepId,
  type RootStepSupply,
  type ScoredLabel,
} from '@camstack/types'
import { getStepDefinition } from '../registry/step-definitions.js'

/** The linked labels one mapped root detection carries. Pure. */
export function linkedLabelsFor(
  supplies: readonly RootStepSupply[] | undefined,
  rawClass: string,
  macroClass: string,
  modelId: string,
): readonly ScoredLabel[] {
  if (supplies === undefined || supplies.length === 0) return []
  const out: ScoredLabel[] = []
  for (const supply of supplies) {
    if (supply.kind !== 'label') continue
    if (LABEL_SUPPLY_MACRO[supply.stepId] !== macroClass) continue
    const effect = supply.labelToEffect[rawClass]
    // A step whose effect IS the macro (`package-detection`) has nothing finer
    // to say than the class — the write rule would refuse it as a macro label.
    if (effect === undefined || effect === macroClass) continue
    const tier = getStepDefinition(supply.stepId).labelTier
    out.push({
      label: effect,
      score: 0,
      ...(tier !== undefined ? { tier } : {}),
      stepId: linkedLabelStepId(supply.stepId),
      modelId,
    })
  }
  return out
}

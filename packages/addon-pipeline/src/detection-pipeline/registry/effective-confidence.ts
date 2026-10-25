/**
 * The ONE place a step's default confidence is resolved against the model that
 * runs it (D662, amends D645).
 *
 * A confidence score is a property of one model's output scale, not of the step
 * slot it sits in. `face-detection` declared 0.5 when its only detector was
 * SCRFD; YuNet (`sqrt(cls·obj)`, OpenCV's own default 0.9) inherited it on
 * becoming the default and ~25–35% of the faces the hub kept on 2026-09-27 were
 * not faces. So the DEFAULT is `model.defaultConfidence ?? step.defaultConfidence`.
 *
 * Every reader of a step's default goes through here — the pool floor
 * (`engine-factory`), the slider defaults a step hydrates into its settings
 * (`step-definitions` → `tree-builder`), and the schema the admin UI reads
 * (`provider.getSchema`). A reader that takes `definition.defaultConfidence`
 * directly re-opens the D645 regression for the next model that joins a step.
 *
 * An operator value is NOT resolved here. A step with a threshold slider gets
 * "operator wins" from `tree-builder` (`{ ...schemaDefaults, ...step.settings }`);
 * `face-detection` has no slider and its pool floor takes no operator input, so
 * after D662 nobody but the model sets the face floor.
 */
import type { ModelCatalogEntry, StepDefinition } from '@camstack/types'

/** The step fields this module reads — narrowed so a test needs no full definition. */
export type ConfidenceBearingStep = Pick<StepDefinition, 'defaultConfidence'>

/** The model fields this module reads. */
export type ConfidenceBearingModel = Pick<ModelCatalogEntry, 'defaultConfidence'>

/** The default in force: the model's own floor, else the step's. */
export function resolveModelDefaultConfidence(
  def: ConfidenceBearingStep,
  model: ConfidenceBearingModel | undefined,
): number {
  return model?.defaultConfidence ?? def.defaultConfidence
}

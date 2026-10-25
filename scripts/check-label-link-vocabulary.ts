#!/usr/bin/env tsx
/**
 * Label-link vocabulary guard (D715, D730).
 *
 * A root model that supplies a pipeline step's label writes that step's EFFECT
 * as a tier-1 label (`detector-link:<stepId>`). The effect must be a word of the
 * step's own vocabulary — `LABEL_SUPPLY_VOCABULARIES` — or the same subject
 * reads `car` from one writer and `Car` from the other, and every consumer
 * keyed on the label (notification rules, the training export, the class
 * allow-list that closes a coverage gap) silently splits in two.
 *
 * ## What it checks
 *
 * 1. Every label supply a root declares — a built-in catalog entry (derived
 *    from the step's labels and classMap, as the runner does) and every
 *    plus catalog builder (run over the documented plus catalog base set and the public
 *    COCO catalog) — names a label-supply step, and every `labelToEffect`
 *    value and `uncovered` entry is in that step's vocabulary.
 * 2. The derivation is not vacuous: the plus catalog base set supplies at least
 *    one label step, and the built-in COCO root supplies the animal and vehicle
 *    classifiers (no root is exempt — D730).
 * 3. The step definitions consume the vocabulary rather than a copy: the
 *    animal and vehicle classifiers' `enabledClasses` offer is exactly it.
 *
 * Usage: tsx scripts/check-label-link-vocabulary.ts
 */
import {
  isLabelSupplyStepId,
  LABEL_SUPPLY_VOCABULARIES,
  type LabelSupplyStepId,
  rootSuppliesOf,
} from '../packages/types/src/catalogs/root-model-supply.js'
import type { ModelCatalogEntry } from '../packages/types/src/types/models.js'
import {
  getStep,
  getStepDefinition,
} from '../packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.js'
import {
  buildPlusCatalogCatalogDescriptor,
  PLUS_CATALOG_PUBLIC_CATALOG,
} from '../packages/addon-model-studio/src/plus-catalog/plus-catalog-catalog.js'
import {
  buildPlusCatalogDescriptor,
  PLUS_CATALOG_MODEL_TYPES,
  PLUS_CATALOG_BASE_LABELS,
} from '../packages/addon-model-studio/src/plus-catalog/plus-catalog-import.js'
import { builtInCatalogEntries } from './lib/model-catalogs.js'

const problems: string[] = []

const ROOT = getStepDefinition('object-detection')
const ROOT_DEFAULTS = {
  labels: ROOT.labels ?? [],
  ...(ROOT.classMap !== undefined ? { classMap: ROOT.classMap } : {}),
}

/** Check one root entry's label supplies; returns the steps it supplies a label for. */
function checkEntry(origin: string, entry: ModelCatalogEntry): readonly string[] {
  const supplies = rootSuppliesOf(entry, ROOT_DEFAULTS).flatMap((s) =>
    s.kind === 'label' ? [s] : [],
  )
  for (const supply of supplies) {
    const stepId: string = supply.stepId
    if (!isLabelSupplyStepId(stepId)) {
      problems.push(`${origin} (${entry.id}): supplies unknown label step "${stepId}"`)
      continue
    }
    const vocabulary = new Set(LABEL_SUPPLY_VOCABULARIES[stepId])
    for (const [label, effect] of Object.entries(supply.labelToEffect)) {
      if (!vocabulary.has(effect))
        problems.push(
          `${origin} (${entry.id}): ${stepId} labelToEffect["${label}"] = "${effect}" is not in LABEL_SUPPLY_VOCABULARIES["${stepId}"]`,
        )
    }
    for (const gap of supply.uncovered) {
      if (!vocabulary.has(gap))
        problems.push(
          `${origin} (${entry.id}): ${stepId} uncovered "${gap}" is not in its vocabulary`,
        )
    }
  }
  return supplies.map((s) => s.stepId)
}

for (const { source, entry } of builtInCatalogEntries()) checkEntry(source, entry)
for (const entry of ROOT.models) {
  const steps = checkEntry('object-detection', entry)
  for (const required of ['animal-classifier', 'vehicle-classifier'])
    if (!steps.includes(required))
      problems.push(
        `built-in root ${entry.id} supplies no ${required} — every root is judged by its labels (D730)`,
      )
}
for (const cat of PLUS_CATALOG_PUBLIC_CATALOG)
  checkEntry('plus-catalog-public-catalog', buildPlusCatalogCatalogDescriptor(cat.id).entry)

let plusFills = 0
for (const type of PLUS_CATALOG_MODEL_TYPES) {
  const d = buildPlusCatalogDescriptor({
    type,
    modelId: `guard-${type}`,
    name: 'guard',
    stepId: 'object-detection',
    filename: type === 'mobiledet' ? 'm.tflite' : 'm.onnx',
    sizeMB: 1,
    inputWidth: 320,
    inputHeight: 320,
    labels: PLUS_CATALOG_BASE_LABELS,
  })
  plusFills += checkEntry(`plus-catalog-${type}`, d.entry).length
}
if (plusFills === 0)
  problems.push('the plus catalog base set supplies no label step — the derivation went vacuous')

const OFFERED: readonly LabelSupplyStepId[] = ['animal-classifier', 'vehicle-classifier']
for (const stepId of OFFERED) {
  const field = getStep(stepId)
    .getConfigSchema()
    .find((f) => 'key' in f && f.key === 'enabledClasses')
  const offered = field !== undefined && 'options' in field ? field.options.map((o) => o.value) : []
  const expected = LABEL_SUPPLY_VOCABULARIES[stepId]
  if (offered.join('|') !== expected.join('|'))
    problems.push(
      `${stepId}: enabledClasses offers [${offered.join(', ')}], the vocabulary is [${expected.join(', ')}] — consume LABEL_SUPPLY_VOCABULARIES, do not copy it`,
    )
}

if (problems.length > 0) {
  console.error('✘ label-link vocabulary:')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(
  `✔ label-link vocabulary: every declared label supply speaks its step's vocabulary (${String(plusFills)} plus catalog supplies checked)`,
)

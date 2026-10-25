#!/usr/bin/env tsx
/**
 * Model-scope guard — the catalog and the cluster registry name the SAME steps.
 *
 * ## The failure this catches
 *
 * A step declares `modelScope: 'cluster'` in
 * `packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts`,
 * because that is where a step says what kind of thing its model is. But the
 * three packages that must act on that fact — `pipeline-orchestrator` (renders
 * and stores the one row), `addon-post-analysis` (pins it for a re-embed pass)
 * and `addon-admin-ui` (mirrors it) — may not import an addon, so they read the
 * mirrored registry `CLUSTER_MODEL_SCOPED_STEPS` in `@camstack/types`.
 *
 * Two lists. The moment they disagree the failure is silent and asymmetric:
 *
 *  - **in the catalog, not in the registry** — the node refuses to substitute
 *    (the cluster rule) while nothing ever writes the row, so the step runs on
 *    a default nobody can change and no operator surface admits it exists.
 *  - **in the registry, not in the catalog** — the operator is shown a
 *    cluster-wide model picker for a step that keeps resolving per node. The
 *    knob writes a store nobody reads, which this repo has shipped twice
 *    (AGENTS.md, D62).
 *
 * Neither shows up as an error. Both show up months later as "recognition got
 * worse and nothing changed".
 *
 * ## What it checks
 *
 * 1. Every catalog step with `modelScope: 'cluster'` appears in the registry.
 * 2. Every registry entry names a step that exists in the catalog AND declares
 *    the cluster scope there.
 * 3. Each registry entry's `defaultModelId` is the catalog `defaultModelId` of
 *    that step — the property that makes declaring the scope behaviour-neutral,
 *    and the one that quietly stops holding when a catalog default is bumped.
 * 4. Each registry entry's default is a model the catalog actually LISTS. A
 *    default pointing at a retired id resolves to nothing on every node.
 *
 * Usage: tsx scripts/check-cluster-model-scope.ts
 */
import { CLUSTER_MODEL_SCOPED_STEPS } from '../packages/types/src/pipeline/cluster-model-scope.js'
import { ALL_PIPELINE_STEPS } from '../packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.js'

const REGISTRY_FILE = 'packages/types/src/pipeline/cluster-model-scope.ts'
const CATALOG_FILE = 'packages/addon-pipeline/src/detection-pipeline/registry/step-definitions.ts'

interface Problem {
  readonly where: string
  readonly what: string
  readonly fix: string
}

const problems: Problem[] = []

const catalog = new Map(ALL_PIPELINE_STEPS.map((s) => [s.definition.id, s.definition]))
const clusterInCatalog = ALL_PIPELINE_STEPS.filter(
  (s) => s.definition.modelScope === 'cluster',
).map((s) => s.definition.id)
const registryIds = CLUSTER_MODEL_SCOPED_STEPS.map((s) => s.stepId)

for (const stepId of clusterInCatalog) {
  if (registryIds.includes(stepId)) continue
  problems.push({
    where: CATALOG_FILE,
    what: `step "${stepId}" declares modelScope: 'cluster' but is absent from CLUSTER_MODEL_SCOPED_STEPS`,
    fix: `add it to ${REGISTRY_FILE}, or the node will refuse to substitute a model no operator surface can ever choose`,
  })
}

for (const entry of CLUSTER_MODEL_SCOPED_STEPS) {
  const def = catalog.get(entry.stepId)
  if (def === undefined) {
    problems.push({
      where: REGISTRY_FILE,
      what: `"${entry.stepId}" is not a step in the catalog`,
      fix: `remove the entry, or add the step to ${CATALOG_FILE} — a registry entry for a non-existent step renders an operator knob that writes a store nobody reads`,
    })
    continue
  }
  if (def.modelScope !== 'cluster') {
    problems.push({
      where: CATALOG_FILE,
      what: `"${entry.stepId}" is in CLUSTER_MODEL_SCOPED_STEPS but its definition does not declare modelScope: 'cluster'`,
      fix: `declare it in ${CATALOG_FILE} — otherwise the cluster row is written, shown, and then ignored by every node's resolution`,
    })
  }
  if (def.defaultModelId !== entry.defaultModelId) {
    problems.push({
      where: REGISTRY_FILE,
      what: `"${entry.stepId}" defaults to "${entry.defaultModelId}" here and to "${def.defaultModelId}" in the catalog`,
      fix: 'these must be equal: it is what makes declaring the scope behaviour-neutral. A catalog default was probably bumped without the registry',
    })
  }
  if (!def.models.some((m) => m.id === entry.defaultModelId)) {
    problems.push({
      where: REGISTRY_FILE,
      what: `"${entry.stepId}" defaults to "${entry.defaultModelId}", which is not in that step's model catalog`,
      fix: 'a cluster default the catalog does not list resolves to nothing on every node — pick an id the catalog ships',
    })
  }

  // 5. The dropdown offers exactly the catalog's non-legacy models.
  //
  // A missing option is a model the operator cannot choose cluster-wide, with
  // no error anywhere. An EXTRA option is worse: the operator picks it, every
  // node refuses it (the cluster rule forbids substituting), and the symptom is
  // "recognition stopped" with a perfectly innocent-looking dropdown.
  const catalogOptions = def.models.filter((m) => m.legacy !== true).map((m) => m.id)
  const registryOptions = entry.options.map((o) => o.id)
  for (const id of catalogOptions) {
    if (registryOptions.includes(id)) continue
    problems.push({
      where: REGISTRY_FILE,
      what: `"${entry.stepId}" does not offer catalog model "${id}"`,
      fix: `add { id: '${id}', label: '${def.models.find((m) => m.id === id)?.name ?? id}' } to its options — otherwise no operator surface can ever select it`,
    })
  }
  for (const id of registryOptions) {
    if (catalogOptions.includes(id)) continue
    problems.push({
      where: REGISTRY_FILE,
      what: `"${entry.stepId}" offers "${id}", which the catalog does not ship as a selectable (non-legacy) model`,
      fix: 'remove it: choosing it would be refused by every node, and the dropdown would look fine while recognition stopped',
    })
  }
}

if (problems.length > 0) {
  console.error('\n✗ cluster model scope: catalog and registry disagree\n')
  for (const p of problems) {
    console.error(`  ${p.where}`)
    console.error(`    ${p.what}`)
    console.error(`    → ${p.fix}\n`)
  }
  process.exit(1)
}

console.log(
  `✓ cluster model scope: ${registryIds.length} cluster-scoped step(s) agree across catalog and registry (${registryIds.join(', ')})`,
)

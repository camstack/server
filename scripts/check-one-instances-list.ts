#!/usr/bin/env tsx
/**
 * One list of configured things (planning#440 step 6, D1013).
 *
 * `components/instances/InstancesTable` (with `InstanceEditorDialog` / `InstanceCreateDialog`) is the
 * only list-and-edit surface of a family of configured things: the rows, the create form, the edit
 * form, the switch, the test and the delete are one component, driven by `integration-instances`.
 * A page that draws its own list or form for such a family is a bespoke one.
 *
 * A file in `packages/addon-admin-ui/src` outside `components/instances/` is a bespoke instance list
 * when it
 * - makes a CRUD call of a configured thing of a family that moves to instances: a generated hook or a
 *   `trpcClient.<cap>.<upsert|create|update|delete|remove...>.mutate` of one of those caps
 *   (notification-output, llm, storage, mesh-network, training-provider), a
 *   CRUD-named hook (`useStorageUpsertLocation`) or a custom action named like one (`deleteSource`);
 *   or
 * - draws a list or form surface (it names `ItemFormDialog` or `DataTable`) AND runs any other
 *   mutation of those caps (join, leave, log in).
 *
 * Every file that does so today is in `scripts/one-instances-list-baseline.json`, in the family whose
 * packet deletes the page, with its reason. The baseline only shrinks; a listed file that no longer
 * matches is an error too. Key: the repo path.
 *
 * Textual: the source is read, not run. Specs, `__tests__` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-one-instances-list.ts
 */
import path from 'node:path'
import {
  compareToBaseline,
  type FamilyBaseline,
  type Finding,
  isMain,
  isProductSource,
  loadBaseline,
  ROOT,
  readSources,
  report,
  type SourceFile,
  type Violation,
  walk,
} from './lib/family-baseline.js'

export const BASELINE_PATH = 'scripts/one-instances-list-baseline.json'
const ADMIN_UI_SRC = 'packages/addon-admin-ui/src/'
const INSTANCES_DIR = 'packages/addon-admin-ui/src/components/instances/'

const SURFACE_RE = /\b(?:ItemFormDialog|DataTable)\b/
const FAMILY_CAPS =
  'NotificationOutput|Llm|Storage|MeshNetwork|TrainingProvider|IntegrationInstances'
const FAMILY_TRPC =
  'notificationOutput|llm|storage|meshNetwork|trainingProvider|integrationInstances'
const CRUD_NOUN = 'Target|Profile|Connection|Source|Entry'
/** A CRUD call of a configured thing: the editor of a family, whatever surface draws it. */
const CRUD_RES: readonly RegExp[] = [
  // A generated hook of a family cap, e.g. useStorageUpsertLocation.
  new RegExp(`\\buse(?:${FAMILY_CAPS})\\w*(?:Upsert|Create|Update|Delete|Remove)\\w*`),
  // A direct client call, e.g. system.trpcClient.llm.upsertProfile.mutate(...)
  new RegExp(
    `trpcClient\\.(?:${FAMILY_TRPC})\\.(?:upsert|create|update|delete|remove)\\w*\\.mutate\\b`,
  ),
  // A CRUD-named hook or custom action of a configured thing.
  new RegExp(`\\buse\\w*(?:Upsert|Create|Update|Delete|Remove)(?:${CRUD_NOUN})\\b`),
  new RegExp(`\\bcustom\\(\\s*'(?:create|update|delete|upsert)(?:${CRUD_NOUN})'`),
]
/** Any other mutation of a family cap (join, leave, log in...): the page's own list, if it draws one. */
const FAMILY_MUTATION_RES: readonly RegExp[] = [
  new RegExp(`\\buse(?:${FAMILY_CAPS})\\w*(?:Leave|Logout|StartLogin|Join|Add)\\w*`),
  new RegExp(`trpcClient\\.(?:${FAMILY_TRPC})\\.\\w+\\.mutate\\b`),
]

export function isBespokeInstanceList(file: SourceFile): boolean {
  if (!file.path.startsWith(ADMIN_UI_SRC) || file.path.startsWith(INSTANCES_DIR)) return false
  if (CRUD_RES.some((re) => re.test(file.text))) return true
  return SURFACE_RE.test(file.text) && FAMILY_MUTATION_RES.some((re) => re.test(file.text))
}

export function findViolations(
  sources: readonly SourceFile[],
  baseline: FamilyBaseline,
): Violation[] {
  const findings: Finding[] = sources.filter(isBespokeInstanceList).map((file) => ({
    key: file.path,
    where: file.path,
    message: `draws its own list or form for a family of configured things. Use components/instances/InstancesTable (InstanceEditorDialog / InstanceCreateDialog); a page that cannot move yet is listed, with its reason, in ${BASELINE_PATH}`,
  }))
  return compareToBaseline(findings, baseline, BASELINE_PATH)
}

function main(): number {
  const files = walk(path.join(ROOT, ADMIN_UI_SRC), isProductSource)
  const violations = findViolations(readSources(files), loadBaseline(BASELINE_PATH))
  return report('check-one-instances-list', violations)
}

if (isMain(import.meta.url)) process.exit(main())

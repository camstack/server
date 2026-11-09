#!/usr/bin/env tsx
/**
 * One CRUD for a collection of configured things (planning#440 step 6, D1013).
 *
 * `integration-instances` is the only way to list, create, edit and delete an instance. A capability
 * method (`*.cap.ts`) or a custom action (a file that calls `defineCustomActions(`) whose name reads
 * as the CRUD of a family of configured things -- `listTargets`, `upsertProfile`, `deleteLocation`,
 * `createSource`, a kind catalogue (`listProfileKinds`), a form schema (`instanceFormSchema`
 * shaped `...FormSchema`) -- is a second CRUD, so it is refused unless it is in
 * `scripts/collection-crud-baseline.json` under its family, with the reason it cannot move yet.
 *
 * The baseline only shrinks: a family's packet deletes its block in the same change that deletes the
 * methods, and a listed method that no longer exists is an error too. The `permanent` family lists the
 * methods that match by name but are runtime reads or another kind of thing; they stay.
 *
 * Key: `<cap file>:<method>` for a cap, `<repo path>:<method>` for a custom-actions file.
 * Textual: the source is read, not run. Specs, `__tests__`, `dist` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-collection-crud-is-instances.ts
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

export const BASELINE_PATH = 'scripts/collection-crud-baseline.json'

/**
 * A declaration, quoted or not: a custom action is keyed `'nc.listMyTargets':`, which an unquoted
 * `\w+` never read -- the guard was blind to every namespaced action.
 */
const DECL_RE = /^\s{2,4}['"]?([\w.]+)['"]?\s*:\s*(?:optionalMethod|method|customAction)\s*[(<]/
/** `nc.` namespace and the `My` of "my targets" are not a different CRUD. */
const CRUD_NAME_RE = new RegExp(
  [
    '^(?:\\w+\\.)?(?:list|get|upsert|create|update|delete|remove|add)(?:My)?',
    '(?:Target|Profile|Connection|LocationDeclaration|Location|Source|Entry|Entries|Provider|DrainProgress)s?$',
    '|^(?:\\w+\\.)?(?:discoverTargets|probeTargetConfig|describeTypes)$',
    '|^(?:\\w+\\.)?list(?:Target|Profile|Provider|Connection|Location|Source|Entry|Instance)Kinds$',
    '|^(?:\\w+\\.)?\\w*FormSchema$',
  ].join(''),
)
/** The one CRUD every family folds into. */
const INSTANCES_CAP = 'integration-instances.cap.ts'

/** The method names of one file that read as the CRUD of a family. */
export function crudMethodsOf(text: string): string[] {
  const out: string[] = []
  for (const line of text.split('\n')) {
    const m = DECL_RE.exec(line)
    if (m?.[1] !== undefined && CRUD_NAME_RE.test(m[1])) out.push(m[1])
  }
  return out
}

export function findViolations(
  sources: readonly SourceFile[],
  baseline: FamilyBaseline,
): Violation[] {
  const findings: Finding[] = []
  for (const source of sources) {
    const base = source.path.slice(source.path.lastIndexOf('/') + 1)
    const isCap = source.path.endsWith('.cap.ts')
    if (!isCap && !source.text.includes('defineCustomActions(')) continue
    if (base === INSTANCES_CAP) continue
    for (const method of crudMethodsOf(source.text)) {
      findings.push({
        key: `${isCap ? base : source.path}:${method}`,
        where: source.path,
        message: `${method}: a second CRUD for a collection of configured things. Use integration-instances (listInstances / upsertInstance / deleteInstance / instanceFormSchema); a family that cannot move yet is listed, with its reason, in ${BASELINE_PATH}`,
      })
    }
  }
  return compareToBaseline(findings, baseline, BASELINE_PATH)
}

function main(): number {
  const files = walk(path.join(ROOT, 'packages'), isProductSource).filter(
    (f) => f.endsWith('.cap.ts') || !f.endsWith('.tsx'),
  )
  const violations = findViolations(readSources(files), loadBaseline(BASELINE_PATH))
  return report('check-collection-crud-is-instances', violations)
}

if (isMain(import.meta.url)) process.exit(main())

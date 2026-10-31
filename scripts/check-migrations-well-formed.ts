#!/usr/bin/env tsx
/**
 * The migration catalogue is well formed (D986).
 *
 * ## The failure this catches
 *
 * The engine orders migrations by `dependsOn` and, within an owner, by `seq`.
 * A duplicate id, a `seq` that goes backwards, a dependency on an id nobody
 * declared or a cycle would not fail where it is written — it would fail at the
 * next boot of a hub that holds data, after the pre-migration snapshot.
 *
 * ## What it checks
 *
 * Every entry of the hub catalogue (`packages/system/src/migrations/hub`) parses
 * as a `MigrationMeta`; ids are unique; `seq` increases per owner; every
 * `dependsOn` names a declared id; the dependency graph has no cycle. It uses
 * the same `MigrationCatalogueSchema` the engine's types ship, so the guard and
 * the engine cannot disagree. Add each new owner's catalogue to `CATALOGUES`.
 */
import path from 'node:path'
import { MigrationCatalogueSchema } from '../packages/types/src/migrations/migration.js'
import { HUB_MIGRATIONS } from '../packages/system/src/migrations/hub/index.js'

/** Every catalogue the repo ships, as plain metadata. */
const CATALOGUES: readonly { readonly name: string; readonly metas: readonly unknown[] }[] = [
  { name: 'hub', metas: HUB_MIGRATIONS.map((m) => m.meta) },
]

export function migrationCatalogueProblems(metas: readonly unknown[]): readonly string[] {
  const parsed = MigrationCatalogueSchema.safeParse(metas)
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(catalogue)'}: ${issue.message}`,
      )
}

function main(): number {
  const merged = CATALOGUES.flatMap((catalogue) => catalogue.metas)
  const problems = migrationCatalogueProblems(merged)
  if (problems.length === 0) {
    console.log(`check-migrations-well-formed: ${merged.length} migration(s), all well formed`)
    return 0
  }
  console.error('check-migrations-well-formed: the migration catalogue is malformed')
  for (const problem of problems) console.error(`  ${problem}`)
  return 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(main())
}

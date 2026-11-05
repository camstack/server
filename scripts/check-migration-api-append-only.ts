#!/usr/bin/env tsx
/**
 * GUARD: the migration API (`MigrationApiV1`) is append-only (planning#447).
 *
 * An old migration runs against the API of a newer server after a version-jump upgrade, so a
 * released method can never go away or change meaning. `scripts/migration-api-contract.json`
 * pins every method's input and output as a path table; this guard fails on
 *   - a method missing,
 *   - an input or output field removed,
 *   - an input field that turned required (or a new required one),
 *   - an enum that narrowed,
 *   - a behaviour id with no `it('<id>'` in `migration-api.contract.spec.ts`.
 *
 *   npx tsx scripts/check-migration-api-append-only.ts            # verify
 *   npx tsx scripts/check-migration-api-append-only.ts --update   # ADD new methods and fields
 *
 * `--update` runs the same comparison first and writes nothing while any problem stands, so it
 * can only ever add (the spec-coverage check is left to the verify run). A change that cannot be an addition is `migration-api.v2`.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  MIGRATION_API_V1_METHODS,
  MIGRATION_API_VERSION,
} from '../packages/types/src/migrations/api/migration-api.v1.schema.js'
import {
  contractCompatProblems,
  contractCoverageProblems,
  contractOf,
  type MigrationApiContract,
} from './lib/migration-api-contract.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CONTRACT_FILE = path.join(ROOT, 'scripts/migration-api-contract.json')
const SPEC_FILE = path.join(
  ROOT,
  'packages/system/src/kernel/moleculer/__tests__/migration-api.contract.spec.ts',
)

function readPinned(): MigrationApiContract | null {
  if (!fs.existsSync(CONTRACT_FILE)) return null
  // A JSON file this guard wrote itself.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- documented type boundary: the contract file is written by this script
  return JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8')) as MigrationApiContract
}

function main(): void {
  const current = contractOf(MIGRATION_API_VERSION, MIGRATION_API_V1_METHODS)
  const pinned = readPinned() ?? { version: current.version, methods: {} }
  const spec = fs.existsSync(SPEC_FILE) ? fs.readFileSync(SPEC_FILE, 'utf8') : ''
  const update = process.argv.includes('--update')
  const compat = contractCompatProblems(pinned, current)
  const problems = update ? compat : [...compat, ...contractCoverageProblems(current, spec)]
  if (problems.length > 0) {
    console.error('x the migration API contract is not append-only\n')
    for (const p of problems) console.error(`  - ${p}`)
    console.error(
      '\n  Never edit a released method. Add a field as optional, or add a method; a breaking\n' +
        '  change is migration-api.v2 beside v1 (docs/architecture/update-and-release.md).',
    )
    process.exit(1)
  }
  if (update) {
    fs.writeFileSync(CONTRACT_FILE, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`ok migration API contract updated: ${Object.keys(current.methods).length} methods`)
    return
  }
  if (readPinned() === null) {
    console.error('x scripts/migration-api-contract.json is missing: run with --update once')
    process.exit(1)
  }
  console.log(
    `ok migration API v${current.version}: ${Object.keys(current.methods).length} methods, append-only`,
  )
}

main()

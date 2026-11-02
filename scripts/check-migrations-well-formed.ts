#!/usr/bin/env tsx
/**
 * The migration catalogue is well formed (D987).
 *
 * ## The failure this catches
 *
 * The engine orders migrations by `dependsOn` and, within an owner, by `seq`.
 * A duplicate id, a `seq` that goes backwards, a dependency on an id nobody
 * declared or a cycle would not fail where it is written — it would fail at the
 * next boot of a hub that holds data, after the pre-migration snapshot. An addon
 * catalogue adds two more ways to fail late: a `bodyKind` that does not match the
 * body the entry carries (a `plan` declared as a `procedure` never runs as written),
 * and a catalogue nobody runs (the addon never calls `runMigrations`, so its rows stay
 * `pending` for ever).
 *
 * ## What it checks
 *
 * Every entry of the hub catalogue (`packages/system/src/migrations/hub`) and of every
 * addon catalogue (`packages/addon-<name>/src/migrations/index.ts`, export
 * `ADDON_MIGRATIONS`) parses as a `MigrationMeta`; ids are unique across ALL of them;
 * `seq` increases per owner; every `dependsOn` names a declared id; the dependency
 * graph has no cycle. Per entry: the body matches `bodyKind` (`sql` -> `run`, `plan` ->
 * `plan`, `procedure` -> `procedure`); the hub owns `sql` and `plan` only, an addon owns
 * `plan` and `procedure` only; an addon's owner is one of its manifest addon ids and its
 * level is not `hub-store`; and an addon with a catalogue calls `runMigrations(` in its
 * sources. It uses the same `MigrationCatalogueSchema` the engine's types ship, so the
 * guard and the engine cannot disagree.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { MigrationCatalogueSchema } from '../packages/types/src/migrations/migration.js'
import { HUB_MIGRATIONS } from '../packages/system/src/migrations/hub/index.js'

const ROOT = path.resolve(__dirname, '..')

/** One catalogue entry as the guard sees it: its meta (unparsed) and which bodies it carries. */
export interface CatalogueEntryShape {
  readonly meta: unknown
  readonly bodies: readonly ('run' | 'plan' | 'procedure')[]
}

export interface CatalogueShape {
  readonly name: string
  readonly kind: 'hub' | 'addon'
  /** An addon's manifest ids; empty for the hub. */
  readonly addonIds: readonly string[]
  readonly entries: readonly CatalogueEntryShape[]
  /** An addon: whether its sources call `runMigrations(`. */
  readonly runsItsCatalogue: boolean
}

export function migrationCatalogueProblems(metas: readonly unknown[]): readonly string[] {
  const parsed = MigrationCatalogueSchema.safeParse(metas)
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(catalogue)'}: ${issue.message}`,
      )
}

const BODY_OF_KIND = {
  sql: 'run',
  plan: 'plan',
  procedure: 'procedure',
} as const

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) return undefined
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}

/** What is wrong with one catalogue beyond what the schema says. */
export function migrationShapeProblems(catalogue: CatalogueShape): readonly string[] {
  const problems: string[] = []
  for (const { meta, bodies } of catalogue.entries) {
    const id = stringField(meta, 'id') ?? '(no id)'
    const kind = stringField(meta, 'bodyKind')
    const owner = stringField(meta, 'owner')
    const level = stringField(meta, 'level')
    if (kind !== 'sql' && kind !== 'plan' && kind !== 'procedure') continue
    const expected = BODY_OF_KIND[kind]
    if (bodies.length !== 1 || bodies[0] !== expected) {
      problems.push(
        `${id}: bodyKind "${kind}" needs exactly a "${expected}" body, found [${bodies.join(', ')}]`,
      )
    }
    if (catalogue.kind === 'hub') {
      if (owner !== 'hub')
        problems.push(`${id}: the hub catalogue holds owner "hub" only, found "${owner}"`)
      if (kind === 'procedure')
        problems.push(`${id}: a hub migration has no procedure body (sql or plan)`)
    } else {
      if (owner === undefined || !catalogue.addonIds.includes(owner)) {
        problems.push(
          `${id}: owner "${owner}" is not an addon id of ${catalogue.name} (${catalogue.addonIds.join(', ')})`,
        )
      }
      if (kind === 'sql')
        problems.push(`${id}: "sql" is a hub-only body, an addon uses plan or procedure`)
      if (level === 'hub-store') problems.push(`${id}: an addon migration is not level "hub-store"`)
    }
  }
  if (catalogue.kind === 'addon' && catalogue.entries.length > 0 && !catalogue.runsItsCatalogue) {
    problems.push(
      `${catalogue.name}: declares migrations but never calls runMigrations( — they would stay pending`,
    )
  }
  return problems
}

function bodiesOf(entry: object): readonly ('run' | 'plan' | 'procedure')[] {
  return (['run', 'plan', 'procedure'] as const).filter((body) => body in entry)
}

function hubShape(): CatalogueShape {
  return {
    name: 'hub',
    kind: 'hub',
    addonIds: [],
    entries: HUB_MIGRATIONS.map((m) => ({ meta: m.meta, bodies: bodiesOf(m) })),
    runsItsCatalogue: true,
  }
}

function sourcesCall(dir: string, needle: string): boolean {
  const walk = (current: string): boolean =>
    readdirSync(current, { withFileTypes: true }).some((entry) => {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist')
        return false
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) return walk(full)
      return (
        /\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts') &&
        readFileSync(full, 'utf8').includes(needle)
      )
    })
  return walk(dir)
}

function manifestIds(pkgDir: string): readonly string[] {
  const pkg: unknown = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  const camstack =
    typeof pkg === 'object' && pkg !== null ? Reflect.get(pkg, 'camstack') : undefined
  const addons: unknown =
    typeof camstack === 'object' && camstack !== null ? Reflect.get(camstack, 'addons') : undefined
  if (!Array.isArray(addons)) return []
  return addons.flatMap((addon: unknown) => {
    const id = stringField(addon, 'id')
    return id === undefined ? [] : [id]
  })
}

/**
 * Every `migrations/index.ts` under an addon package's `src`, at any depth: a bundle that holds
 * several addons (cloudflare: `src/turn/migrations`) keeps one catalogue per addon.
 */
export function catalogueEntryFiles(srcDir: string): readonly string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name === 'dist') {
        continue
      }
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'index.ts' && path.basename(current) === 'migrations') {
        found.push(full)
      }
    }
  }
  if (existsSync(srcDir)) walk(srcDir)
  return found
}

async function addonShapes(): Promise<readonly CatalogueShape[]> {
  const packages = path.join(ROOT, 'packages')
  const shapes: CatalogueShape[] = []
  for (const dir of readdirSync(packages).filter((name) => name.startsWith('addon-'))) {
    for (const entryFile of catalogueEntryFiles(path.join(packages, dir, 'src'))) {
      const loaded: unknown = await import(pathToFileURL(entryFile).href)
      const exported: unknown =
        typeof loaded === 'object' && loaded !== null
          ? Reflect.get(loaded, 'ADDON_MIGRATIONS')
          : undefined
      const list = Array.isArray(exported) ? exported : []
      const nested = path.relative(
        path.join(packages, dir, 'src'),
        path.dirname(path.dirname(entryFile)),
      )
      shapes.push({
        name: nested === '' ? dir : `${dir}/${nested}`,
        kind: 'addon',
        addonIds: manifestIds(path.join(packages, dir)),
        entries: list.flatMap((entry: unknown) =>
          typeof entry === 'object' && entry !== null
            ? [{ meta: Reflect.get(entry, 'meta'), bodies: bodiesOf(entry) }]
            : [],
        ),
        runsItsCatalogue: sourcesCall(path.join(packages, dir, 'src'), 'runMigrations('),
      })
    }
  }
  return shapes
}

async function main(): Promise<number> {
  const catalogues = [hubShape(), ...(await addonShapes())]
  const merged = catalogues.flatMap((catalogue) => catalogue.entries.map((entry) => entry.meta))
  const problems = [
    ...migrationCatalogueProblems(merged),
    ...catalogues.flatMap((catalogue) => migrationShapeProblems(catalogue)),
  ]
  if (problems.length === 0) {
    console.log(
      `check-migrations-well-formed: ${merged.length} migration(s) in ${catalogues.length} catalogue(s), all well formed`,
    )
    return 0
  }
  console.error('check-migrations-well-formed: the migration catalogue is malformed')
  for (const problem of problems) console.error(`  ${problem}`)
  return 1
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  void main().then((code) => process.exit(code))
}

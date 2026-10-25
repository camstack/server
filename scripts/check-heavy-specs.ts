#!/usr/bin/env tsx
/**
 * Heavy-spec guard — a `*.heavy.spec.*` file is out of every automatic lane and
 * IN the on-demand Checks workflow, never in neither.
 *
 * ## The failure this catches
 *
 * Specs that only time out under machine load kept turning `verify:push` and CI
 * red, so they were renamed `*.heavy.spec.*` and moved to Checks
 * (`npm run test:heavy`). Two ways that convention silently rots:
 *   1. the config that owns a heavy spec stops excluding `*.heavy.spec.*` — the
 *      spec is back in the per-push lane and the flake returns;
 *   2. `checks.yml` stops running `test:heavy` — the spec runs nowhere, and a
 *      test nobody runs reads as verification.
 *
 * ## What it checks
 *
 *   - every heavy spec's owning `vitest.config.*` (nearest ancestor) names
 *     `*.heavy.spec.*` in an exclusion;
 *   - `package.json` defines `test:heavy`, and `.github/workflows/checks.yml`
 *     runs it.
 *
 * Usage: npx tsx scripts/check-heavy-specs.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { findHeavySpecs, owningProject } from './run-heavy-specs.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const EXCLUSION = '**/*.heavy.spec.*'
const CONFIG_FILE = /^vitest\.config\.[cm]?[jt]s$/

export interface HeavyFacts {
  readonly projectConfigs: ReadonlyMap<string, string>
  readonly packageScripts: Readonly<Record<string, string>>
  readonly checksYaml: string
  readonly heavyCount: number
}

export function judge(facts: HeavyFacts): readonly string[] {
  const problems: string[] = []
  for (const [project, config] of facts.projectConfigs) {
    if (!config.includes(EXCLUSION)) {
      problems.push(
        `${project}: owns heavy specs but its vitest config does not exclude ${EXCLUSION}`,
      )
    }
  }
  if (facts.heavyCount > 0 && facts.packageScripts['test:heavy'] === undefined) {
    problems.push('package.json has no `test:heavy` script')
  }
  if (facts.heavyCount > 0 && !/npm run test:heavy\b/.test(facts.checksYaml)) {
    problems.push('.github/workflows/checks.yml does not run `npm run test:heavy`')
  }
  return problems
}

function configOf(project: string): string {
  const file = fs.readdirSync(project).find((f) => CONFIG_FILE.test(f))
  return file === undefined ? '' : fs.readFileSync(path.join(project, file), 'utf8')
}

function main(): number {
  const specs = findHeavySpecs()
  const projectConfigs = new Map<string, string>()
  for (const spec of specs) {
    const project = owningProject(spec)
    projectConfigs.set(path.relative(ROOT, project) || '.', configOf(project))
  }
  const pkg: { scripts?: Record<string, string> } = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
  )
  const problems = judge({
    projectConfigs,
    packageScripts: pkg.scripts ?? {},
    checksYaml: fs.readFileSync(path.join(ROOT, '.github/workflows/checks.yml'), 'utf8'),
    heavyCount: specs.length,
  })
  if (problems.length > 0) {
    console.error(`check-heavy-specs: ${problems.length} problem(s)`)
    for (const p of problems) console.error(`  - ${p}`)
    return 1
  }
  console.log(
    `check-heavy-specs: OK — ${specs.length} heavy spec(s) in ${projectConfigs.size} project(s)`,
  )
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())

#!/usr/bin/env tsx
/**
 * Spec-collection guard — a workspace package that has spec files declares a
 * `test` script that runs them.
 *
 * ## The failure this catches
 *
 * CI's test steps are `nx run-many -t test` and `nx affected -t test`, and nx
 * runs a `test` target only where a package DECLARES one. A package with specs
 * and no `test` script is not red, not skipped, not reported: it simply never
 * comes up. On 2026-10-01 four packages were in that state —
 * `addon-provider-reolink` (83 spec files, 963 tests), `addon-mqtt-broker`,
 * `addon-provider-onvif` and `sdk` — and every one of their specs read as
 * verification while nothing had run them in CI since they were written.
 *
 * ## What it checks, per workspace package (`package.json` `workspaces`)
 *
 *   1. specs on disk (`*.spec.*` / `*.test.*`, outside `node_modules`/`dist`)
 *      ⇒ a `scripts.test` exists;
 *   2. that script runs something — `echo …`, `true`, `exit 0` and `:` cannot
 *      fail, so they are the same gap with a script attached;
 *   3. no `--passWithNoTests` where specs exist: with specs on disk, "no test
 *      files found" means the runner's include stopped matching them, which is
 *      exactly the failure the flag would turn green.
 *
 * What it does NOT check: that a runner's `exclude` leaves every spec
 * collected. Several packages exclude fixture- or socket-bound suites on
 * purpose (`*-e2e.test.ts` in addon-pipeline and server/backend), each with
 * its reason beside the pattern.
 *
 * Usage: npx tsx scripts/check-specs-have-test-script.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const SPEC_FILE = /\.(spec|test)\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', '.git', 'coverage'])
/** A script body that exits 0 without running anything. */
const NOOP_SCRIPT = /^\s*(echo\b.*|true|exit\s+0|:)\s*$/

export interface PackageFacts {
  readonly name: string
  readonly specCount: number
  readonly testScript: string | undefined
}

export function judgePackage(facts: PackageFacts): readonly string[] {
  const { name, specCount, testScript } = facts
  if (specCount === 0) return []
  if (testScript === undefined) {
    return [
      `${name}: ${specCount} spec file(s) and no \`test\` script — nx never runs them, so CI never does`,
    ]
  }
  if (NOOP_SCRIPT.test(testScript)) {
    return [
      `${name}: ${specCount} spec file(s) and a \`test\` script that runs nothing (\`${testScript}\`)`,
    ]
  }
  if (testScript.includes('--passWithNoTests')) {
    return [
      `${name}: \`--passWithNoTests\` on a package with ${specCount} spec file(s) — a config that stops collecting them would still pass`,
    ]
  }
  return []
}

interface WorkspaceManifest {
  readonly workspaces?: unknown
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

function isManifest(value: unknown): value is WorkspaceManifest {
  return typeof value === 'object' && value !== null
}

/** Repo-relative directories matched by the root `workspaces` globs (`dir/*` or a literal dir). */
export function workspacePackageDirs(root: string): readonly string[] {
  const manifest = readJson(path.join(root, 'package.json'))
  const patterns =
    isManifest(manifest) && Array.isArray(manifest.workspaces) ? manifest.workspaces : []
  const out: string[] = []
  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue
    const candidates: string[] = []
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2)
      const abs = path.join(root, parent)
      if (!fs.existsSync(abs)) continue
      for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(`${parent}/${entry.name}`)
      }
    } else {
      candidates.push(pattern)
    }
    for (const dir of candidates) {
      if (fs.existsSync(path.join(root, dir, 'package.json'))) out.push(dir)
    }
  }
  return out
}

/** Spec files under a package directory, relative to it. */
export function findSpecFiles(packageDir: string): readonly string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name))
        continue
      }
      if (entry.isFile() && SPEC_FILE.test(entry.name)) {
        out.push(path.relative(packageDir, path.join(dir, entry.name)).split(path.sep).join('/'))
      }
    }
  }
  walk(packageDir)
  return out
}

interface PackageManifest {
  readonly name?: unknown
  readonly scripts?: unknown
}

function isPackageManifest(value: unknown): value is PackageManifest {
  return typeof value === 'object' && value !== null
}

function testScriptOf(manifest: PackageManifest): string | undefined {
  const scripts = manifest.scripts
  if (typeof scripts !== 'object' || scripts === null) return undefined
  const test = Reflect.get(scripts, 'test')
  return typeof test === 'string' ? test : undefined
}

function main(): void {
  const failures: string[] = []
  let withSpecs = 0
  const dirs = workspacePackageDirs(ROOT)
  for (const dir of dirs) {
    const manifest = readJson(path.join(ROOT, dir, 'package.json'))
    if (!isPackageManifest(manifest)) continue
    const specCount = findSpecFiles(path.join(ROOT, dir)).length
    if (specCount > 0) withSpecs++
    failures.push(
      ...judgePackage({
        name: typeof manifest.name === 'string' ? manifest.name : dir,
        specCount,
        testScript: testScriptOf(manifest),
      }),
    )
  }
  if (failures.length > 0) {
    console.error('✘ spec files CI never runs:')
    for (const f of failures) console.error(`    ${f}`)
    console.error(
      '  Add `"test": "vitest run"` (the runner every other package uses) and run it once:\n' +
        '  a spec nobody has run may be red.',
    )
    process.exit(1)
  }
  console.log(
    `✔ ${dirs.length} workspace packages, ${withSpecs} with specs, each with a \`test\` script that runs them`,
  )
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main()
}

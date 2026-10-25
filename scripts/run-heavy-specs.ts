#!/usr/bin/env tsx
/**
 * Runs ONLY the heavy specs (`*.heavy.spec.*`) of the repository — `npm run
 * test:heavy`, the Checks workflow's `heavy` job.
 *
 * A heavy spec is timing-bound under machine load and passes alone; the default
 * test configs exclude it (see docs/architecture/testing.md). Each spec runs
 * through the config of the project that owns it, so module resolution is the
 * one the default lane uses: the project is the nearest ancestor directory with
 * a `vitest.config.*`, `CAMSTACK_HEAVY_SPECS=1` lifts that config's exclusion,
 * and the spec paths narrow the run to the heavy files.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const HEAVY_SPEC = /\.heavy\.spec\.[cm]?[jt]sx?$/
const CONFIG_FILE = /^vitest\.config\.[cm]?[jt]s$/
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  '.git',
  '.claude',
  '.worktrees',
  'coverage',
  'camstack',
])

export function findHeavySpecs(dir: string = ROOT): readonly string[] {
  const found: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('camstack-agent-')) continue
      found.push(...findHeavySpecs(path.join(dir, entry.name)))
    } else if (HEAVY_SPEC.test(entry.name)) {
      found.push(path.join(dir, entry.name))
    }
  }
  return found
}

/** The nearest ancestor directory holding a `vitest.config.*` — the owning project. */
export function owningProject(spec: string): string {
  let dir = path.dirname(spec)
  while (dir.startsWith(ROOT)) {
    if (fs.readdirSync(dir).some((f) => CONFIG_FILE.test(f))) return dir
    dir = path.dirname(dir)
  }
  return ROOT
}

function main(): number {
  const specs = findHeavySpecs()
  if (specs.length === 0) {
    console.error('test:heavy: no *.heavy.spec.* file found — refusing to pass vacuously')
    return 1
  }
  const byProject = new Map<string, readonly string[]>()
  for (const spec of specs) {
    const project = owningProject(spec)
    byProject.set(project, [...(byProject.get(project) ?? []), spec])
  }
  const failed: string[] = []
  for (const [project, files] of byProject) {
    const rel = files.map((f) => path.relative(project, f))
    const label = path.relative(ROOT, project) || '.'
    console.log(`\n── test:heavy ${label} (${rel.length} spec file(s))`)
    const result = spawnSync('npx', ['vitest', 'run', ...rel], {
      cwd: project,
      stdio: 'inherit',
      env: { ...process.env, CAMSTACK_HEAVY_SPECS: '1' },
    })
    if (result.status !== 0) failed.push(label)
  }
  if (failed.length > 0) {
    console.error(`\ntest:heavy FAILED in: ${failed.join(', ')}`)
    return 1
  }
  console.log(
    `\ntest:heavy GREEN — ${specs.length} heavy spec file(s) in ${byProject.size} project(s)`,
  )
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main())

/**
 * The undeclared prerequisite of the AppRouter expansion.
 *
 * `generate-api-types.ts` expands the hand-written core routers through the
 * SERVER tsconfig, and that tsconfig resolves `@camstack/types` and
 * `@camstack/system` the way Node does — through each package's
 * `dist/index.d.ts`, never through its sources. So the expansion silently
 * depends on those two packages having been BUILT:
 *
 *  - dist missing (fresh clone, fresh worktree): the checker resolves the
 *    import to an error type and every signature flowing through it collapses
 *    to `any`. The degradation guard correctly refuses to write — but its
 *    message ("output: any → 6") names a symptom, not a cause, and a session
 *    reads it as a type regression in the routers. On 2026-08-15 that cost
 *    a full investigation: `capabilities.listCapabilities`,
 *    `capabilities.getCapability` and `auth.listOwnPasskeys` were the six,
 *    and every one of them was a missing `dist`.
 *  - dist stale (sources edited since the last build): worse — the expansion
 *    succeeds and writes a confidently WRONG `addon-api.ts`. This repo has
 *    been bitten by a stale `types/dist` twice (see the CI comments around
 *    the build step).
 *
 * Both are the same question — "is the dist usable?" — so both are answered
 * here, once, and the answer is actionable: `scripts/codegen.ts` rebuilds
 * what it names, and `generate-api-types.ts` refuses with the command to run.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface FrameworkPackage {
  /** Workspace-relative directory, e.g. `packages/types`. */
  readonly dir: string
  /** Package name, e.g. `@camstack/types`. */
  readonly name: string
}

export type FrameworkDistReason = 'missing' | 'stale'

export interface FrameworkDistProblem {
  readonly dir: string
  readonly name: string
  readonly reason: FrameworkDistReason
  /** Human-readable justification — the offending source path, when known. */
  readonly detail: string
}

/**
 * The packages the core-router expansion resolves through. Verified by
 * deletion: removing either one reproduces the degradation guard exactly
 * (`types` → `auth.listOwnPasskeys` + `capabilities.getCapability`,
 * `system` → `capabilities.listCapabilities` + `capabilities.getCapability`),
 * while removing `node-root` or `addon-pipeline` changes nothing.
 */
export const CORE_ROUTER_FRAMEWORK_PACKAGES: readonly FrameworkPackage[] = [
  { dir: 'packages/types', name: '@camstack/types' },
  { dir: 'packages/system', name: '@camstack/system' },
]

/**
 * Sources that are OUTPUTS of codegen rather than inputs to the expansion.
 * `addon-api.ts` is written by the very step that reads the dist — counting
 * it as an input marks the dist stale the instant it is generated, which is
 * a rebuild loop that never converges.
 */
const NOT_AN_INPUT: readonly string[] = ['src/generated/addon-api.ts']

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.json']

interface NewestSource {
  readonly ms: number
  readonly at: string
}

function newestSourceMtime(srcDir: string, excluded: ReadonlySet<string>): NewestSource {
  let newest: NewestSource = { ms: 0, at: srcDir }
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue
        walk(full)
        continue
      }
      if (!SOURCE_EXTENSIONS.includes(path.extname(entry.name))) continue
      if (excluded.has(full)) continue
      const mtime = fs.statSync(full).mtimeMs
      if (mtime > newest.ms) newest = { ms: mtime, at: full }
    }
  }
  walk(srcDir)
  return newest
}

/**
 * Return every framework package whose `dist` cannot be trusted by the
 * core-router expansion — never built, or older than its own sources.
 * An empty array means the expansion is safe to run.
 */
export function findUnusableFrameworkDists(
  root: string,
  packages: readonly FrameworkPackage[] = CORE_ROUTER_FRAMEWORK_PACKAGES,
): readonly FrameworkDistProblem[] {
  const problems: FrameworkDistProblem[] = []
  for (const pkg of packages) {
    const pkgDir = path.join(root, pkg.dir)
    const declaration = path.join(pkgDir, 'dist/index.d.ts')
    if (!fs.existsSync(declaration)) {
      problems.push({
        dir: pkg.dir,
        name: pkg.name,
        reason: 'missing',
        detail: `${pkg.dir}/dist/index.d.ts does not exist`,
      })
      continue
    }
    const excluded = new Set(NOT_AN_INPUT.map((rel) => path.join(pkgDir, rel)))
    const newest = newestSourceMtime(path.join(pkgDir, 'src'), excluded)
    if (newest.ms > fs.statSync(declaration).mtimeMs) {
      problems.push({
        dir: pkg.dir,
        name: pkg.name,
        reason: 'stale',
        detail: `${path.relative(root, newest.at)} is newer than ${pkg.dir}/dist/index.d.ts`,
      })
    }
  }
  return problems
}

/** The one-line remedy printed by every caller that refuses to continue. */
export function rebuildCommandFor(problems: readonly FrameworkDistProblem[]): string {
  return problems.map((p) => `npm run build -w ${p.dir}`).join(' && ')
}

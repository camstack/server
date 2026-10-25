#!/usr/bin/env tsx
/**
 * A published package declares as a runtime `dependency` only what its
 * shipped artefact `require`s or `import`s at run time (D479, extending
 * D477). A UI whose `files` is a bundled `dist` — the bundler, framework,
 * icon set, editor, or player it built with — belongs in `devDependencies`;
 * a library that inlines a vendor chunk does not also depend on that vendor.
 *
 * ## The failure this catches
 *
 * `addon-admin-ui` and `ui-library` had ~240 MB / ~11 000 files of
 * `monaco-editor`, two divergent copies of `lucide-react`, `hls.js`,
 * `@xyflow/react`, `konva`, `@xterm/*` and more sitting in `dependencies` —
 * every one of them already bundled into the package's own `dist` (verified
 * by grepping the SHIPPED output, not the source: zero bare
 * `require("lucide-react")` anywhere). `@camstack/server` depends on every
 * addon package unconditionally, so an AGENT node that will never render a
 * UI installed the whole admin toolchain on every closure update — the
 * dominant cost of a healthy `npm install` on `agent-a` (measured:
 * `reifyNode` top three timers were the two `lucide-react` copies and
 * `monaco-editor`, against a 41.6 s `reify:unpack`). Nothing caught this
 * because no guard ever asked "does the artefact this package SHIPS still
 * need what its manifest claims" — this script is that question, run
 * against `dist/`, not against the author's intent.
 *
 * ## What it checks
 *
 * For every `packages/*` workspace package that is not `private` and whose
 * `files` includes a built `dist` (exactly `"dist"` or a `"dist/…"` entry):
 * for each name in `dependencies` (NOT `peerDependencies` — a peer is the
 * consumer's contract, a different question this script does not ask), scan
 * every `.js` / `.cjs` / `.mjs` file under `dist/` for a literal bare
 * reference to that package — `require("name")`, `from "name"`,
 * `import("name")`, or the same with a `name/<subpath>` deep import. If
 * nothing in the built output references it, the entry is a build-time
 * input mis-declared as a runtime one: either move it to `devDependencies`,
 * or — if this scan is wrong about a specific case (a dynamic `require`
 * built from a computed string, say) — add a justified exemption to
 * `scripts/runtime-deps-baseline.json`, the same ratchet
 * `check-closure-shipped-deps.ts` already uses for a sibling problem: an
 * entry added there is reviewed, and an entry no longer needed fails the
 * ratchet so it cannot rot silently.
 *
 * ## Honest limits
 *
 * This is a literal string scan, not a bundler-accurate resolver — a
 * dependency referenced only through a fully dynamic specifier
 * (`require(name)` where `name` is a runtime variable, never a literal)
 * will not be found even though it IS needed, and would show up here as a
 * false violation. None of the packages this script currently covers do
 * that (verified by hand for every dependency this repo moved under D479);
 * a future one that legitimately does belongs in the baseline file with a
 * comment, not a code change to this script. A package whose `dist/` was
 * never built (not part of this run's build graph) is skipped with a
 * printed note, not failed — this script runs after `npm run build` in CI,
 * where every candidate SHOULD have a fresh `dist`, but does not assume it.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = path.join(ROOT, 'scripts', 'runtime-deps-baseline.json')
const PACKAGES_DIR = path.join(ROOT, 'packages')
const DIST_EXTENSIONS = new Set(['.js', '.cjs', '.mjs'])

interface Baseline {
  readonly _comment?: string
  readonly exemptions: Readonly<Record<string, readonly string[]>>
}

interface Candidate {
  readonly pkgName: string
  readonly dir: string
  readonly distDir: string
  readonly dependencies: Readonly<Record<string, string>>
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasBuiltDistInFiles(files: unknown): boolean {
  if (!Array.isArray(files)) return false
  return files.some((f) => typeof f === 'string' && (f === 'dist' || f.startsWith('dist/')))
}

function discoverCandidates(): Candidate[] {
  const out: Candidate[] = []
  for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(PACKAGES_DIR, entry.name)
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) continue
    const raw = asRecord(readJson(pkgPath))
    if (raw === null || typeof raw['name'] !== 'string') continue
    if (raw['private'] === true) continue
    if (!hasBuiltDistInFiles(raw['files'])) continue
    const deps = asRecord(raw['dependencies'])
    if (deps === null) continue
    const dependencies: Record<string, string> = {}
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range === 'string') dependencies[name] = range
    }
    if (Object.keys(dependencies).length === 0) continue
    out.push({ pkgName: raw['name'], dir, distDir: path.join(dir, 'dist'), dependencies })
  }
  return out
}

function walkDistFiles(distDir: string): string[] {
  const out: string[] = []
  const stack = [distDir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (DIST_EXTENSIONS.has(path.extname(entry.name))) {
        out.push(full)
      }
    }
  }
  return out
}

/** Escape a package name for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Bare `require("name")` / `from "name"` / `import("name")`, or the same
 *  with a `name/<subpath>` deep import — either quote style. */
function buildReferencePattern(name: string): RegExp {
  const escaped = escapeRegExp(name)
  return new RegExp(`(?:require|from|import)\\s*\\(?\\s*['"]${escaped}(?:['"]|/)`)
}

function main(): void {
  const baseline = fs.existsSync(BASELINE_PATH)
    ? (readJson(BASELINE_PATH) as Baseline)
    : { exemptions: {} }

  const candidates = discoverCandidates()
  const violations: string[] = []
  const baselineUsed = new Map<string, Set<string>>()
  let skippedNoDist = 0
  let checkedPackages = 0
  let checkedDeps = 0

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.distDir)) {
      console.log(`  skip: ${candidate.pkgName} — no dist/ (not built this run)`)
      skippedNoDist++
      continue
    }
    checkedPackages++
    const files = walkDistFiles(candidate.distDir)
    const contents = files.map((f) => fs.readFileSync(f, 'utf-8'))
    const exempt = new Set(baseline.exemptions[candidate.pkgName] ?? [])

    for (const dep of Object.keys(candidate.dependencies)) {
      checkedDeps++
      const pattern = buildReferencePattern(dep)
      const found = contents.some((c) => pattern.test(c))
      if (found) continue

      if (exempt.has(dep)) {
        let used = baselineUsed.get(candidate.pkgName)
        if (used === undefined) baselineUsed.set(candidate.pkgName, (used = new Set()))
        used.add(dep)
        console.log(
          `  baseline: ${candidate.pkgName} — "${dep}" in dependencies, not referenced in dist/ (exempted, see scripts/runtime-deps-baseline.json)`,
        )
        continue
      }

      violations.push(
        `${candidate.pkgName} — "${dep}" is in dependencies but no file under dist/ ` +
          `requires or imports it. This is a build-time input mis-declared as a ` +
          `runtime one: move it to devDependencies, or add a justified exemption ` +
          `to scripts/runtime-deps-baseline.json if this scan is wrong here.`,
      )
    }
  }

  // Baseline ratchet: an exemption nothing needed anymore must be removed.
  for (const [pkgName, deps] of Object.entries(baseline.exemptions)) {
    const used = baselineUsed.get(pkgName) ?? new Set<string>()
    for (const dep of deps) {
      if (!used.has(dep)) {
        violations.push(
          `scripts/runtime-deps-baseline.json — stale exemption ${pkgName} → "${dep}": ` +
            `either the package no longer declares it, dist/ now references it, or the ` +
            `package was not built this run. Remove it so the ratchet holds.`,
        )
      }
    }
  }

  console.log(
    `check-runtime-deps-reachable-from-dist: ${checkedPackages} package(s) checked ` +
      `(${skippedNoDist} skipped, no dist/), ${checkedDeps} dependenc(ies) considered`,
  )
  if (violations.length > 0) {
    console.error('\ncheck-runtime-deps-reachable-from-dist FAILED:\n')
    for (const v of violations) console.error(`  ✗ ${v}\n`)
    process.exit(1)
  }
  console.log('check-runtime-deps-reachable-from-dist: OK')
}

main()

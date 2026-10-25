#!/usr/bin/env tsx
/**
 * Pinned-debt guard — lets CI enforce a check the repository does not yet pass.
 *
 * Four checks fail today on code nobody is being asked to fix in this change:
 * `typecheck` (8 packages), `oxlint` (3 errors), `format` (38 files) and
 * `double-cast` (197 sites). The two ways that usually go are both bad: turn
 * the check off, and a NEW error is invisible for months; turn it on, and CI is
 * red from the first commit and everyone learns to ignore it.
 *
 * So: pin what is broken TODAY, per bucket, in `scripts/ci-baseline.json`, and
 * fail only when a bucket gets WORSE. A new tsc error in a package that had
 * three now fails the build. The three do not.
 *
 * It is a RATCHET, not an amnesty. When a bucket improves the guard says so and
 * tells you to re-pin — so the number can only go down. `--update` rewrites the
 * baseline from the current tree; the diff it produces is the evidence that the
 * change was intentional.
 *
 * Buckets are chosen so a moving line number never invalidates a pin:
 *
 *   typecheck        nx project name            → error count (non-test files)
 *   typecheck-specs  `<project> » <spec file>`  → error count (test files)
 *   oxlint       `<file> » <rule>`      → occurrence count
 *   format       file path              → 1
 *   double-cast  file path              → occurrence count
 *
 * Usage:
 *   tsx scripts/check-ci-baselines.ts                 — every check
 *   tsx scripts/check-ci-baselines.ts typecheck       — one check
 *   tsx scripts/check-ci-baselines.ts --engine=tsc    — typecheck buckets via tsc 6, the reference
 *                                                       (default: tsgo / TypeScript 7, D832)
 *   tsx scripts/check-ci-baselines.ts --update        — re-pin DOWNWARD with the selected engine
 *                                                       (default tsgo; review the diff)
 *   … --update --allow-increase <check>               — also accept a raise in <check>
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { planBaselineUpdate } from './lib/baseline-update.ts'
import {
  isTsgoVersionOutput,
  listTypecheckProjects,
  resolveTsgoBinary,
  toTsgoCommand,
} from './lib/tsgo-typecheck.ts'
import { splitTypecheckSection } from './lib/typecheck-split.ts'

type TypecheckEngine = 'tsc' | 'tsgo'

/** Set in `main` before any typecheck bucket runs. Default is tsgo since the P4 flip (D832). */
let typecheckEngine: TypecheckEngine = 'tsgo'

const ROOT = path.resolve(import.meta.dirname, '..')
const BASELINE_FILE = path.join(ROOT, 'scripts', 'ci-baseline.json')

type BucketCounts = ReadonlyMap<string, number>
type CheckName = 'typecheck' | 'typecheck-specs' | 'oxlint' | 'format' | 'double-cast'
type Baseline = Readonly<Record<string, Readonly<Record<string, number>>>>

interface CheckDefinition {
  readonly name: CheckName
  /** What a bucket key identifies, for the failure message. */
  readonly unit: string
  readonly run: () => BucketCounts
}

// ── Shell ──────────────────────────────────────────────────────────────────

interface CommandOutput {
  readonly stdout: string
  readonly stderr: string
  readonly status: number
}

function run(command: string, args: readonly string[]): CommandOutput {
  const result = spawnSync(command, [...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    // 4 GB heap, one typecheck task at a time (see `runTypecheck`): the largest
    // single program (admin-ui specs) needs ~3.4 GB of heap on sources, so 4096
    // is enough and bounds what 8192 left open.
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096', FORCE_COLOR: '0' },
  })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? 1,
  }
}

/**
 * Same, but with stderr folded into stdout IN ORDER.
 *
 * nx writes its `> nx run <project>:target` banners to one stream and the task's
 * own output to the other; reading them separately and concatenating shuffles
 * every diagnostic away from the banner it belongs under, which silently
 * attributes errors to the wrong package. Only the shell can interleave them
 * faithfully.
 */
function runMerged(commandLine: string): CommandOutput {
  return run('bash', ['-c', `${commandLine} 2>&1`])
}

/** tsc and nx colour their output even with FORCE_COLOR=0 on some terminals. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- the ESC byte IS the subject: ANSI colour sequences.
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '')
}

function tally(keys: readonly string[]): BucketCounts {
  const out = new Map<string, number>()
  for (const key of keys) out.set(key, (out.get(key) ?? 0) + 1)
  return out
}

// ── typecheck ──────────────────────────────────────────────────────────────

/**
 * `nx run-many -t typecheck` with per-project attribution.
 *
 * nx prints one `> nx run <project>:typecheck` banner per task and buffers that
 * task's whole output beneath it, so the sections are unambiguous.
 *
 * Inside a section, WHICH form tsc used depends on the terminal: interactively
 * it prints `Found N errors` after a pretty, multi-line, indented rendering;
 * under `FORCE_COLOR=0` (what `run()` sets, and what CI gets) it prints one flat
 * `file(line,col): error TSxxxx:` per diagnostic and NO summary at all. Read
 * both — assuming only the summary is how this parser first reported eight
 * broken packages as clean.
 *
 * A package with specs typechecks them in the SAME pass (`typecheck` runs
 * `tsc -p tsconfig.spec.json`), and the diagnostics are split by file into the
 * `typecheck` and `typecheck-specs` buckets — see `lib/typecheck-split.ts`.
 */
interface TypecheckBuckets {
  readonly production: BucketCounts
  readonly specs: BucketCounts
}

let typecheckMemo: TypecheckBuckets | null = null

/** Both buckets come from one nx run; the second check reads the first's result. */
function typecheckBuckets(): TypecheckBuckets {
  typecheckMemo ??= typecheckEngine === 'tsgo' ? runTypecheckViaTsgo() : runTypecheck()
  return typecheckMemo
}

/**
 * Typecheck buckets via tsgo (`--engine=tsgo`): same project set and diagnostic
 * split as the tsc path, but each project's `typecheck` script runs with `tsc`
 * swapped for `tsgo --checkers 1`. Sequential — peak is the largest program.
 */
function runTypecheckViaTsgo(): TypecheckBuckets {
  const bin = resolveTsgoBinary(ROOT)
  if (bin === null) {
    throw new Error(
      'tsgo not found — install typescript-7 (npm:typescript@7) or @typescript/native-preview',
    )
  }
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  const versionText = `${version.stdout ?? ''}${version.stderr ?? ''}`
  if (!isTsgoVersionOutput(versionText)) {
    throw new Error(
      `expected a TypeScript 7 binary at ${bin}, got: ${versionText.trim() || `(exit ${version.status})`}`,
    )
  }
  const checkers = process.env.TSGO_CHECKERS ?? '1'
  const prefix = `${bin} --checkers ${checkers}`
  const counts = new Map<string, number>()
  const specCounts = new Map<string, number>()
  for (const project of listTypecheckProjects(ROOT)) {
    const command = toTsgoCommand(project.script, prefix)
    if (command === null) continue
    const result = spawnSync('bash', ['-c', command], {
      cwd: project.dir,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    const output = stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`)
    const split = splitTypecheckSection(output)
    if (split === null) {
      if (result.status !== 0) {
        throw new Error(
          `typecheck failed for ${project.name} (tsgo) but produced no readable diagnostic`,
        )
      }
      continue
    }
    if (split.production > 0) counts.set(project.name, split.production)
    for (const [file, n] of split.specs) specCounts.set(`${project.name} » ${file}`, n)
  }
  return { production: counts, specs: specCounts }
}

function runTypecheck(): TypecheckBuckets {
  // `--exclude camstack`: the viewer is a git SUBMODULE with its own repo and
  // its own CI, and `actions/checkout` here does not fetch submodules. So the
  // project exists locally and does not exist on the runner — pin it and CI
  // reports a phantom improvement on every single run; do not pin it and a
  // local `--update` deletes the entry a local check then re-reports. A
  // baseline that means something different depending on where it ran is not a
  // ratchet. Excluding it makes local and CI agree. (`biome.json` ignores
  // `camstack/**` for the format bucket, for the same reason; oxlint and
  // double-cast only ever walk `packages/` and `server/backend/src`.)
  //
  // `--parallel=1`: nx's default is 3 concurrent tasks, each allowed the whole
  // heap — 8.9 GB worst case on the runner that also hosts a live agent. One
  // task at a time bounds the peak to the single largest program (~3.9 GB), at
  // the price of a serial sweep (docs/design/2026-10-09-ts7-transition-plan.md §P0).
  const result = runMerged(
    'npx nx run-many -t typecheck --parallel=1 --exclude camstack --output-style=static',
  )
  // GitHub runners wrap every task header in workflow log groups
  // (`::group::❌ > nx run …`), which hid EVERY diagnostic from the section
  // parser below — three runs read as "the task did not reach tsc" while tsc
  // had printed the error plainly. Strip the wrapper before splitting.
  const text = stripAnsi(result.stdout).replace(
    /^::(?:group|endgroup)::[^\n]*?(?=> nx run |$)/gm,
    '',
  )
  const counts = new Map<string, number>()
  const specCounts = new Map<string, number>()

  const sections = text.split(/^> nx run (\S+):typecheck$/m)
  // split() with one capture group yields [preamble, project, body, project, body, …]
  for (let i = 1; i + 1 < sections.length; i += 2) {
    const project = sections[i]
    const split = splitTypecheckSection(sections[i + 1])
    if (split === null) continue
    if (split.production > 0) counts.set(project, split.production)
    for (const [file, n] of split.specs) specCounts.set(`${project} » ${file}`, n)
  }

  // A task can fail without producing a single readable diagnostic (tsc
  // crashed, a dependency's build died, the runner ran out of memory). Never
  // let that read as "clean" — a check nobody can interpret is worse than no
  // check, and this baseline exists precisely to stop that.
  const failedAt = text.lastIndexOf('Failed tasks:')
  if (failedAt >= 0) {
    for (const line of text.slice(failedAt).split('\n')) {
      const task = /^-\s+(\S+):typecheck\s*$/.exec(line.trim())
      if (
        task &&
        !counts.has(task[1]) &&
        ![...specCounts.keys()].some((k) => k.startsWith(`${task[1]} » `))
      ) {
        const dump = path.join(ROOT, 'typecheck-unparsed.log')
        fs.writeFileSync(dump, text)
        throw new Error(
          `typecheck failed for ${task[1]} but produced no readable tsc diagnostic — ` +
            `the task did not reach tsc. Full output written to ${path.relative(ROOT, dump)}.`,
        )
      }
    }
  }

  if (result.status !== 0 && counts.size === 0 && specCounts.size === 0) {
    throw new Error(
      `nx typecheck exited ${result.status} with no parseable errors:\n${text.slice(-2000)}`,
    )
  }
  return { production: counts, specs: specCounts }
}

// ── oxlint ─────────────────────────────────────────────────────────────────

interface OxlintDiagnostic {
  readonly severity: string
  readonly code: string
  readonly filename: string
}

interface OxlintReport {
  readonly diagnostics: readonly OxlintDiagnostic[]
}

function isOxlintReport(value: unknown): value is OxlintReport {
  if (typeof value !== 'object' || value === null) return false
  const diagnostics = Reflect.get(value, 'diagnostics')
  return Array.isArray(diagnostics)
}

/**
 * Errors only. oxlint's warnings are advisory here and number in the hundreds.
 *
 * The `packages/<star>/src` in `npm run lint` is a SHELL glob, and oxlint handed
 * the literal pattern walks a different (much smaller) file set — 7 diagnostics
 * instead of 200+. Expand it here so this guard and `npm run lint` can never
 * disagree about what was linted.
 */
function oxlintTargets(): readonly string[] {
  const packagesDir = path.join(ROOT, 'packages')
  const targets = fs
    .readdirSync(packagesDir)
    .map((pkg) => path.join('packages', pkg, 'src'))
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)))
  return [...targets, 'server/backend/src']
}

function runOxlint(): BucketCounts {
  const result = run('npx', ['oxlint', ...oxlintTargets(), '--format=json'])
  const parsed: unknown = JSON.parse(result.stdout)
  if (!isOxlintReport(parsed)) throw new Error('oxlint --format=json produced no diagnostics array')
  return tally(
    parsed.diagnostics
      .filter((d) => d.severity === 'error')
      .map((d) => `${d.filename} » ${d.code}`),
  )
}

// ── format ─────────────────────────────────────────────────────────────────

interface BiomeDiagnostic {
  readonly severity: string
  readonly location?: { readonly path?: unknown }
}

interface BiomeReport {
  readonly diagnostics: readonly BiomeDiagnostic[]
}

function isBiomeReport(value: unknown): value is BiomeReport {
  if (typeof value !== 'object' || value === null) return false
  return Array.isArray(Reflect.get(value, 'diagnostics'))
}

function diagnosticPath(diagnostic: BiomeDiagnostic): string | null {
  const raw = diagnostic.location?.path
  if (typeof raw === 'string') return raw
  // Biome sometimes nests the path as { file: "…" }.
  if (typeof raw === 'object' && raw !== null) {
    const file = Reflect.get(raw, 'file')
    if (typeof file === 'string') return file
  }
  return null
}

function runFormat(): BucketCounts {
  const result = run('npx', ['biome', 'format', '.', '--reporter=json', '--max-diagnostics=5000'])
  const parsed: unknown = JSON.parse(result.stdout)
  if (!isBiomeReport(parsed))
    throw new Error('biome format --reporter=json produced no diagnostics array')
  const files: string[] = []
  for (const diagnostic of parsed.diagnostics) {
    if (diagnostic.severity !== 'error') continue
    const file = diagnosticPath(diagnostic)
    if (file !== null) files.push(file)
  }
  return tally(files)
}

// ── double-cast ────────────────────────────────────────────────────────────

/**
 * `scripts/lint-double-cast.sh` in bucketed form. The shell script is the
 * human-facing report (it prints every site); this reads the same grep so the
 * two can never disagree about what counts as a violation.
 */
function runDoubleCast(): BucketCounts {
  const result = run('bash', ['scripts/lint-double-cast.sh'])
  const files: string[] = []
  for (const line of stripAnsi(result.stdout).split('\n')) {
    const match = /^((?:packages|server)\/[^:]+):\d+:/.exec(line)
    if (match) files.push(match[1])
  }
  if (result.status !== 0 && files.length === 0) {
    throw new Error(`lint-double-cast.sh exited ${result.status} but printed no violations`)
  }
  return tally(files)
}

// ── Baseline ───────────────────────────────────────────────────────────────

const CHECKS: readonly CheckDefinition[] = [
  { name: 'typecheck', unit: 'package', run: () => typecheckBuckets().production },
  { name: 'typecheck-specs', unit: 'spec file', run: () => typecheckBuckets().specs },
  { name: 'oxlint', unit: 'file/rule', run: runOxlint },
  { name: 'format', unit: 'file', run: runFormat },
  { name: 'double-cast', unit: 'file', run: runDoubleCast },
]

function readBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_FILE)) return {}
  const parsed: unknown = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'))
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: Record<string, Record<string, number>> = {}
  for (const [check, buckets] of Object.entries(parsed)) {
    if (check.startsWith('//')) continue
    if (typeof buckets !== 'object' || buckets === null) continue
    const entries: Record<string, number> = {}
    for (const [bucket, count] of Object.entries(buckets)) {
      if (typeof count === 'number') entries[bucket] = count
    }
    out[check] = entries
  }
  return out
}

function toObject(counts: BucketCounts): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of [...counts.keys()].toSorted()) out[key] = counts.get(key) ?? 0
  return out
}

interface Delta {
  readonly bucket: string
  readonly pinned: number
  readonly actual: number
}

function compare(
  actual: BucketCounts,
  pinned: Readonly<Record<string, number>>,
): {
  readonly regressions: readonly Delta[]
  readonly improvements: readonly Delta[]
} {
  const regressions: Delta[] = []
  const improvements: Delta[] = []
  const buckets = new Set<string>([...actual.keys(), ...Object.keys(pinned)])
  for (const bucket of [...buckets].toSorted()) {
    const now = actual.get(bucket) ?? 0
    const then = pinned[bucket] ?? 0
    if (now > then) regressions.push({ bucket, pinned: then, actual: now })
    else if (now < then) improvements.push({ bucket, pinned: then, actual: now })
  }
  return { regressions, improvements }
}

const HEADER = {
  '//': [
    'Pre-existing violations pinned per bucket. Enforced by scripts/check-ci-baselines.ts.',
    'A bucket may only shrink: exceeding a pinned count FAILS CI, dropping below it',
    'asks you to re-pin. Regenerate with `tsx scripts/check-ci-baselines.ts --update`',
    'and commit the diff — never edit a number upward by hand.',
  ],
}

// ── preflight: is this checkout even installed? ────────────────────────────

/**
 * A declared dependency that does not resolve from the package that declares it.
 *
 * ## Why this runs BEFORE any bucket
 *
 * On 2026-08-27 this script reported `typecheck: 5 package(s) got worse` —
 * `@camstack/system` (27 errors), `addon-provider-ecowitt` (17),
 * `addon-pipeline-orchestrator` (6), `addon-smtp-nodemailer` (2), `addon-auth`
 * (1). None of them were regressions. **Four different agents each spent time
 * proving the errors were not theirs**, because a ratchet that says "you made
 * this worse" is believed.
 *
 * The cause was never in the code. npm nests a workspace dependency whenever it
 * cannot hoist it, and in this repo that is permanent, not incidental: the root
 * declares `vitest@^4` while ~40 packages declare `^3`, so those packages
 * legitimately own a `packages/<name>/node_modules/`. `otplib`, `jose` and
 * `@types/nodemailer` live there too. Any checkout that reproduces only the
 * ROOT `node_modules` — which is what a git worktree with a symlinked
 * `node_modules` gets — is missing them, and `tsc` then reports every use as an
 * error in the package that declares the dependency.
 *
 * So the ratchet refuses to grade a checkout it can see is incomplete. A false
 * regression is worse than no answer: it sends someone to fix code that is fine.
 */
interface UnresolvedDep {
  readonly workspace: string
  readonly dep: string
}

/** The node resolution walk, for a package DIRECTORY rather than an entry point. */
function resolvesFrom(startDir: string, dep: string): boolean {
  let dir = startDir
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', dep, 'package.json'))) return true
    const up = path.dirname(dir)
    if (up === dir) return false
    dir = up
  }
}

interface WorkspaceManifest {
  readonly name?: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly devDependencies?: Readonly<Record<string, string>>
}

function unresolvedWorkspaceDeps(): readonly UnresolvedDep[] {
  const out: UnresolvedDep[] = []
  for (const group of ['packages', 'server'] as const) {
    const dir = path.join(ROOT, group)
    if (!fs.existsSync(dir)) continue
    for (const pkg of fs.readdirSync(dir)) {
      const dirPath = path.join(dir, pkg)
      const file = path.join(dirPath, 'package.json')
      if (!fs.existsSync(file)) continue
      const manifest: WorkspaceManifest = JSON.parse(
        fs.readFileSync(file, 'utf8'),
      ) as WorkspaceManifest
      const declared = { ...manifest.dependencies, ...manifest.devDependencies }
      for (const dep of Object.keys(declared)) {
        // `@camstack/*` are workspace links, not installs — a missing one is a
        // different (and much louder) problem than an unreproduced tree.
        if (dep.startsWith('@camstack/')) continue
        if (!resolvesFrom(dirPath, dep)) out.push({ workspace: manifest.name ?? pkg, dep })
      }
    }
  }
  return out
}

function refuseIncompleteCheckout(): void {
  const missing = unresolvedWorkspaceDeps()
  if (missing.length === 0) return
  console.error('[31m✘ this checkout is INCOMPLETE — refusing to report bucket counts[0m')
  console.error(
    `\n  ${missing.length} declared dependenc(ies) do not resolve from the package that\n` +
      '  declares them. Every bucket below would blame code that is fine:\n',
  )
  for (const m of missing.slice(0, 20)) console.error(`    ${m.workspace} → ${m.dep}`)
  if (missing.length > 20) console.error(`    … and ${missing.length - 20} more`)
  console.error(
    '\n  This is almost always a git worktree whose `node_modules` mirrors ONLY the\n' +
      '  repo root. npm nests a dependency it cannot hoist, and this repo nests a\n' +
      '  lot of them permanently (root `vitest@^4` vs `^3` in ~40 packages), so the\n' +
      '  workspace-level `packages/*/node_modules/` are NOT optional.\n' +
      '\n  Mirror those too, or run the check in a checkout installed with `npm ci`.\n',
  )
  process.exit(2)
}

function parseEngine(args: readonly string[]): {
  readonly engine: TypecheckEngine
  readonly consumed: ReadonlySet<number>
} {
  const consumed = new Set<number>()
  let engine: TypecheckEngine = 'tsgo'
  args.forEach((a, i) => {
    if (a.startsWith('--engine=')) {
      const value = a.slice('--engine='.length)
      if (value !== 'tsc' && value !== 'tsgo') {
        console.error(`unknown --engine=${value} (want tsc|tsgo)`)
        process.exit(2)
      }
      engine = value
      consumed.add(i)
      return
    }
    if (a === '--engine') {
      const value = args[i + 1]
      if (value !== 'tsc' && value !== 'tsgo') {
        console.error(`unknown --engine ${value ?? '(missing)'} (want tsc|tsgo)`)
        process.exit(2)
      }
      engine = value
      consumed.add(i)
      consumed.add(i + 1)
    }
  })
  return { engine, consumed }
}

function main(): void {
  const args = process.argv.slice(2)
  const update = args.includes('--update')
  const { engine, consumed: engineConsumed } = parseEngine(args)
  typecheckEngine = engine
  // `--allow-increase <check>` (repeatable): the only way `--update` may raise
  // a bucket or add a key to it. See lib/baseline-update.ts.
  const allowIncrease = new Set<string>()
  const flagValues = new Set<number>(engineConsumed)
  args.forEach((a, i) => {
    const value = args[i + 1]
    if (a === '--allow-increase' && value !== undefined) {
      allowIncrease.add(value)
      flagValues.add(i + 1)
    }
  })
  const requested = args.filter((a, i) => !a.startsWith('--') && !flagValues.has(i))
  const selected =
    requested.length === 0 ? CHECKS : CHECKS.filter((c) => requested.includes(c.name))

  if (selected.length === 0) {
    console.error(`unknown check(s): ${requested.join(', ')}`)
    console.error(`known: ${CHECKS.map((c) => c.name).join(', ')}`)
    process.exit(2)
  }

  // Grading a checkout that is not fully installed produces confident nonsense.
  refuseIncompleteCheckout()
  console.log(`  (typecheck engine: ${engine})`)
  const baseline = readBaseline()
  const next: Record<string, unknown> = { ...HEADER, ...baseline }
  let failed = false
  let refused = false

  for (const check of selected) {
    process.stdout.write(`  … ${check.name}\n`)
    const actual = check.run()
    const total = [...actual.values()].reduce((a, b) => a + b, 0)

    if (update) {
      const plan = planBaselineUpdate(
        check.name,
        actual,
        baseline[check.name] ?? {},
        allowIncrease.has(check.name),
      )
      if (plan.refusals.length > 0) {
        refused = true
        console.error(
          `\u001B[31m✘ ${check.name}: refusing to pin ${plan.refusals.length} ${check.unit}(s) upward\u001B[0m`,
        )
        for (const r of plan.refusals) {
          console.error(`    ${r.bucket} — pinned ${r.pinned ?? 'nothing'}, now ${r.actual}`)
        }
        continue
      }
      next[check.name] = plan.next
      console.log(
        `  \u001B[36m↻\u001B[0m ${check.name}: pinned ${total} in ${actual.size} ${check.unit}(s)`,
      )
      continue
    }

    const { regressions, improvements } = compare(actual, baseline[check.name] ?? {})

    if (regressions.length > 0) {
      failed = true
      console.error(
        `\u001B[31m✘ ${check.name}: ${regressions.length} ${check.unit}(s) got worse\u001B[0m`,
      )
      for (const d of regressions) {
        console.error(`    ${d.bucket} — pinned ${d.pinned}, now ${d.actual}`)
      }
      continue
    }

    if (improvements.length > 0) {
      console.log(
        `  \u001B[33m↓\u001B[0m ${check.name}: ${improvements.length} ${check.unit}(s) improved — ` +
          're-pin with `tsx scripts/check-ci-baselines.ts --update` so the ratchet holds',
      )
      for (const d of improvements) {
        console.log(`    ${d.bucket} — pinned ${d.pinned}, now ${d.actual}`)
      }
    }
    console.log(`  \u001B[32m✔\u001B[0m ${check.name}: ${total} pinned violation(s), none new`)
  }

  if (update && refused) {
    console.error(
      '\n  Nothing written. A ratchet only goes down: fix what is new. If an increase is\n' +
        '  genuinely unavoidable, re-run with `--allow-increase <check>` and say why in the\n' +
        '  commit. Production `typecheck` cannot be pinned at all (D695).',
    )
    process.exit(1)
  }

  if (update) {
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`)
    console.log(
      `\n  wrote ${path.relative(ROOT, BASELINE_FILE)} — review the diff before committing`,
    )
    return
  }

  if (failed) {
    console.error(
      '\n  These are NEW. Fix them, or — if the violation is genuinely unavoidable —\n' +
        '  re-pin with `--update --allow-increase <check>` and say why in the commit.',
    )
    process.exit(1)
  }
}

main()

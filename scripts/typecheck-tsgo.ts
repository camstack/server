#!/usr/bin/env tsx
/**
 * `npm run typecheck:tsgo` — the whole-repo typecheck on TypeScript 7 (tsgo).
 *
 * Runs every workspace project's OWN `typecheck` script with `tsc` swapped for
 * `tsgo --checkers 1`, splits the diagnostics exactly as
 * `check-ci-baselines.ts typecheck` does, and grades them against the same
 * pins in `scripts/ci-baseline.json`. It does NOT re-pin: that is
 * `check-ci-baselines.ts --update`. TypeScript 7 is the only type-check engine
 * (D832); there is no tsc 6 reference to compare against.
 *
 * Why `--checkers 1`: tsgo's default of 4 parallel checkers each hold their own
 * copy of the checker state, so it uses MORE memory than one checker on the big
 * projects; one checker is the RAM floor (P1, docs/design/2026-10-09-ts7-
 * transition-plan.md). Override with `TSGO_CHECKERS`.
 *
 * Usage: tsx scripts/typecheck-tsgo.ts [project-dir-basename …]
 *        npm run typecheck:pkg -- <project-dir-basename …>
 */
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  gradeAgainstBaseline,
  isTsgoVersionOutput,
  listTypecheckProjects,
  resolveTsgoBinary,
  type TypecheckBaseline,
  toTsgoCommand,
} from './lib/tsgo-typecheck.ts'
import { splitTypecheckSection } from './lib/typecheck-split.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const CHECKERS = process.env.TSGO_CHECKERS ?? '1'

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function assertTs7(bin: string): string | null {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8' })
  const text = `${result.stdout}${result.stderr}`
  if (!isTsgoVersionOutput(text)) {
    return `expected a TypeScript 7 binary at ${bin}, got: ${text.trim() || `(exit ${result.status})`}`
  }
  return null
}

interface ShellResult {
  readonly status: number
  readonly output: string
}

function runShell(command: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => chunks.push(c))
    child.on('error', (err) => resolve({ status: 1, output: String(err) }))
    child.on('close', (code) => resolve({ status: code ?? 1, output: Buffer.concat(chunks).toString('utf8') }))
  })
}

/**
 * Project directory basenames to check. A path is accepted too
 * (`packages/addon-pipeline/`, `server/backend`): its last segment names it.
 */
function parseArgs(argv: readonly string[]): ReadonlySet<string> {
  const only = new Set<string>()
  for (const arg of argv) {
    if (arg.startsWith('--')) continue
    const base = path.basename(arg.replace(/\/+$/, ''))
    if (base.length > 0) only.add(base)
  }
  return only
}

async function main(): Promise<number> {
  const tsgoBin = resolveTsgoBinary(ROOT)
  if (tsgoBin === null) {
    console.error(
      'tsgo not found — install typescript-7 (npm:typescript@7) or @typescript/native-preview',
    )
    return 2
  }
  const versionErr = assertTs7(tsgoBin)
  if (versionErr !== null) {
    console.error(versionErr)
    return 2
  }

  const only = parseArgs(process.argv.slice(2))
  const baseline = (readJson(path.join(ROOT, 'scripts', 'ci-baseline.json')) ??
    {}) as TypecheckBaseline
  const projects = listTypecheckProjects(ROOT, only)
  if (only.size > 0 && projects.length < only.size) {
    const found = new Set(projects.map((p) => path.basename(p.dir)))
    const missing = [...only].filter((name) => !found.has(name))
    console.error(`no typecheck project named: ${missing.join(', ')} (want a packages/<dir> or server/backend basename)`)
    return 2
  }
  const failures: string[] = []
  const started = Date.now()
  const tsgoPrefix = `${tsgoBin} --checkers ${CHECKERS}`

  // Projects are independent processes reading each other's dist, never
  // writing it, so they can overlap. TSGO_JOBS bounds the pool (default 1, the
  // memory floor of a laptop; CI sets 3 on a 4 vCPU / 16 GB runner).
  const jobs = Math.max(1, Number.parseInt(process.env.TSGO_JOBS ?? '1', 10) || 1)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const project = projects[next++]
      if (project === undefined) return
      await checkProject(project)
    }
  }
  const checkProject = async (project: (typeof projects)[number]): Promise<void> => {
    const command = toTsgoCommand(project.script, tsgoPrefix)
    if (command === null) return
    const t0 = Date.now()
    const tsgo = await runShell(command, project.dir)
    const split = splitTypecheckSection(tsgo.output)
    const seconds = ((Date.now() - t0) / 1000).toFixed(1)

    if (split === null && tsgo.status !== 0) {
      failures.push(
        `${project.name}: tsgo exited ${tsgo.status} with no readable diagnostic\n${tsgo.output.slice(-1000)}`,
      )
      console.log(`✗ ${project.name} (${seconds}s) — no readable diagnostic`)
      return
    }

    const worse = split === null ? [] : gradeAgainstBaseline(project.name, split, baseline)
    failures.push(...worse)

    const total =
      split === null ? 0 : split.production + [...split.specs.values()].reduce((a, b) => a + b, 0)
    console.log(
      `${worse.length > 0 ? '✗' : '✓'} ${project.name} (${seconds}s, ${total} pinned-or-new error(s))`,
    )
  }
  await Promise.all(Array.from({ length: Math.min(jobs, projects.length) }, worker))

  const elapsed = ((Date.now() - started) / 1000).toFixed(0)
  if (failures.length > 0) {
    console.error(
      `\ntsgo typecheck: ${failures.length} failure(s) (${elapsed}s):`,
    )
    for (const f of failures) console.error(`  ${f}`)
    return 1
  }
  console.log(
    `\ntsgo typecheck: ${projects.length} project(s) within baseline (${elapsed}s)`,
  )
  return 0
}

void main().then((code) => process.exit(code))

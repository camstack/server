#!/usr/bin/env tsx
/**
 * `npm run typecheck:tsgo` — the whole-repo typecheck on TypeScript 7 (tsgo).
 *
 * Runs every workspace project's OWN `typecheck` script with `tsc` swapped for
 * `tsgo --checkers 1`, splits the diagnostics exactly as
 * `check-ci-baselines.ts typecheck` does, and grades them against the same
 * pins in `scripts/ci-baseline.json`. It does NOT re-pin: `npm run typecheck`
 * (tsc 6) stays the reference and the only `--update` path.
 *
 * Why `--checkers 1`: tsgo's default of 4 parallel checkers each hold their own
 * copy of the checker state, so it uses MORE memory than tsc 6 on the big
 * projects; one checker is the RAM floor (P1, docs/design/2026-10-09-ts7-
 * transition-plan.md). Override with `TSGO_CHECKERS`.
 *
 * `--parity`: also run each project's original `tsc` script and fail when the
 * normalized error sets (`file(line,col): TSxxxx`) differ. Message text is
 * ignored (union-order noise). Grading against the baseline still runs.
 *
 * Usage: tsx scripts/typecheck-tsgo.ts [--parity] [project-dir-basename …]
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  diffErrorSets,
  gradeAgainstBaseline,
  isTsgoVersionOutput,
  listTypecheckProjects,
  normalizeErrorSet,
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

function runShell(
  command: string,
  cwd: string,
): { readonly status: number; readonly output: string } {
  const result = spawnSync('bash', ['-c', command], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
}

function parseArgs(argv: readonly string[]): {
  readonly parity: boolean
  readonly only: ReadonlySet<string>
} {
  const only = new Set<string>()
  let parity = false
  for (const arg of argv) {
    if (arg === '--parity') parity = true
    else if (!arg.startsWith('--')) only.add(arg)
  }
  return { parity, only }
}

function main(): number {
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

  const { parity, only } = parseArgs(process.argv.slice(2))
  const baseline = (readJson(path.join(ROOT, 'scripts', 'ci-baseline.json')) ??
    {}) as TypecheckBaseline
  const projects = listTypecheckProjects(ROOT, only)
  const failures: string[] = []
  const started = Date.now()
  const tsgoPrefix = `${tsgoBin} --checkers ${CHECKERS}`

  for (const project of projects) {
    const command = toTsgoCommand(project.script, tsgoPrefix)
    if (command === null) continue
    const t0 = Date.now()
    const tsgo = runShell(command, project.dir)
    const split = splitTypecheckSection(tsgo.output)
    const seconds = ((Date.now() - t0) / 1000).toFixed(1)

    if (split === null && tsgo.status !== 0) {
      failures.push(
        `${project.name}: tsgo exited ${tsgo.status} with no readable diagnostic\n${tsgo.output.slice(-1000)}`,
      )
      console.log(`✗ ${project.name} (${seconds}s) — no readable diagnostic`)
      continue
    }

    const worse = split === null ? [] : gradeAgainstBaseline(project.name, split, baseline)
    failures.push(...worse)

    if (parity) {
      const tsc = runShell(project.script, project.dir)
      const diff = diffErrorSets(normalizeErrorSet(tsc.output), normalizeErrorSet(tsgo.output))
      if (diff.onlyInLeft.length > 0 || diff.onlyInRight.length > 0) {
        const lines = [
          `${project.name}: tsc↔tsgo error-set mismatch`,
          ...diff.onlyInLeft.map((e) => `  only-tsc:  ${e}`),
          ...diff.onlyInRight.map((e) => `  only-tsgo: ${e}`),
        ]
        failures.push(lines.join('\n'))
        console.log(`✗ ${project.name} (${seconds}s) — parity mismatch`)
        continue
      }
    }

    const total =
      split === null ? 0 : split.production + [...split.specs.values()].reduce((a, b) => a + b, 0)
    console.log(
      `${worse.length > 0 ? '✗' : '✓'} ${project.name} (${seconds}s, ${total} pinned-or-new error(s)${parity ? ', parity ok' : ''})`,
    )
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(0)
  if (failures.length > 0) {
    console.error(
      `\ntsgo typecheck: ${failures.length} failure(s) (${elapsed}s)${parity ? ' [parity]' : ''}:`,
    )
    for (const f of failures) console.error(`  ${f}`)
    return 1
  }
  console.log(
    `\ntsgo typecheck: ${projects.length} project(s) within baseline (${elapsed}s)${parity ? ', parity clean' : ''}`,
  )
  return 0
}

process.exit(main())

/**
 * tsgo-typecheck — the pure half of `scripts/typecheck-tsgo.ts`.
 *
 * TypeScript 7 (native Go `tsc` in the `typescript-7` npm alias; historically
 * called `tsgo` in the preview) checks this repository with the same
 * diagnostics as tsc 6 at ~1/8 of the wall time (measured 2026-10-09,
 * docs/design/2026-10-09-ci-build-memory-and-ts7.md). It has no JS API, so
 * tooling that imports `typescript` as a library (eslint, ts-morph, tsup)
 * stays on 6 until ~7.1. Emit and typecheck scripts call the binary via
 * `scripts/tsc7` or this rewriter.
 *
 * Default checkers: 1. tsgo's default of 4 holds a checker copy per thread and
 * uses MORE RAM than tsc 6; `--checkers 1` is the RAM floor (P1). Override with
 * `TSGO_CHECKERS`. Binary: `typescript-7` npm alias when present, else the
 * `@typescript/native-preview` `tsgo` shim.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { SectionSplit } from './typecheck-split.ts'

/** A whole-word `tsc` followed by whitespace or end — never `vue-tsc`, `tscx`, `tsc-helper`. */
const TSC_WORD = /(?<![\w./-])tsc(?=\s|$)/g

/** Rewrite a `typecheck` script to call `tsgo`; null when it never calls tsc. */
export function toTsgoCommand(script: string, tsgo: string): string | null {
  if (!TSC_WORD.test(script)) return null
  TSC_WORD.lastIndex = 0
  return script.replace(TSC_WORD, tsgo)
}

export interface TypecheckBaseline {
  readonly typecheck?: Readonly<Record<string, number>>
  readonly 'typecheck-specs'?: Readonly<Record<string, number>>
}

/** Every bucket of `project` that is worse than its pin, as a readable line. */
export function gradeAgainstBaseline(
  project: string,
  split: SectionSplit,
  baseline: TypecheckBaseline,
): readonly string[] {
  const failures: string[] = []
  const pinnedProd = baseline.typecheck?.[project] ?? 0
  if (split.production > pinnedProd) {
    failures.push(`${project}: ${split.production} production error(s), pinned ${pinnedProd}`)
  }
  for (const [file, n] of split.specs) {
    const key = `${project} » ${file}`
    const pinned = baseline['typecheck-specs']?.[key] ?? 0
    if (n > pinned) failures.push(`${key}: ${n} error(s), pinned ${pinned}`)
  }
  return failures
}

/**
 * Normalized diagnostic identity for tsc↔tsgo parity.
 *
 * Entry form: `file(line,col): TSxxxx` — message text is dropped because TS 7
 * can reorder union members in the message without changing the diagnostic
 * (docs/design/2026-10-09-ts7-transition-plan.md §4.1).
 */
const FLAT_DIAGNOSTIC = /^(\S[^\n]*?)\((\d+),(\d+)\): error (TS\d+):/gm
const PRETTY_DIAGNOSTIC = /^(\S[^\n]*?):(\d+):(\d+) - error (TS\d+):/gm

export function normalizeErrorSet(output: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (const pattern of [FLAT_DIAGNOSTIC, PRETTY_DIAGNOSTIC]) {
    pattern.lastIndex = 0
    for (const match of output.matchAll(pattern)) {
      const file = match[1]
      const line = match[2]
      const col = match[3]
      const code = match[4]
      if (file === undefined || line === undefined || col === undefined || code === undefined) {
        continue
      }
      out.add(`${file}(${line},${col}): ${code}`)
    }
  }
  return out
}

export interface ErrorSetDiff {
  readonly onlyInLeft: readonly string[]
  readonly onlyInRight: readonly string[]
}

/** Symmetric difference of two normalized error sets, sorted for stable logs. */
export function diffErrorSets(left: ReadonlySet<string>, right: ReadonlySet<string>): ErrorSetDiff {
  const onlyInLeft: string[] = []
  const onlyInRight: string[] = []
  for (const e of left) if (!right.has(e)) onlyInLeft.push(e)
  for (const e of right) if (!left.has(e)) onlyInRight.push(e)
  onlyInLeft.sort()
  onlyInRight.sort()
  return { onlyInLeft, onlyInRight }
}

export interface TypecheckProject {
  readonly name: string
  readonly dir: string
  readonly script: string
}

/**
 * Prefer the released `typescript@7` npm alias (`typescript-7`); fall back to
 * `@typescript/native-preview`'s `tsgo` shim. Always call by absolute path so
 * a `.bin/tsc` collision cannot silently run TS 6.
 */
export function resolveTsgoBinary(root: string): string | null {
  const aliasBin = path.join(root, 'node_modules', 'typescript-7', 'bin', 'tsc')
  if (fs.existsSync(aliasBin)) return aliasBin
  const previewBin = path.join(root, 'node_modules', '.bin', 'tsgo')
  if (fs.existsSync(previewBin)) return previewBin
  return null
}

/** True when `tsc --version` / `tsgo --version` output is a TypeScript 7 line. */
export function isTsgoVersionOutput(text: string): boolean {
  const trimmed = text.trim()
  return /\bVersion\s+7\./.test(trimmed) || trimmed.startsWith('7.')
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Workspace projects with a tsc-based `typecheck` script, named as nx names them. */
export function listTypecheckProjects(
  root: string,
  only: ReadonlySet<string> = new Set(),
): readonly TypecheckProject[] {
  const dirs = [
    ...fs.readdirSync(path.join(root, 'packages')).map((d) => path.join(root, 'packages', d)),
    path.join(root, 'server', 'backend'),
  ]
  const projects: TypecheckProject[] = []
  for (const dir of dirs) {
    if (only.size > 0 && !only.has(path.basename(dir))) continue
    const pkg = readJson(path.join(dir, 'package.json'))
    const scripts = pkg?.scripts as Record<string, string> | undefined
    const script = scripts?.typecheck
    if (!pkg || typeof pkg.name !== 'string' || !script) continue
    const projectJsonName = readJson(path.join(dir, 'project.json'))?.name
    const name = typeof projectJsonName === 'string' ? projectJsonName : pkg.name
    projects.push({ name, dir, script })
  }
  return projects
}

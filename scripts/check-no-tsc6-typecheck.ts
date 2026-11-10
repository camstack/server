#!/usr/bin/env tsx
/**
 * TypeScript 7 (tsgo) is the only type-check engine (D832). No TS 6 type-check
 * path comes back.
 *
 * ## The failure this catches
 *
 * Agents kept running `tsc --noEmit -p tsconfig.spec.json` — TypeScript 6,
 * 1.4 GB and 1.5 cores for one package, on a machine already swapping — while
 * the gate grades tsgo (`npm run typecheck`, `npm run typecheck:pkg`). A second
 * engine also answers a different question: its pins are not the gate's pins.
 * `typecheck:tsc6` and `check-ci-baselines.ts --engine=tsc` kept that path one
 * command away, and the instructions agents read still named it.
 *
 * ## What it refuses
 *
 * In `scripts/`, `.claude/agents/`, `.claude/skills/` and every workspace
 * `package.json` script:
 *   - a whole-word `tsc` followed on the same line by `--noEmit` (a TS 6 check;
 *     `scripts/tsc7` and the absolute TS 7 binary are not `tsc`),
 *   - `--engine=tsc` / `--engine tsc`,
 *   - a `typecheck:tsc6` script.
 *
 * Builds that EMIT with `tsc -p …` are not a type-check path and stay.
 *
 * ## The one open exemption
 *
 * A workspace package's own `typecheck` script (`tsc --noEmit -p
 * tsconfig.spec.json`) is the INPUT the tsgo runner rewrites
 * (`lib/tsgo-typecheck.ts` swaps `tsc` for the TS 7 binary by absolute path);
 * it never runs on TS 6 through the gate. Moving the 57 scripts to
 * `scripts/tsc7` changes every published package's package.json, so it is its
 * own decision; until then the `typecheck` key and the files that state its
 * contract ({@link CONTRACT_FILES}) are exempt — and only those.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const SCANNED_TREES: readonly string[] = ['scripts', '.claude/agents', '.claude/skills']

/** Files that state the per-package `typecheck` script contract the tsgo runner rewrites. */
export const CONTRACT_FILES: ReadonlySet<string> = new Set([
  'scripts/check-specs-are-typechecked.ts',
  'scripts/__tests__/check-specs-are-typechecked.spec.ts',
  'scripts/__tests__/tsgo-typecheck.spec.ts',
  'scripts/__tests__/typecheck-split.spec.ts',
  // This guard and its spec spell the patterns they refuse.
  'scripts/check-no-tsc6-typecheck.ts',
  'scripts/__tests__/check-no-tsc6-typecheck.spec.ts',
])

const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'a TS 6 `tsc --noEmit` type check', pattern: /(?<![\w./-])tsc(?=\s)[^\n]*--noEmit/ },
  { name: 'the removed `--engine=tsc` path', pattern: /--engine[= ]tsc\b/ },
  { name: 'the removed `typecheck:tsc6` script', pattern: /typecheck:tsc6/ },
]

export interface Tsc6Finding {
  readonly where: string
  readonly what: string
}

/** Every forbidden form in a text file, one finding per line. */
export function scanText(file: string, text: string): readonly Tsc6Finding[] {
  const findings: Tsc6Finding[] = []
  text.split('\n').forEach((line, i) => {
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(line)) findings.push({ where: `${file}:${i + 1}`, what: rule.name })
    }
  })
  return findings
}

/** Every forbidden form in a package.json's scripts; the `typecheck` key is the open exemption. */
export function scanPackageScripts(file: string, json: string): readonly Tsc6Finding[] {
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || !('scripts' in parsed)) return []
  const scripts: unknown = parsed.scripts
  if (typeof scripts !== 'object' || scripts === null) return []
  const findings: Tsc6Finding[] = []
  for (const [key, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') continue
    if (key === 'typecheck:tsc6') {
      findings.push({ where: `${file} scripts.${key}`, what: 'the removed `typecheck:tsc6` script' })
      continue
    }
    if (key === 'typecheck' && file !== 'package.json') continue
    for (const rule of FORBIDDEN) {
      if (rule.pattern.test(value)) findings.push({ where: `${file} scripts.${key}`, what: rule.name })
    }
  }
  return findings
}

function tracked(root: string, pathspecs: readonly string[]): readonly string[] {
  const out = execFileSync('git', ['ls-files', '--', ...pathspecs], { cwd: root, encoding: 'utf8' })
  return out.split('\n').filter((line) => line.length > 0)
}

export function findAll(root: string): readonly Tsc6Finding[] {
  const findings: Tsc6Finding[] = []
  for (const file of tracked(root, SCANNED_TREES)) {
    if (CONTRACT_FILES.has(file)) continue
    findings.push(...scanText(file, readFileSync(join(root, file), 'utf8')))
  }
  const manifests = tracked(root, ['package.json', 'packages/*/package.json', 'server/*/package.json', 'e2e/package.json'])
  for (const file of manifests) {
    findings.push(...scanPackageScripts(file, readFileSync(join(root, file), 'utf8')))
  }
  return findings
}

function main(): void {
  const findings = findAll(ROOT)
  if (findings.length === 0) {
    console.log('check-no-tsc6-typecheck: no TS 6 type-check path (tsgo is the only engine, D832)')
    return
  }
  console.error('check-no-tsc6-typecheck: a TS 6 type-check path is back:')
  for (const f of findings) console.error(`  ${f.where}: ${f.what}`)
  console.error(
    '\n  Type-check with tsgo: `npm run typecheck` (whole repo, graded against the pins) or\n' +
      '  `npm run typecheck:pkg -- <dir>` (the packages you touched).',
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

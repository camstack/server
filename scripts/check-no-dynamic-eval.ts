#!/usr/bin/env tsx
/**
 * Stage X security guard — fail the build if ANY production source file uses a
 * dynamic code-execution primitive. This is the enforce-by-construction backstop
 * for the safe expression engine (spec §4 rule 1): the engine exists precisely
 * so nothing in the codebase ever needs `eval` / `new Function` / `node:vm`.
 *
 * Detection rules (line-based scan — simple and robust):
 *
 *   Rule 1 — eval(
 *     Flags a non-comment line matching `\beval\s*\(`. The `\b` + immediate `(`
 *     means `evaluate(`, `evalNode(`, `safeEval…` etc. do NOT match, while
 *     `eval(`, `window.eval(`, `globalThis.eval(` DO (the `.` before `eval` is
 *     a word boundary).
 *
 *   Rule 2 — Function constructor
 *     Flags `new Function(` and a bare `Function(` call (not preceded by `.` or
 *     a word char, so `foo.Function(` / `MyFunction(` do not match). Both build
 *     code from a string.
 *
 *   Rule 3 — sandbox / vm module import
 *     Flags an import/require of `node:vm`, `vm`, `vm2`, `isolated-vm` or
 *     `quickjs-emscripten` — the usual escape hatches for evaluating untrusted
 *     code. Bare `vm` is matched only in a `from '…'` / `require('…')` context
 *     so an unrelated string `'vm'` elsewhere is not flagged.
 *
 * Only the handful of pre-existing, justified infra uses in `EXEMPT_FILES`
 * (the ESM dynamic-import shim + the dev REPL sandbox) may match; every other
 * production file — the whole expression engine included — must be clean.
 * Usage: npx tsx scripts/check-no-dynamic-eval.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

// Pre-existing, legitimate, NON-expression uses of a flagged primitive. Each is
// either the standard `Function('m', 'return import(m)')` ESM dynamic-import
// shim (a bundler/CJS workaround that imports a MODULE by a fixed literal — it
// evaluates no untrusted data) or the developer REPL sandbox. They are exempted
// by exact path so the guard still bans any NEW eval / Function / vm usage
// everywhere else — most importantly across the expression engine and device
// link resolution. Adding a new entry here requires the same justification.
const EXEMPT_FILES: readonly string[] = [
  // ESM dynamic-import shim: `Function('m', 'return import(m)')(spec)`.
  path.join(ROOT, 'packages/addon-pipeline/src/stream-broker/webrtc/session.ts'),
  path.join(ROOT, 'packages/addon-provider-hikvision/src/intercom/werift-intercom-peer.ts'),
  path.join(ROOT, 'packages/addon-provider-reolink/src/intercom-webrtc-peer.ts'),
  path.join(ROOT, 'packages/desktop/src/main.ts'),
  path.join(ROOT, 'server/backend/src/core/addon/addon-registry.service.ts'),
  // Developer REPL sandbox (node:vm) — dev tooling, not a data-eval path.
  path.join(ROOT, 'packages/system/src/repl/repl-engine.ts'),
  // Heap reclaimer: `vm.runInNewContext('gc')` with a FIXED literal — the
  // standard capture of the --expose-gc function without a new argv. No data
  // ever reaches the evaluated string.
  path.join(ROOT, 'packages/system/src/kernel/heap-watch.ts'),
]

// Directories/patterns to skip while walking (tests are allowed to reference
// these primitives in fixtures/corpora, mirroring check-event-bus-usage.ts).
const SKIP_DIRS = new Set(['dist', 'node_modules', '__tests__', '.git', 'coverage', 'generated'])

interface Violation {
  readonly file: string
  readonly line: number
  readonly content: string
  readonly reason: string
}

function isExempt(filePath: string): boolean {
  return EXEMPT_FILES.includes(filePath)
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*')
}

const EVAL_RE = /\beval\s*\(/
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/
const BARE_FUNCTION_RE = /(?<![.\w])Function\s*\(/
const VM_MODULE_RE = /['"](?:node:vm|vm2|isolated-vm|quickjs-emscripten)['"]/
const BARE_VM_IMPORT_RE = /(?:from\s+|require\s*\(\s*)['"]vm['"]/

function checkFile(filePath: string): readonly Violation[] {
  const violations: Violation[] = []
  const src = fs.readFileSync(filePath, 'utf-8')
  const lines = src.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const lineNo = i + 1
    if (isCommentLine(raw)) continue

    if (EVAL_RE.test(raw)) {
      violations.push({
        file: filePath,
        line: lineNo,
        content: raw.trim(),
        reason: 'uses eval() — dynamic code execution is banned (use the safe expression engine)',
      })
    }
    if (NEW_FUNCTION_RE.test(raw) || BARE_FUNCTION_RE.test(raw)) {
      violations.push({
        file: filePath,
        line: lineNo,
        content: raw.trim(),
        reason: 'uses the Function constructor — dynamic code execution is banned',
      })
    }
    if (VM_MODULE_RE.test(raw) || BARE_VM_IMPORT_RE.test(raw)) {
      violations.push({
        file: filePath,
        line: lineNo,
        content: raw.trim(),
        reason: 'imports a vm/sandbox module — dynamic code execution is banned',
      })
    }
  }

  return violations
}

function walkTs(dir: string, results: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkTs(path.join(dir, entry.name), results)
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.spec.tsx') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      results.push(path.join(dir, entry.name))
    }
  }
  return results
}

const SCAN_ROOTS = [path.join(ROOT, 'packages'), path.join(ROOT, 'server/backend/src')]

const allFiles: string[] = []
for (const scanRoot of SCAN_ROOTS) {
  walkTs(scanRoot, allFiles)
}

const allViolations: Violation[] = []
for (const filePath of allFiles) {
  if (isExempt(filePath)) continue
  allViolations.push(...checkFile(filePath))
}

if (allViolations.length === 0) {
  // eslint-disable-next-line no-console
  console.log(
    '  \x1b[32m✔\x1b[0m no-dynamic-eval guard passed — no eval/new Function/vm usage found',
  )
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error('\n\x1b[31m✘ dynamic code-execution violations detected:\x1b[0m')
// eslint-disable-next-line no-console
console.error(
  '  Production code must never use eval / new Function / node:vm. Compute derived\n  values through the safe expression engine (packages/types/src/expression). (Stage X)\n',
)
for (const v of allViolations) {
  // eslint-disable-next-line no-console
  console.error(`    ${path.relative(ROOT, v.file)}:${v.line}  ${v.reason}`)
  // eslint-disable-next-line no-console
  console.error(`      \x1b[2m${v.content}\x1b[0m`)
}
// eslint-disable-next-line no-console
console.error('')
process.exit(1)

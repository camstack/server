#!/usr/bin/env tsx
/**
 * A `[mem]` heartbeat that nobody can read is not telemetry.
 *
 * ## What this prevents
 *
 * hub-main ran `startHeapWatch` from the first statement of `bootstrap()` from
 * 2026-08-02 onward, with a correct label, a declared RSS budget, a proven
 * reclaimer and a full-fidelity line. It passed no SINK, so it fell back to
 * `console.log`. `console.log` is not an `ILogDestination`: it bypasses the
 * ring buffer, the console destination, the rotated file and the Loki
 * destination alike. The result was 42 hours of Loki holding a `[mem]` line for
 * every runner in the cluster and none for the ~4.8GB process that mediates
 * every cross-runner call — so its growth was only ever inferred from code,
 * never trended.
 *
 * Nothing caught that. `typecheck`, `test`, `lint` and `docs:check` were all
 * green the entire time, because "the sink defaults to console" is a legal,
 * type-correct, well-tested expression. Only a guard can see it.
 *
 * ## The two rules
 *
 * 1. Every PRODUCTION `startHeapWatch` call passes a sink — argument 2 is never
 *    `undefined`. `undefined` there means "console only", which for any process
 *    the operator monitors is the same as silence.
 * 2. hub-main's call site additionally builds a `createDeferredHeapWatchSink`
 *    and `attach`es it, because it starts before `LoggingService` exists and a
 *    sink that is never handed over is rule 1 passed on a technicality.
 *
 * Tests are exempt: a spec asserting the console fallback is exactly the kind of
 * call this guard must not forbid.
 *
 * Usage: npx tsx scripts/check-mem-heartbeat-has-a-destination.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

/** Where production code lives. Anything else is a fixture or a build output. */
const SCAN_ROOTS: readonly string[] = ['packages', 'server']

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  '__tests__',
  '__mocks__',
  'coverage',
  '.git',
])

/** The composition root — the process this guard exists for. */
const HUB_MAIN = path.join(ROOT, 'server/backend/src/main.ts')

const CALL = 'startHeapWatch('

interface Violation {
  readonly file: string
  readonly line: number
  readonly reason: string
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      out.push(full)
    }
  }
}

/** The text between the parens of a call starting at `open`, paren-balanced. */
function argumentText(source: string, open: number): string | null {
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return null
}

/** Split an argument list on TOP-LEVEL commas only. */
function splitArguments(text: string): readonly string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(' || ch === '{' || ch === '[') depth += 1
    else if (ch === ')' || ch === '}' || ch === ']') depth -= 1
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter((p) => p.length > 0)
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

function checkCallSites(file: string, source: string, violations: Violation[]): void {
  let from = 0
  for (;;) {
    const at = source.indexOf(CALL, from)
    if (at === -1) return
    from = at + CALL.length
    // `export function startHeapWatch(` is the definition, not a call.
    const before = source.slice(Math.max(0, at - 20), at)
    if (/function\s+$/.test(before)) continue
    const args = argumentText(source, at + CALL.length - 1)
    if (args === null) continue
    const sink = splitArguments(args)[1]
    if (sink === undefined || sink === 'undefined') {
      violations.push({
        file,
        line: lineOf(source, at),
        reason:
          'startHeapWatch() with no sink falls back to console.log, which is not a log ' +
          'destination — the line never reaches the buffer, the rotated file or Loki. ' +
          'Pass an IScopedLogger-backed HeapWatchSink (see createDeferredHeapWatchSink).',
      })
    }
  }
}

function checkHubMainHandover(violations: Violation[]): void {
  const source = fs.readFileSync(HUB_MAIN, 'utf8')
  if (!source.includes('createDeferredHeapWatchSink(')) {
    violations.push({
      file: HUB_MAIN,
      line: 1,
      reason:
        'hub-main starts its heap watch before LoggingService exists, so its sink must be a ' +
        'createDeferredHeapWatchSink() that is handed over once the log manager is up.',
    })
    return
  }
  if (!/\.attach\(/.test(source)) {
    violations.push({
      file: HUB_MAIN,
      line: lineOf(source, source.indexOf('createDeferredHeapWatchSink(')),
      reason:
        'the deferred sink is created but never attached — every hub-main [mem] line would ' +
        'still go to stdout only, which is the exact silence this guard exists to prevent.',
    })
  }
}

function main(): void {
  const files: string[] = []
  for (const root of SCAN_ROOTS) walk(path.join(ROOT, root), files)

  const violations: Violation[] = []
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    if (!source.includes(CALL)) continue
    checkCallSites(file, source, violations)
  }
  checkHubMainHandover(violations)

  if (violations.length === 0) {
    console.log(
      `✓ [mem] heartbeat: every production startHeapWatch call has a log destination ` +
        `(${files.length} files scanned)`,
    )
    return
  }
  console.error('✗ [mem] heartbeat would be invisible:\n')
  for (const v of violations) {
    console.error(`  ${path.relative(ROOT, v.file)}:${v.line}`)
    console.error(`    ${v.reason}\n`)
  }
  process.exit(1)
}

main()

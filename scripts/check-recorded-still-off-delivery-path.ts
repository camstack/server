#!/usr/bin/env tsx
/**
 * R3 guard — a GOP re-decode may never sit on a delivery's critical path.
 *
 * ## The constraint this enforces
 *
 * Operator directive, 2026-08-13, when R3 (recover a native frame by
 * re-decoding it out of the recording) was approved: *"va bene anche il
 * re-encode dal gop dove disponibile"* — with one hard condition, that **a
 * notification never waits on a GOP decode**.
 *
 * The reason is arithmetic. A recovered still costs a segment locate, a
 * byte-range read and a decode of up to one keyframe interval — hundreds of
 * milliseconds, on a node that is also decoding live streams and writing
 * recordings. A notification that waited for one would trade a visible outcome
 * (the alert arrives) for an invisible one (its picture is native rather than
 * ≤640). That is the wrong trade every time, and it is exactly the kind of
 * regression nobody notices for weeks because the notification still works.
 *
 * ## What it checks
 *
 * No module on a DELIVERY path imports the recovery service. Delivery here
 * means the notification centre (rules, dispatcher, outbox, notifiers,
 * attachments) and the per-frame capture scheduler — everything whose latency
 * an operator experiences directly.
 *
 * The recovery service is meant to be reachable from exactly one place: the
 * embedding rebuild, a detached background pass with no deadline.
 *
 * ## Why an import check and not "look for an await"
 *
 * An import is present or absent — no judgement, no false positives, and a
 * guard with false positives gets deleted. It cannot see an indirect call
 * through three modules, and nothing conservative could; what it does guarantee
 * is that the obvious way to introduce the regression (import it where the
 * picture is being assembled, because that is where you are when you want a
 * better picture) fails the build with the reason attached.
 *
 * Usage: tsx scripts/check-recorded-still-off-delivery-path.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

/** The module a delivery path may not reach. */
const RECOVERY_MODULE = 'recorded-still'

/**
 * Directories whose latency an operator experiences directly.
 *
 * `capture-scheduler.ts` is named individually because it is the single funnel
 * for every native media fetch: a recovery reached from there would be on the
 * per-frame path, which is worse than being on the delivery path.
 */
const DELIVERY_PATHS: readonly string[] = [
  'packages/addon-post-analysis/src/notification-center',
  'packages/addon-post-analysis/src/pipeline-analytics/runtime/capture-scheduler.ts',
]

/** The one caller that is allowed to reach it, and why. */
const PERMITTED: readonly string[] = [
  'packages/addon-post-analysis/src/pipeline-analytics/index.ts',
  'packages/addon-post-analysis/src/pipeline-analytics/recorded-still-ports.ts',
]

interface Problem {
  readonly where: string
  readonly what: string
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  const stat = fs.statSync(dir)
  if (stat.isFile()) {
    if (dir.endsWith('.ts') || dir.endsWith('.tsx')) out.push(dir)
    return
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

const rel = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/')

function main(): void {
  const files: string[] = []
  for (const dir of DELIVERY_PATHS) sourceFiles(path.join(ROOT, dir), files)
  if (files.length === 0) {
    console.error(
      '\x1b[31m✘ no delivery-path files found — the paths in this guard have moved, fix them rather than deleting the guard\x1b[0m',
    )
    process.exit(1)
  }

  const problems: Problem[] = []
  for (const file of files) {
    const relative = rel(file)
    if (PERMITTED.includes(relative)) continue
    const source = fs.readFileSync(file, 'utf-8')
    // Comments are stripped first: a docblock explaining WHY this path does not
    // recover stills is exactly the kind of note that should be encouraged.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
    if (!new RegExp(`from\\s+['"][^'"]*${RECOVERY_MODULE}[^'"]*['"]`).test(code)) continue
    problems.push({
      where: relative,
      what: `imports \`${RECOVERY_MODULE}\` — a GOP re-decode on a delivery path`,
    })
  }

  if (problems.length === 0) {
    console.log('\x1b[32m  ✔ the recorded-still recovery stays off every delivery path\x1b[0m')
    return
  }
  console.error(`\x1b[31m✘ ${problems.length} delivery-path violation(s)\x1b[0m:`)
  for (const problem of problems) {
    console.error(`    ${problem.where}: ${problem.what}`)
  }
  console.error(
    '    → a notification must never wait on a GOP decode (operator directive, 2026-08-13).',
  )
  console.error(
    '      Recovery belongs to BACKGROUND passes. If a delivery genuinely needs better pixels,',
  )
  console.error(
    '      recover them ahead of time in a background pass and let the delivery read what landed.',
  )
  process.exit(1)
}

main()

#!/usr/bin/env tsx
/**
 * Silent-observation-drop guard — enforcement for D237
 * (docs/decisions/adr-0237-a-verification-must-be-able-to-say-unknown.md).
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `nodes.getCapUsageGraph` returned `[]` on 2026-08-25 while the sqlite engine
 * logged 39 717 calls a minute to a single collection. The whole cause was one
 * truthiness check:
 *
 *     const providerAddonId = opts.providerAddonIdForCap(cap)
 *     if (providerAddonId) {          // <- cross-process providers are null
 *       opts.observer({ callerAddonId, providerAddonId, ... })
 *     }
 *
 * The secondary field could not be resolved, so the observation was dropped
 * WHOLE — caller included, even though the caller is always known. An empty
 * diagnostic surface then reads as "nothing is happening", which is a claim,
 * and it was false. It cost two wrong attributions before anyone doubted the
 * mechanism instead of the system.
 *
 * ── What it looks for ──────────────────────────────────────────────────────
 * A bare `if (<identifier>)` whose body, within a few lines, emits to an
 * observation sink. That is the shape: a guard on the RESOLUTION deciding
 * whether the EVENT is recorded. It is textual on purpose — it catches the
 * shape, not every instance of the idea, and a construct that merely looks like
 * this is still worth a reviewer's eye.
 *
 * ── Why a ratchet ──────────────────────────────────────────────────────────
 * Same reasoning as `check-single-copy-layout.ts`: some of these are legitimate
 * (a sink that is genuinely optional), so the guard pins what exists today per
 * file and fails only when a file gets WORSE or a new file grows the shape.
 * When a count goes DOWN it says so and asks to be re-pinned, because an
 * unpinned improvement is an improvement that can silently come back.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const BASELINE = path.join(ROOT, 'scripts', 'silent-observation-baseline.json')

/** Calls that PUBLISH an observation. A drop here loses a fact for good. */
const SINKS = /\b(observer|recordCall|recordUsage|report|emitMetric|track)\s*\(/

/** `if (someIdentifier) {` — a bare truthiness gate, no comparison. */
const BARE_IF = /^\s*if\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{?\s*$/

/**
 * Control flags that mean "the operator stopped this", not "a field could not
 * be resolved".
 *
 * D237 is about an emit that DISAPPEARS because a secondary value was missing:
 * the primary fact is lost with it, and an empty diagnostic surface reads as a
 * claim that nothing happened. A cancellation branch is the opposite shape —
 * the emit exists BECAUSE the flag is true, and it reports a terminal state
 * (`phase: 'cancelled'`) before returning. Nothing is dropped.
 *
 * Both `location-discard-job.ts` files tripped the heuristic on exactly that
 * branch on 2026-09-09. Re-pinning the ratchet would have hidden them; a guard
 * that fails on the inverse of the shape it names is a guard people learn to
 * scroll past, and this repo has already had its CI `disabled_manually` once.
 */
const CONTROL_FLAG = /^(cancel|abort|stop|halt|shutdown|dispose|destroy)/i

/** How far after the `if` an emit still counts as guarded by it. */
const WINDOW = 6

interface Finding {
  readonly file: string
  readonly line: number
  readonly identifier: string
}

function sourceFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '*.ts', '*.tsx'], { cwd: ROOT, encoding: 'utf-8' })
  return out
    .split('\n')
    .filter((f) => f.length > 0 && !f.includes('__tests__') && !f.endsWith('.d.ts'))
}

function scan(file: string): Finding[] {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf-8').split('\n')
  const found: Finding[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = BARE_IF.exec(lines[i] ?? '')
    if (!m) continue
    const identifier = m[1] ?? ''
    if (CONTROL_FLAG.test(identifier)) continue
    for (let j = i + 1; j <= Math.min(i + WINDOW, lines.length - 1); j++) {
      if (SINKS.test(lines[j] ?? '')) {
        found.push({ file, line: i + 1, identifier })
        break
      }
    }
  }
  return found
}

function main(): void {
  const update = process.argv.includes('--update')
  const counts: Record<string, number> = {}
  const detail: Finding[] = []
  for (const file of sourceFiles()) {
    const f = scan(file)
    if (f.length > 0) {
      counts[file] = f.length
      detail.push(...f)
    }
  }

  if (update) {
    fs.writeFileSync(
      BASELINE,
      `${JSON.stringify(
        {
          _comment:
            'D237: observation emits gated on a bare truthiness check. A ratchet — counts may only go DOWN. Enforced by scripts/check-silent-observation-drop.ts.',
          files: counts,
        },
        null,
        2,
      )}\n`,
    )
    console.log(
      `✔ re-pinned ${Object.keys(counts).length} file(s) → ${path.relative(ROOT, BASELINE)}`,
    )
    return
  }

  const pinned: Record<string, number> = fs.existsSync(BASELINE)
    ? (JSON.parse(fs.readFileSync(BASELINE, 'utf-8')).files ?? {})
    : {}

  const worse: string[] = []
  const better: string[] = []
  for (const [file, n] of Object.entries(counts)) {
    const was = pinned[file] ?? 0
    if (n > was) worse.push(`  ${file}: ${was} → ${n}`)
    if (n < was) better.push(`  ${file}: ${was} → ${n}`)
  }
  for (const [file, was] of Object.entries(pinned)) {
    if (counts[file] === undefined && was > 0) better.push(`  ${file}: ${was} → 0`)
  }

  if (worse.length > 0) {
    console.error('✖ D237: a new observation emit is gated on a bare truthiness check.')
    console.error('  An emit dropped because a SECONDARY field could not be resolved loses the')
    console.error('  primary one too — and an empty diagnostic surface reads as "nothing is')
    console.error('  happening", which is a claim. Record it with the unknown half NAMED.')
    console.error(worse.join('\n'))
    for (const d of detail) {
      if (worse.some((w) => w.trimStart().startsWith(`${d.file}:`))) {
        console.error(`    ${d.file}:${d.line} — if (${d.identifier}) { … emit }`)
      }
    }
    process.exit(1)
  }

  if (better.length > 0) {
    console.log('✔ debt went DOWN — re-pin so it cannot come back:')
    console.log(better.join('\n'))
    console.log('  npx tsx scripts/check-silent-observation-drop.ts --update')
    process.exit(1)
  }

  console.log(
    `✔ D237 silent-observation-drop: ${Object.keys(pinned).length} pinned file(s), none worse`,
  )
}

main()

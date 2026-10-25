#!/usr/bin/env tsx
/**
 * Subsystem-map guard — keeps the ONE curated index input honest.
 *
 * `docs/subsystems.yaml` is the only hand-written index in this repository, so
 * it is the only one that can be wrong in a way no compiler catches. Three ways
 * it goes wrong, and this guard's answer to each:
 *
 *   1. A GLOB MATCHES NOTHING (hard failure). The subsystem outlived its code —
 *      a chapter describing a package that was renamed or deleted. Objective,
 *      one-line fix, so it blocks.
 *
 *   2. AN `owner-doc` DOES NOT RESOLVE (hard failure). The index would link the
 *      reader at a page that is not there. Same reasoning.
 *
 *   3. A SOURCE FILE BELONGS TO NO SUBSYSTEM (RATCHET). The taxonomy has a hole.
 *      Hard-failing would make every new package hostage to a docs edit — the
 *      treadmill D19 exists to remove — and "report only" is how the staleness
 *      count sat at 10 for a month with nobody reading the line. So CI passes
 *      `--max-orphans <n>` pinned at today's count: adding a file inside an
 *      already-claimed area changes nothing, and only a NEW unclaimed area
 *      fails. Claim it in `docs/subsystems.yaml` and the ceiling drops with it.
 *
 * Deliberately NOT checked here: whether a subsystem has any documentation at
 * all. That is the whole point of the generated index and is meant to be read,
 * not enforced — a guard that failed on ❌ would be a guard that forced someone
 * to write a page they had not researched.
 *
 * Usage:
 *   npx tsx scripts/check-subsystem-map.ts
 *   npx tsx scripts/check-subsystem-map.ts --committed-only --max-orphans 0   (CI)
 */
import * as path from 'node:path'
import { findSubsystemProblems } from './lib/subsystem-map.js'
import { loadSubsystemMap } from './lib/subsystem-map-repo.js'

const ROOT = path.resolve(import.meta.dirname, '..')

function maxOrphansArg(argv: readonly string[]): number | null {
  const index = argv.indexOf('--max-orphans')
  if (index < 0) return null
  const raw = argv[index + 1]
  const value = Number(raw)
  if (raw === undefined || !Number.isInteger(value) || value < 0) {
    console.error(`✘ --max-orphans needs a non-negative integer, got: ${String(raw)}`)
    process.exit(2)
  }
  return value
}

function main(): void {
  const maxOrphans = maxOrphansArg(process.argv)
  const map = loadSubsystemMap(ROOT, process.argv.includes('--committed-only'))
  const problems = findSubsystemProblems(map, maxOrphans)

  if (map.orphans.length > 0) {
    const verdict =
      maxOrphans === null || map.orphans.length <= maxOrphans ? 'not a failure' : 'OVER THE CEILING'
    console.log(
      `\x1b[33m⚠ ${String(map.orphans.length)} source file(s) in no subsystem\x1b[0m (${verdict}).`,
    )
    const byDir = new Map<string, number>()
    for (const f of map.orphans) {
      const dir = f.slice(0, f.lastIndexOf('/'))
      byDir.set(dir, (byDir.get(dir) ?? 0) + 1)
    }
    for (const [dir, n] of [...byDir].toSorted((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${dir} (${String(n)})`)
    }
  }

  const fatal = problems.filter((p) => p.kind !== 'orphans')
  if (fatal.length > 0) {
    console.error(`\x1b[31m✘ ${String(fatal.length)} subsystem map problem(s)\x1b[0m:`)
    for (const p of fatal) console.error(`    ${p.message}`)
    console.error(
      '\n  Fix `docs/subsystems.yaml` — a chapter is describing code that is not there.',
    )
    process.exit(1)
  }

  if (problems.some((p) => p.kind === 'orphans')) {
    console.error(
      `\x1b[31m✘ ${String(map.orphans.length)} source file(s) belong to no subsystem, ceiling is ` +
        `${String(maxOrphans)}\x1b[0m — a new area of the codebase is in no chapter.`,
    )
    console.error(
      '  Add it to an existing entry in `docs/subsystems.yaml`, or give it its own.\n' +
        '  Raising `--max-orphans` in .github/workflows/ci.yml is not a fix — the ratchet\n' +
        '  only goes down.',
    )
    process.exit(1)
  }

  if (maxOrphans !== null && maxOrphans > 0 && map.orphans.length < maxOrphans) {
    console.log(
      `  \x1b[33m↓\x1b[0m orphans down to ${String(map.orphans.length)} (ceiling ` +
        `${String(maxOrphans)}) — lower \`--max-orphans\` in .github/workflows/ci.yml`,
    )
  }

  console.log(
    `  ✔ ${String(map.subsystems.length)} subsystems, ${String(map.totalFiles)} source files, ` +
      `${String(map.uncoveredSubsystems)} with no document`,
  )
}

main()

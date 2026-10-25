#!/usr/bin/env tsx
/**
 * The boot-time inventories can NEVER refuse a boot — operator directive,
 * 2026-08-12: *"non dovremmo mai prevenire il boot"*.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `package-inventory.ts` (D45) and `addon-root-inventory.ts` exist to EXPLAIN a
 * confusing layout: which copy of `@camstack/system` runs, which rival addon
 * root is lying around. They are diagnostics. For a while both could also end
 * the process — `CAMSTACK_INVENTORY_STRICT=1` printed "refusing to boot on this
 * layout" and called `process.exit(1)`.
 *
 * That trade is wrong in this system whichever way it is set. A CamStack node
 * that will not start is a house with no recording and no notifications, and the
 * layouts in question — an image seed under `/opt`, a stale `/data/framework`,
 * a retired Electron data root — are all survivable at runtime and all fixed by
 * an operator with a shell, not by a dead container. Worse, the flag turns the
 * one component whose job is to explain a bad boot into a cause of one: strict
 * mode on a node with a rival addon root refuses BEFORE anything has logged why.
 *
 * So the rule is unconditional: report loudly, exit never. No flag, no env var,
 * no "but only when the layout has been cleaned".
 *
 * ── What is checked ────────────────────────────────────────────────────────
 * 1. The flag name appears nowhere in the shipped source. A reintroduced env var
 *    is the exact shape this removed.
 * 2. The inventory modules hold no process-ending call at all — they are pure by
 *    construction and must stay that way.
 * 3. The launcher's inventory region — between the `[inventory-diagnostics-begin]`
 *    and `[inventory-diagnostics-end]` sentinels — contains no `process.exit`,
 *    no `process.exitCode` and no `throw`. The sentinels must exist: deleting
 *    them to escape the check fails the guard too.
 *
 * Usage:
 *   tsx scripts/check-inventory-never-fatal.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const LAUNCHER = 'server/backend/src/launcher.ts'
const REGION_BEGIN = '[inventory-diagnostics-begin]'
const REGION_END = '[inventory-diagnostics-end]'

/** Diagnostic modules that must never be able to end a process. */
const INVENTORY_MODULES: readonly string[] = [
  'server/backend/src/package-inventory.ts',
  'server/backend/src/addon-root-inventory.ts',
]

/**
 * Files that ship. `docs/decisions/**` is excluded on purpose: a decision
 * records that the flag once existed, and rewriting it to satisfy a guard is
 * how a repo forgets why a rule is there. The session diary moved to the
 * planning repo.
 */
const SOURCE_GLOB_DIRS: readonly string[] = ['server', 'packages', 'scripts', 'templates']

/** A construct that can end the boot. */
interface FatalMarker {
  readonly pattern: RegExp
  readonly what: string
}

const FATAL_MARKERS: readonly FatalMarker[] = [
  { pattern: /process\.exit\s*\(/, what: 'process.exit(...)' },
  { pattern: /process\.exitCode\s*=/, what: 'process.exitCode = ...' },
  { pattern: /\bthrow\b/, what: 'throw' },
]

/** The env var that used to gate the refusal. It must not come back. */
const RETIRED_FLAG = 'CAMSTACK_INVENTORY_STRICT'

interface Failure {
  readonly file: string
  readonly line: number
  readonly detail: string
}

/**
 * Prose that QUOTES the rule does not break it.
 *
 * Every check below skips comments: the retired flag has to stay nameable in a
 * doc comment and in a test that explains what was removed, or the only way to
 * satisfy the guard is to delete the reason it exists. A commented-out
 * `process.env` read is inert; a live one is not, and that is what is caught.
 */
function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function read(rel: string): string | null {
  const abs = path.join(ROOT, rel)
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null
}

function walkTypeScript(dir: string, out: string[]): readonly string[] {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return out
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue
      }
      walkTypeScript(rel, out)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(rel)
    }
  }
  return out
}

/** The retired flag must appear in no shipped source file — including this one. */
function checkFlagIsGone(): readonly Failure[] {
  const failures: Failure[] = []
  const self = path.relative(ROOT, import.meta.filename)
  for (const dir of SOURCE_GLOB_DIRS) {
    for (const rel of walkTypeScript(dir, [])) {
      if (rel === self) continue
      const source = read(rel)
      if (source === null) continue
      source.split('\n').forEach((text, i) => {
        if (text.includes(RETIRED_FLAG) && !isCommentLine(text)) {
          failures.push({
            file: rel,
            line: i + 1,
            detail: `${RETIRED_FLAG} is retired — no flag may make an inventory fatal`,
          })
        }
      })
    }
  }
  return failures
}

function checkModulesArePure(): readonly Failure[] {
  const failures: Failure[] = []
  for (const rel of INVENTORY_MODULES) {
    const source = read(rel)
    if (source === null) {
      failures.push({
        file: rel,
        line: 0,
        detail: 'inventory module missing — guard cannot verify',
      })
      continue
    }
    source.split('\n').forEach((text, i) => {
      if (isCommentLine(text)) return
      for (const marker of FATAL_MARKERS) {
        if (marker.pattern.test(text)) {
          failures.push({
            file: rel,
            line: i + 1,
            detail: `${marker.what} in a diagnostic module — it must only describe, never decide`,
          })
        }
      }
    })
  }
  return failures
}

function checkLauncherRegion(): readonly Failure[] {
  const source = read(LAUNCHER)
  if (source === null) return [{ file: LAUNCHER, line: 0, detail: 'launcher missing' }]

  const lines = source.split('\n')
  const begin = lines.findIndex((l) => l.includes(REGION_BEGIN))
  const end = lines.findIndex((l) => l.includes(REGION_END))

  if (begin === -1 || end === -1 || end < begin) {
    return [
      {
        file: LAUNCHER,
        line: begin === -1 ? 0 : begin + 1,
        detail:
          `the ${REGION_BEGIN} / ${REGION_END} sentinels must bracket the inventory blocks — ` +
          'removing them does not remove the rule',
      },
    ]
  }

  const failures: Failure[] = []
  for (let i = begin; i <= end; i++) {
    const text = lines[i] ?? ''
    if (isCommentLine(text)) continue
    for (const marker of FATAL_MARKERS) {
      if (marker.pattern.test(text)) {
        failures.push({
          file: LAUNCHER,
          line: i + 1,
          detail: `${marker.what} inside the inventory region — the inventory may never refuse a boot`,
        })
      }
    }
  }
  return failures
}

function main(): void {
  const failures = [...checkFlagIsGone(), ...checkModulesArePure(), ...checkLauncherRegion()]

  if (failures.length > 0) {
    console.error('')
    console.error('✘ a boot-time inventory can refuse a boot:')
    for (const f of failures) {
      console.error(`    ${f.file}:${f.line} — ${f.detail}`)
    }
    console.error('')
    console.error('  Operator directive, 2026-08-12: "non dovremmo mai prevenire il boot".')
    console.error('  These checks EXPLAIN a bad layout; a node that will not start explains')
    console.error('  nothing and records nothing. Log the banner, then continue booting.')
    console.error('  See docs/decisions/adr-0045.md § Enforcement.')
    process.exit(1)
  }

  console.log(
    `✔ inventories are never fatal: ${INVENTORY_MODULES.length} pure module(s), launcher region clean, ${RETIRED_FLAG} absent`,
  )
}

main()

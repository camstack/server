#!/usr/bin/env tsx
/**
 * Addon-footprint guard on the BUILT output (D28) — the addon twin of
 * `check-runner-dist-barrel-free.ts`.
 *
 * ── The bug class ──────────────────────────────────────────────────────────
 * An addon bundles `@camstack/types`. Reaching `ALL_CAPABILITY_DEFINITIONS`
 * from addon server code inlines the Zod schema graph of every capability
 * (~11,000 builder calls) and evaluates it when the addon loads: +~100 MB of
 * private heap in every runner that holds it. Two addons did, for two
 * lookups, and nothing noticed: the suite was green and the runners were
 * fat. The facts addons need are served as codegen'd plain data on
 * `@camstack/types/addon` (`CAP_ADVANCE_FIELDS`, `CAP_STATE_LEAVES`).
 *
 * ── What it checks (needs every addon built) ───────────────────────────────
 * For each addon declared in a `packages/<pkg>/package.json` manifest
 * (`camstack.addons[].entry`):
 * 1. Static: the dist closure of the entry never names `ALL_CAPABILITY_DEFINITIONS`
 *    (comments ignored).
 *    Not a schema-call count: the bundler inlines zod as bare `object(` /
 *    `string(` calls, so `z.object(` does not occur in an addon's dist.
 * 2. Runtime: load the entry on top of the addon-runner in a fresh node under
 *    `--max-semi-space-size=2`, two GCs, and compare `heapUsed` with the runner
 *    alone. Growth above {@link DEFAULT_MAX_GROWTH_MB} fails unless
 *    `scripts/addon-dist-footprint-budgets.json` grants that addon a larger
 *    budget WITH a reason. A budget no addon claims is itself a failure.
 *
 * An addon whose entry is not built is skipped with a note; a run that finds NO
 * built addon at all fails (a guard that measured nothing is not green).
 * An entry that cannot be loaded standalone (a native dependency missing) is
 * reported as unmeasured and still gets the static check.
 *
 * 3. Expiry: every budget carries a required `expires` (ISO date). A missing,
 *    malformed or past date fails the guard — renew deliberately with a new date,
 *    or fix the addon. A "follow-up" exception must not outlive the schema graph.
 *
 * Run: npx tsx scripts/check-addon-dist-footprint.ts [--addons a,b]
 * `--addons` takes package dirs (`addon-benchmark`) or full keys
 * (`addon-benchmark:benchmark`); only those addons are measured. `verify:push`
 * uses it to check just the addons a change touched.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { distClosure, probeClosure } from './check-runner-dist-barrel-free.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER = path.join(ROOT, 'packages/system/dist/addon-runner.js')
const BUDGETS_FILE = path.join(ROOT, 'scripts/addon-dist-footprint-budgets.json')

/** Heap an addon may add on top of the bare runner unless it holds a budget. */
export const DEFAULT_MAX_GROWTH_MB = 60

/**
 * Packages whose addons are not forked runners. `@camstack/system` ships the
 * kernel's builtin addons (device-manager, composer, local-auth, …); they run
 * INSIDE the hub process, which holds the cap schema graph for its own routers,
 * so a second copy is not what this guard measures.
 */
export const IN_HUB_PACKAGES: ReadonlySet<string> = new Set(['system'])

export const FORBIDDEN_IDENTIFIER = 'ALL_CAPABILITY_DEFINITIONS'

export interface AddonEntry {
  readonly key: string
  readonly entry: string
}

export interface Budget {
  readonly maxGrowthMb: number
  readonly reason: string
  /** ISO date (YYYY-MM-DD) after which the exception no longer holds. */
  readonly expires: string
}

export type Budgets = Readonly<Record<string, Budget>>

/** Blank out comments so prose that names the identifier does not trip the scan. */
export function stripJsComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:'"`\\])\/\/[^\n]*/g,
      (m, lead: string) => lead + ' '.repeat(m.length - lead.length),
    )
}

/** Closure files whose code (not comments) names {@link FORBIDDEN_IDENTIFIER}. */
export function filesNamingForbidden(files: readonly string[]): readonly string[] {
  const pattern = new RegExp(`\\b${FORBIDDEN_IDENTIFIER}\\b`)
  return files.filter((f) => pattern.test(stripJsComments(fs.readFileSync(f, 'utf-8'))))
}

interface ManifestShape {
  readonly camstack?: {
    readonly addons?: readonly {
      readonly id?: string
      readonly entry?: string
    }[]
  }
}

/** Every `<package>:<addon id>` with a server entry, from the workspace manifests. */
export function discoverAddonEntries(root: string): readonly AddonEntry[] {
  const out: AddonEntry[] = []
  const packagesDir = path.join(root, 'packages')
  for (const pkg of fs.readdirSync(packagesDir).sort()) {
    const manifestPath = path.join(packagesDir, pkg, 'package.json')
    if (IN_HUB_PACKAGES.has(pkg) || !fs.existsSync(manifestPath)) continue
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as ManifestShape
    for (const addon of manifest.camstack?.addons ?? []) {
      if (addon.id === undefined || addon.entry === undefined) continue
      out.push({
        key: `${pkg}:${addon.id}`,
        entry: path.resolve(packagesDir, pkg, addon.entry),
      })
    }
  }
  return out
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Reject a budget without a numeric ceiling above the default, a real reason and
 * an `expires` date that is valid and not in the past (`today`, UTC midnight).
 */
export function validateBudgets(
  budgets: Budgets,
  known: ReadonlySet<string>,
  today: Date = new Date(),
): readonly string[] {
  const problems: string[] = []
  const todayIso = today.toISOString().slice(0, 10)
  for (const [key, b] of Object.entries(budgets)) {
    if (!known.has(key)) problems.push(`budget "${key}" names no addon in any manifest`)
    if (!(b.maxGrowthMb > DEFAULT_MAX_GROWTH_MB)) {
      problems.push(
        `budget "${key}" must exceed the default (${DEFAULT_MAX_GROWTH_MB} MB) or be removed`,
      )
    }
    if (typeof b.reason !== 'string' || b.reason.trim().length < 20) {
      problems.push(`budget "${key}" needs a reason (what is legitimately heavy, and why)`)
    }
    if (
      typeof b.expires !== 'string' ||
      !ISO_DATE.test(b.expires) ||
      Number.isNaN(Date.parse(b.expires))
    ) {
      problems.push(
        `budget "${key}" needs an "expires" ISO date (YYYY-MM-DD): a budget is a dated exception`,
      )
    } else if (b.expires < todayIso) {
      problems.push(
        `budget "${key}" expired on ${b.expires}: renew it deliberately with a new "expires" date, or fix the addon`,
      )
    }
  }
  return problems
}

/** Parse `--addons a,b` (or `--addons=a,b`); undefined when the flag is absent. */
export function parseAddonsFilter(argv: readonly string[]): readonly string[] | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value =
      arg === '--addons' ? argv[i + 1] : arg?.startsWith('--addons=') ? arg.slice(9) : undefined
    if (value === undefined) continue
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return undefined
}

/** Keep the entries named by `filter` (package dir or full key); all when undefined. */
export function selectEntries(
  entries: readonly AddonEntry[],
  filter: readonly string[] | undefined,
): readonly AddonEntry[] {
  if (filter === undefined) return entries
  const wanted = new Set(filter)
  return entries.filter((e) => wanted.has(e.key) || wanted.has(e.key.split(':')[0] ?? e.key))
}

export function allowedGrowthMb(key: string, budgets: Budgets): number {
  return budgets[key]?.maxGrowthMb ?? DEFAULT_MAX_GROWTH_MB
}

function loadBudgets(): Budgets {
  if (!fs.existsSync(BUDGETS_FILE)) return {}
  return JSON.parse(fs.readFileSync(BUDGETS_FILE, 'utf-8')) as Budgets
}

function main(): void {
  if (!fs.existsSync(RUNNER)) {
    // eslint-disable-next-line no-console
    console.error(`✗ ${path.relative(ROOT, RUNNER)} is missing — build packages/system first`)
    process.exit(2)
  }
  const allEntries = discoverAddonEntries(ROOT)
  const filter = parseAddonsFilter(process.argv.slice(2))
  const entries = selectEntries(allEntries, filter)
  if (filter !== undefined && entries.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `✔ addon-dist-footprint guard: --addons ${filter.join(',')} names no addon entry — nothing to measure`,
    )
    return
  }
  const budgets = loadBudgets()
  const failures: string[] = [...validateBudgets(budgets, new Set(allEntries.map((e) => e.key)))]
  const notes: string[] = []
  const baseline = probeClosure(RUNNER, [RUNNER])
  if (!entries.some((e) => fs.existsSync(e.entry))) {
    failures.push(
      'no addon entry is built — the guard measured nothing (build the workspace first)',
    )
  }

  for (const { key, entry } of entries) {
    if (!fs.existsSync(entry)) {
      notes.push(`${key}: not built — skipped`)
      continue
    }
    const closure = distClosure(entry)
    for (const f of filesNamingForbidden(closure)) {
      failures.push(
        `${key}: ${path.relative(ROOT, f)} names ${FORBIDDEN_IDENTIFIER} (the whole cap schema graph)`,
      )
    }
    let growth: number
    try {
      growth = probeClosure(RUNNER, [entry]).heapUsedMb - baseline.heapUsedMb
    } catch {
      notes.push(`${key}: could not be loaded standalone — runtime probe skipped`)
      continue
    }
    const limit = allowedGrowthMb(key, budgets)
    if (growth > limit) {
      failures.push(
        `${key}: heapUsed grew ${growth.toFixed(1)} MB over the runner (limit ${limit} MB` +
          `${budgets[key] === undefined ? '' : `, budgeted: ${budgets[key].reason}`})`,
      )
    }
    notes.push(`${key}: +${growth.toFixed(1)} MB (limit ${limit})`)
  }

  for (const n of notes) {
    // eslint-disable-next-line no-console
    console.log(`  ${n}`)
  }
  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n✗ addon-dist-footprint guard (D28): a BUILT addon is heavier than its budget.\n` +
        `  An addon must not import ALL_CAPABILITY_DEFINITIONS or a barrel value that builds the cap schema graph\n` +
        `  (+~100 MB per runner): add the fact to scripts/generate-addon-cap-facts.ts and read it from\n` +
        `  '@camstack/types/addon'. A legitimately heavy addon is listed with a reason in\n` +
        `  scripts/addon-dist-footprint-budgets.json (reason + a dated "expires"). See docs/decisions/adr-0028.md.\n`,
    )
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.error(`  - ${f}`)
    }
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(
    `✔ addon-dist-footprint guard: ${entries.length} addon entries, runner baseline heapUsed ${baseline.heapUsedMb.toFixed(1)} MB`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

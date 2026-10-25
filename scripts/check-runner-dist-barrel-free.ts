#!/usr/bin/env tsx
/**
 * Runner-footprint guard on the BUILT output (D28) — the twin of
 * `check-runner-barrel-free.ts`, which reads SOURCE.
 *
 * ── Why a second guard ─────────────────────────────────────────────────────
 * The source guard answers "does any runner file import the barrel?". It cannot
 * answer the question that actually costs memory: "does the file the runner
 * will `require()` carry the Zod schema graph?". `bundleTypesMainEntry: true`
 * inlines the whole `@camstack/types` barrel (a ~2.4 MB chunk, ~2,500
 * `z.object(` calls, ~90-115 MB of private heap once evaluated) into system's
 * dist, and a bundler may place it in any chunk the runner shares with hub-only
 * code. Source can look clean while the chunk graph is not; a re-export the
 * source guard did not follow did exactly that for days.
 *
 * ── What it checks (needs `packages/system` built) ─────────────────────────
 * 1. Static: walk the `require("./x")` / `from "./x"` / `import("./x")` closure
 *    of `dist/addon-runner.js` (and `.mjs`). Fail when a file in it holds the
 *    schema graph.
 *    MARKER = schema-call density: more than {@link MAX_SCHEMA_CALLS} occurrences of
 *    a zod builder call (`z.object(`, `z.enum(`, …). Why density and not the
 *    `//#region ../types/dist/…` banner: rolldown writes that banner for ANY
 *    inlined `@camstack/types` module, and a small schema-free leaf inlined on
 *    purpose is fine; what costs memory is the schema graph itself. The
 *    barrel carries ~2,500 builder calls; a runner file that needs a handful
 *    (a config schema) stays far below the threshold.
 * 2. Runtime: require every closure file in a fresh node under
 *    `--max-semi-space-size=2` (the production runner flag), collect twice, and
 *    fail when `heapUsed` exceeds {@link MAX_HEAP_USED_MB} or RSS exceeds
 *    {@link MAX_RSS_MB}. This catches what the
 *    marker misses (a dependency that is heavy for another reason) and prints
 *    the RSS/heap numbers either way. Healthy: ~10-13 MB heap, ~67-71 MB RSS.
 *
 * The same two checks run over `dist/addon-utils.js` (see GUARDED_DIST_ENTRIES).
 *
 * Run: npx tsx scripts/check-runner-dist-barrel-free.ts
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'packages/system/dist')

/** Healthy runner closures have a handful; the barrel has ~2,500. */
export const MAX_SCHEMA_CALLS = 100
/** A healthy closure measures 10-13 MB; the barrel adds 90-115 MB. */
export const MAX_HEAP_USED_MB = 30
/**
 * Inlined into the one runner file the barrel can show only ~20 MB of heap
 * (V8 compiles function bodies lazily) but 190 MB of RSS, so RSS is checked too.
 * Healthy ~70 MB, barrel 190-205 MB; the margin absorbs platform differences.
 */
export const MAX_RSS_MB = 120

const SCHEMA_CALL = /\bz\d*\.(?:object|enum|string|number|array|union|literal|record|boolean)\(/g

/** Relative specifiers a built file loads: require, static import, re-export, dynamic import. */
const RELATIVE_REF =
  /(?:require\(\s*|\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/g

export function distClosure(entry: string): readonly string[] {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    for (const m of fs.readFileSync(file, 'utf-8').matchAll(RELATIVE_REF)) {
      const next = path.resolve(path.dirname(file), m[1])
      if (fs.existsSync(next) && fs.statSync(next).isFile() && !seen.has(next)) queue.push(next)
    }
  }
  return [...seen]
}

export interface SchemaHit {
  readonly file: string
  readonly calls: number
}

export function schemaHeavyFiles(files: readonly string[], limit = MAX_SCHEMA_CALLS): SchemaHit[] {
  const hits: SchemaHit[] = []
  for (const file of files) {
    const calls = (fs.readFileSync(file, 'utf-8').match(SCHEMA_CALL) ?? []).length
    if (calls > limit) hits.push({ file, calls })
  }
  return hits
}

export interface Probe {
  readonly rssMb: number
  readonly heapUsedMb: number
}

// The entry boots a runner on load (`main()` reads CAMSTACK_RUNNER_* and exits
// when they are missing). Loading the entry is the point — the closure may be a
// single file — so `process.exit` is turned into a throw and the resulting
// rejection swallowed: every import has been evaluated by then, which is the
// memory being measured.
const PROBE_SOURCE = `
const files = JSON.parse(process.argv[1])
const realExit = process.exit.bind(process)
process.exit = () => { throw new Error('probe: runner called process.exit') }
process.on('unhandledRejection', () => {})
process.on('uncaughtException', () => {})
console.error = () => {}
for (const f of files) {
  try { require(f) } catch (e) { if (!String(e && e.message).startsWith('probe:')) throw e }
}
setImmediate(() => {
  global.gc(); global.gc()
  const m = process.memoryUsage()
  process.stdout.write(JSON.stringify({ rssMb: m.rss / 1048576, heapUsedMb: m.heapUsed / 1048576 }), () => realExit(0))
})
`

/** Require the whole closure (entry first) in a fresh node, then 2 GCs. */
export function probeClosure(entry: string, files: readonly string[]): Probe {
  const toLoad = [entry, ...files.filter((f) => f !== entry)]
  const res = spawnSync(
    process.execPath,
    ['--max-semi-space-size=2', '--expose-gc', '-e', PROBE_SOURCE, JSON.stringify(toLoad)],
    {
      cwd: path.dirname(entry),
      encoding: 'utf-8',
      timeout: 60_000,
      env: { PATH: process.env['PATH'] ?? '' },
    },
  )
  if (res.status !== 0) {
    throw new Error(`probe failed to load the runner closure:\n${res.stderr}`)
  }
  return JSON.parse(res.stdout) as Probe
}

/**
 * The built entries whose closure must stay schema-free. `addon-utils` is
 * required by every addon that downloads a model or registers a custom action
 * (7 hub runners): one bare `@camstack/types` import in its source inlined the
 * 2.4 MB barrel chunk and cost each of them ~105 MB of heap.
 */
export const GUARDED_DIST_ENTRIES: readonly string[] = ['addon-runner', 'addon-utils']

function checkEntry(name: string, failures: string[], lines: string[]): void {
  const entry = path.join(DIST, `${name}.js`)
  if (!fs.existsSync(entry)) {
    // eslint-disable-next-line no-console
    console.error(`✗ ${path.relative(ROOT, entry)} is missing — build packages/system first`)
    process.exit(2)
  }
  for (const e of [entry, path.join(DIST, `${name}.mjs`)]) {
    if (!fs.existsSync(e)) continue
    for (const h of schemaHeavyFiles(distClosure(e))) {
      failures.push(
        `${path.relative(ROOT, h.file)} holds ${h.calls} zod builder calls and is in the closure of ${path.basename(e)} (limit ${MAX_SCHEMA_CALLS})`,
      )
    }
  }

  const closure = distClosure(entry)
  const probe = probeClosure(entry, closure)
  if (probe.rssMb > MAX_RSS_MB) {
    failures.push(`${name} closure RSS ${probe.rssMb.toFixed(1)} MB > ${MAX_RSS_MB} MB`)
  }
  if (probe.heapUsedMb > MAX_HEAP_USED_MB) {
    failures.push(
      `${name} closure heapUsed ${probe.heapUsedMb.toFixed(1)} MB > ${MAX_HEAP_USED_MB} MB`,
    )
  }
  lines.push(
    `${name}: ${closure.length} closure files, no schema graph; ` +
      `RSS ${probe.rssMb.toFixed(1)} MB, heapUsed ${probe.heapUsedMb.toFixed(1)} MB (limits ${MAX_HEAP_USED_MB}/${MAX_RSS_MB} MB)`,
  )
}

function main(): void {
  const failures: string[] = []
  const lines: string[] = []
  for (const name of GUARDED_DIST_ENTRIES) checkEntry(name, failures, lines)

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n✗ runner-dist-barrel-free guard (D28): a BUILT guarded entry loads the @camstack/types schema barrel\n` +
        `  (~90-115 MB private heap per process that loads it). The runner must have its own build entry with no\n` +
        `  chunk shared with hub-only code — see the addon-runner block in packages/system/vite.config.ts\n` +
        `  and docs/decisions/adr-0028.md. Guarded: ${GUARDED_DIST_ENTRIES.join(', ')}. Find the bare\n` +
        `  '@camstack/types' value import with scripts/check-runner-barrel-free.ts.\n`,
    )
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.error(`  - ${f}`)
    }
    for (const l of lines) {
      // eslint-disable-next-line no-console
      console.error(`  measured ${l}`)
    }
    process.exit(1)
  }
  for (const l of lines) {
    // eslint-disable-next-line no-console
    console.log(`✔ runner-dist-barrel-free guard: ${l}`)
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

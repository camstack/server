#!/usr/bin/env tsx
/**
 * Runtime-state row writers guard (D677) — a device's runtime-state row is
 * written by exactly two callers, and each reads the row before it replaces it.
 *
 * ## The failure this catches
 *
 * `writeDeviceRuntimeState` REPLACES the whole row. At hub boot the mirror's
 * writer replaced rows it had never read with the one or two slices memory
 * held — 159 shrinks on 15 cameras at 65 of 82 restarts, and not one log line.
 * The fix makes the mirror's writer read first. That holds only while the
 * writer is the only door: the call is on every addon's `ctx.settings`, and a
 * new caller anywhere would be a writer that never read the row.
 *
 * ## What it checks
 *
 * Outside tests, with comments stripped:
 *
 * 1. Every REFERENCE to `writeDeviceRuntimeState` / `setDeviceRuntimeState`
 *    — a call, a destructuring, a bracket access, a string naming it — is
 *    counted per file, and the count must equal {@link METHOD_PINS}. A method
 *    or property DEFINITION at the start of a line (`async
 *    writeDeviceRuntimeState(`, `writeDeviceRuntimeState: (…) =>`) is not a
 *    reference; everything after it on the line still is. Pinning the COUNT,
 *    not the file, is what keeps a new call inside an allowed file visible.
 * 2. The collection literal `'device-runtime-state'` (any quote) appears only
 *    in the storage backends that implement the surface, with pinned counts
 *    ({@link COLLECTION_PINS}) — a `door.set({ collection: … })` or a
 *    `writeBlob('device-runtime-state', …)` elsewhere is a row writer around
 *    the door.
 *
 * A pin that no longer matches — up OR down — fails: a removed reference
 * lowers the pin, so the next added one cannot hide in the slack.
 *
 * Usage: tsx scripts/check-runtime-state-row-writers.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

interface Pin {
  readonly count: number
  readonly why: string
}

/** Files allowed to reference the write methods, and exactly how often. */
const METHOD_PINS: Readonly<Record<string, Pin>> = {
  'packages/system/src/builtins/device-manager/mirror-row-writer.ts': {
    count: 2,
    why: 'THE row writer: one call (`writeRow`, every path reads the row first, D677) and the name in its failure log line',
  },
  'packages/system/src/builtins/device-manager/migrate-hardware-state.ts': {
    count: 3,
    why: 'the migration swap: reads both rows, writes them swapped under the writer hold (two calls) and names the method in its settings Pick type',
  },
  'packages/system/src/kernel/config-manager.ts': {
    count: 2,
    why: 'the settings surface forwarding to its store: the sync store, the view delegating to the active backend',
  },
  'packages/system/src/kernel/store-settings-view.ts': {
    count: 1,
    why: 'the store-backed view (split out of config-manager.ts by D675): forwards the full blob its caller read-then-built',
  },
  'server/backend/src/core/addon/addon-registry.service.ts': {
    count: 1,
    why: 'a duck-type check that the backend implements the method — not a call',
  },
}

/** Files allowed to name the runtime-state collection, and exactly how often. */
const COLLECTION_PINS: Readonly<Record<string, Pin>> = {
  'packages/system/src/kernel/settings-door-view.ts': {
    count: 3,
    why: 'the async door backend of the settings surface (get / set / clear)',
  },
  'packages/system/src/kernel/moleculer/addon-context-factory.ts': {
    count: 3,
    why: 'the forked-runner backend of the settings surface (read / write / clear)',
  },
  'packages/system/src/builtins/sqlite-storage/sqlite-settings-backend.ts': {
    count: 7,
    why: 'the sqlite engine: the collection declaration and its get / set / clear statements',
  },
}

const DEFINITION_AT_LINE_START = /^\s*(?:async\s+)?(?:write|set)DeviceRuntimeState\s*[(:?<]/
const METHOD_REFERENCE = /\b(?:write|set)DeviceRuntimeState\b/g
const COLLECTION_LITERAL = /['"`]device-runtime-state\b/g

const SCAN_ROOTS: readonly string[] = ['packages', 'server']

function isTestPath(rel: string): boolean {
  return (
    rel.includes('/__tests__/') ||
    /\.(?:spec|test)\.tsx?$/.test(rel) ||
    rel.endsWith('.guard.ts') ||
    rel.includes('/test/') ||
    rel.includes('/e2e/')
  )
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
}

/** Blank out comments, keeping line numbers. A `//` inside a string is left alone. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

interface Hit {
  readonly line: number
  readonly text: string
}

interface FileHits {
  readonly methods: readonly Hit[]
  readonly collection: readonly Hit[]
}

function hitsIn(source: string): FileHits {
  const methods: Hit[] = []
  const collection: Hit[] = []
  stripComments(source)
    .split('\n')
    .forEach((text, index) => {
      const rest = text.replace(DEFINITION_AT_LINE_START, '')
      for (const _ of rest.matchAll(METHOD_REFERENCE)) {
        methods.push({ line: index + 1, text: text.trim() })
      }
      for (const _ of text.matchAll(COLLECTION_LITERAL)) {
        collection.push({ line: index + 1, text: text.trim() })
      }
    })
  return { methods, collection }
}

function listSources(): readonly string[] {
  const files: string[] = []
  for (const root of SCAN_ROOTS) {
    const base = path.join(ROOT, root)
    if (!fs.existsSync(base)) continue
    for (const pkg of fs.readdirSync(base, { withFileTypes: true })) {
      if (pkg.isDirectory()) sourceFiles(path.join(base, pkg.name, 'src'), files)
    }
  }
  return files
}

function judge(
  kind: string,
  rel: string,
  hits: readonly Hit[],
  pins: Readonly<Record<string, Pin>>,
): readonly string[] {
  const pin = pins[rel]
  const expected = pin?.count ?? 0
  if (hits.length === expected) return []
  const lines = hits.map((h) => `      ${rel}:${h.line} — ${h.text}`)
  return [
    `  ${rel}: ${hits.length} ${kind} reference(s), pinned ${expected}` +
      (pin ? ` (${pin.why})` : ' (not an allowed file)'),
    ...lines,
  ]
}

function main(): void {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const full of listSources()) {
    const rel = path.relative(ROOT, full).split(path.sep).join('/')
    if (isTestPath(rel)) continue
    const hits = hitsIn(fs.readFileSync(full, 'utf8'))
    if (hits.methods.length > 0 || rel in METHOD_PINS) {
      seen.add(rel)
      problems.push(...judge('write-method', rel, hits.methods, METHOD_PINS))
    }
    if (hits.collection.length > 0 || rel in COLLECTION_PINS) {
      seen.add(rel)
      problems.push(...judge('collection-literal', rel, hits.collection, COLLECTION_PINS))
    }
  }
  for (const rel of [...Object.keys(METHOD_PINS), ...Object.keys(COLLECTION_PINS)]) {
    if (!seen.has(rel)) problems.push(`  ${rel}: pinned, but the file is gone — update the pin`)
  }
  if (problems.length === 0) {
    console.log(
      '  ✔ runtime-state rows: written only by the row writer and the migration swap, both of which read first (D677)',
    )
    return
  }
  console.error('\x1b[31m✘ runtime-state row writers do not match their pins\x1b[0m')
  for (const p of problems) console.error(p)
  console.error(
    '\n  A runtime-state row write REPLACES the whole row. A caller that did not read the\n' +
      '  row first erases every cap it does not hold — exactly how 15 cameras lost their\n' +
      '  restored state at hub boot (D677). Write through `deviceState.setCapSlice`. If\n' +
      '  this really is a reference that reads first (or plumbing), update the pin in\n' +
      '  scripts/check-runtime-state-row-writers.ts with its reason.',
  )
  process.exit(1)
}

main()

#!/usr/bin/env tsx
/**
 * Addon-process guard (D877) - `addons.list` never reports a LITERAL process mode.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * Until 2026-10-18 `AddonRegistryService.listAddons()` stamped every initialized
 * addon `process: { mode: 'in-process', state: 'running', pid: <hub pid> }` - a
 * literal, whatever its runner was doing. On 2026-10-17 twenty-eight refused
 * runners and nineteen dead ones showed as healthy on the Addons page for four
 * hours.
 *
 * The truth lives in the process service. `describeAddonProcess`
 * (`server/backend/src/core/addon/addon-process-view.ts`) is the ONE place that
 * turns a runner row, or the absence of one, into the `process` field.
 *
 * ── What it checks ─────────────────────────────────────────────────────────
 * No file under `server/backend/src` other than `addon-process-view.ts` contains
 * the property `mode: 'in-process'` (a union such as `'in-process' | 'isolated'`
 * is a type, not a value, and is allowed). Comments are stripped first.
 *
 * Usage: npx tsx scripts/check-no-literal-addon-process-mode.ts
 */
import { readFileSync, globSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const ALLOWED = 'server/backend/src/core/addon/addon-process-view.ts'
const LITERAL = /\bmode:\s*'in-process'(?!\s*\|)/g

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

export function findLiteralProcessModes(source: string): readonly number[] {
  const text = stripComments(source)
  return [...text.matchAll(LITERAL)].map((m) => text.slice(0, m.index).split('\n').length)
}

if (
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
) {
  const files = globSync('server/backend/src/**/*.ts', { cwd: ROOT })
    .filter((f) => !f.includes('/__tests__/') && !f.endsWith('.spec.ts') && f !== ALLOWED)
    .map((f) => join(ROOT, f))
  const violations = files.flatMap((file) =>
    findLiteralProcessModes(readFileSync(file, 'utf-8')).map(
      (line) => `${relative(ROOT, file)}:${line}`,
    ),
  )
  if (violations.length > 0) {
    console.error("✖ literal `mode: 'in-process'` outside addon-process-view.ts\n")
    for (const v of violations) console.error(`  ${v}`)
    console.error(
      "\nA process field is the runner's real state: build it with describeAddonProcess()\n" +
        '(core/addon/addon-process-view.ts) from the process service rows. A literal made\n' +
        '28 refused and 19 dead runners look healthy for four hours (D877).',
    )
    process.exit(1)
  }
  console.log(`✔ addon-process guard: ${files.length} files, no literal process mode`)
}

#!/usr/bin/env tsx
/**
 * Authored-field guard — **a field an operator is meant to set has a control
 * that sets it, or it does not exist.**
 *
 * ## The failure this catches
 *
 * `RecordingTriggers.sensorDeviceIds` shipped on 2026-08 with a schema, a
 * recorder that listened on it, a cascade for it, and NO control anywhere: the
 * operator saw Motion and Audio on an events band and asked where the sensors
 * were. It was the fourth field of that shape found in one week ("built but
 * unreachable"). Nothing fails on such a field: it type-checks, its tests
 * pass, the code that reads it is correct — it is simply never written.
 *
 * ## What it checks
 *
 * A `z.object({...})` schema preceded by the line `// @authored-by-ui` in
 * `packages/types/src/interfaces/**` declares that every one of its top-level
 * keys is set by an operator through a UI. For each such key, some `.tsx`
 * under the UI roots (`packages/ui-library/src`, `packages/addon-admin-ui/src`,
 * `packages/addon-*\/src/widgets`, `camstack/src`, `camstack/embed/src`) must
 * mention the key as a property or string token. A key nobody mentions is
 * reported with its schema. Textual on purpose, like the sibling guards.
 *
 * ## When the viewer is not on disk
 *
 * `camstack/` is a submodule and is absent in a fresh worktree and in CI. Two
 * of the five UI roots live inside it, so a field whose only control is in the
 * viewer is INVISIBLE to this guard there — and "no UI sets this field" was
 * being printed from a search that never opened the viewer. That is the D315
 * mistake: not-found must not be reported as not-present when the place it
 * would be found was never read.
 *
 * So an unmatched key is a FAILURE only when every UI root was searchable. With
 * the viewer absent it is reported as UNDECIDED, loudly, and does not fail —
 * the guard has an authoritative run (a developer tree with the submodule) and
 * that is where the verdict belongs.
 *
 * Usage: tsx scripts/check-authored-fields-reachable.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCHEMA_ROOT = path.join(ROOT, 'packages/types/src/interfaces')
const UI_ROOTS = [
  'packages/ui-library/src',
  'packages/addon-admin-ui/src',
  'camstack/src',
  'camstack/embed/src',
]
const MARKER = '// @authored-by-ui'

interface AuthoredSchema {
  readonly file: string
  readonly name: string
  readonly keys: readonly string[]
}

function walk(dir: string, out: string[], pick: (name: string) => boolean): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__')
      continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out, pick)
    else if (pick(entry.name)) out.push(full)
  }
}

/** Top-level keys of the `z.object({` that follows the marker line. */
function readAuthoredSchemas(file: string): readonly AuthoredSchema[] {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const found: AuthoredSchema[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]?.trim() !== MARKER) continue
    const header = lines[i + 1] ?? ''
    const name = /export const (\w+) = z\s*\.object\(\{/.exec(header)?.[1]
    if (name === undefined) {
      throw new Error(
        `${path.relative(ROOT, file)}:${i + 2}: marker must precede \`export const X = z.object({\``,
      )
    }
    const keys: string[] = []
    let depth = 1
    for (let j = i + 2; j < lines.length && depth > 0; j += 1) {
      const line = lines[j] ?? ''
      const key = /^  (\w+):/.exec(line)?.[1]
      if (key !== undefined && depth === 1) keys.push(key)
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    }
    found.push({ file: path.relative(ROOT, file), name, keys })
  }
  return found
}

/** UI roots that are not on disk — every one of them is inside `camstack/`. */
const unsearchableRoots: readonly string[] = UI_ROOTS.filter(
  (r) => !fs.existsSync(path.join(ROOT, r)),
)

function uiSources(): readonly string[] {
  const files: string[] = []
  for (const root of UI_ROOTS) walk(path.join(ROOT, root), files, (n) => n.endsWith('.tsx'))
  const widgetRoots = fs
    .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('addon-'))
    .map((e) => path.join(ROOT, 'packages', e.name, 'src/widgets'))
  for (const root of widgetRoots) walk(root, files, (n) => n.endsWith('.tsx'))
  return files
}

const schemaFiles: string[] = []
walk(SCHEMA_ROOT, schemaFiles, (n) => n.endsWith('.ts'))
const schemas = schemaFiles.flatMap(readAuthoredSchemas)
const sources = uiSources().map((f) => fs.readFileSync(f, 'utf8'))

const missing: string[] = []
for (const schema of schemas) {
  for (const key of schema.keys) {
    const token = new RegExp(`(?<![\\w$])${key}(?![\\w$])`)
    if (!sources.some((src) => token.test(src)))
      missing.push(`${schema.file} ${schema.name}.${key}`)
  }
}
if (schemas.length === 0) {
  console.error(`✖ no schema carries the \`${MARKER}\` marker — the guard checks nothing`)
  process.exit(1)
}
if (missing.length > 0 && unsearchableRoots.length > 0) {
  console.log('⊘ authored fields UNDECIDED — these roots could not be searched:')
  for (const r of unsearchableRoots) console.log(`  ${r} (the camstack/ submodule is not here)`)
  console.log('  no control found for, and cannot rule out a viewer-only control:')
  for (const m of missing) console.log(`  ${m}`)
  console.log('  run this with `git submodule update --init camstack` for a verdict')
  process.exit(0)
}
if (missing.length > 0) {
  console.error('✖ authored fields no UI sets (built but unreachable):')
  for (const m of missing) console.error(`  ${m}`)
  process.exit(1)
}
console.log(
  unsearchableRoots.length > 0
    ? `✔ ${schemas.length} authored schema(s): every field has a UI that sets it (${unsearchableRoots.length} viewer root(s) not on disk, but every field matched without them)`
    : `✔ ${schemas.length} authored schema(s): every field has a UI that sets it`,
)

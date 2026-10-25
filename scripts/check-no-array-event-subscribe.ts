#!/usr/bin/env tsx
/**
 * Event-subscribe guard — no ARRAY category filter in a `.subscribe(...)` call.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `EventFilter.category` accepts an array, and until 2026-08-12 the bus threw
 * every element but the first away (`extractCategoryPattern` returned
 * `String(cat[0])`). One subscribe listing ten categories registered ONE
 * handler key.
 *
 * Inside a forked addon runner that is not a local filter but a delivery
 * decision: `createUdsEventBus` reports its handler-map keys to the parent as
 * this child's forwarding interest, and the parent forwards only what a child
 * declared. Nine of ten categories never crossed the process boundary. There
 * was no error, no warning and no log — the Notification Center received
 * `device.online` and looked to an operator like a feature with no rules.
 *
 * ── Why it stays now that the bus handles arrays ───────────────────────────
 * `extractCategoryPatterns` + `registerSubscriber` register a subscriber under
 * EVERY category it names, so an array filter is correct — in THIS source
 * tree. An addon does not run against this source tree: it loads
 * `@camstack/system` from the `@camstack/server` closure INSTALLED on the node
 * (`docs/architecture/update-and-release.md`). An addon deployed today onto a
 * hub whose server predates the fix gets the old one-key behaviour back, and
 * gets it silently.
 *
 * The rule is therefore: one `subscribe` call per category. It costs a `for`
 * loop and it cannot regress on an older host. This guard may be deleted once
 * no supported server version predates `extractCategoryPatterns`.
 *
 * ── What it checks ─────────────────────────────────────────────────────────
 * Any `.subscribe(` whose filter object literal opens `category:` with a `[`.
 * Text-scan (a full parse is not worth it for one shape), comments stripped
 * first so a doc comment showing the anti-pattern does not fail the build.
 *
 * Usage: npx tsx scripts/check-no-array-event-subscribe.ts
 */
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { globSync } from 'node:fs'

const ROOT = process.cwd()

const SEARCH_GLOBS: readonly string[] = [
  'packages/*/src/**/*.ts',
  'server/*/src/**/*.ts',
  'apps/*/src/**/*.ts',
]

/** Strip block + line comments so prose describing the anti-pattern is safe. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
}

/**
 * A `.subscribe(` whose filter names `category:` as an array literal, within
 * the same call's opening object. The window is bounded so an unrelated later
 * `category: [` cannot be attributed to this call.
 */
const SUBSCRIBE_CALL = /\.subscribe\s*\(/g
const CATEGORY_ARRAY = /\bcategory\s*:\s*\[/

function scan(file: string): readonly Violation[] {
  const raw = readFileSync(file, 'utf8')
  const source = stripComments(raw)
  const found: Violation[] = []
  for (const match of source.matchAll(SUBSCRIBE_CALL)) {
    const start = match.index + match[0].length
    const window = source.slice(start, start + 400)
    // Stop at the end of the FIRST argument — a handler body further along can
    // legitimately mention a category array.
    const argEnd = window.indexOf('},')
    const filterArg = argEnd >= 0 ? window.slice(0, argEnd) : window
    if (!CATEGORY_ARRAY.test(filterArg)) continue
    const line = source.slice(0, match.index).split('\n').length
    found.push({
      file: relative(ROOT, file),
      line,
      text: filterArg.replace(/\s+/g, ' ').trim().slice(0, 100),
    })
  }
  return found
}

const files = SEARCH_GLOBS.flatMap((pattern) =>
  globSync(pattern, { cwd: ROOT }).map((p) => join(ROOT, p)),
).filter((f) => !f.includes('/node_modules/') && !f.includes('/dist/'))

const violations = files.flatMap(scan)

if (violations.length > 0) {
  console.error('✖ array category filter passed to subscribe()\n')
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    ${v.text}\n`)
  }
  console.error(
    'Subscribe ONCE PER CATEGORY instead:\n' +
      '\n' +
      '  for (const category of CATEGORIES) {\n' +
      '    unsubs.push(bus.subscribe({ category }, handler))\n' +
      '  }\n' +
      '\n' +
      'This source tree registers an array filter under every category it names\n' +
      '(`extractCategoryPatterns`), but an addon runs against the @camstack/system\n' +
      'inside the INSTALLED @camstack/server — on a host predating that fix the\n' +
      'array silently subscribes to its first element only, and a forked runner\n' +
      'then never even has the other categories forwarded to it.\n' +
      '\n' +
      'This guard can be deleted once no supported server version predates\n' +
      '`extractCategoryPatterns`.',
  )
  process.exit(1)
}

console.log(`✔ event-subscribe guard: ${files.length} files, no array category filters`)

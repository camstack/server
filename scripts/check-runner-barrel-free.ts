#!/usr/bin/env tsx
/**
 * Runner-footprint guard (D28) — fail the build if the addon-runner's transitive
 * SOURCE closure imports a runtime VALUE from the `@camstack/types` root barrel.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * A forked addon-runner must never load the schema barrel: importing
 * `@camstack/types` eagerly builds the Zod graph of all ~266 caps (+~146MB RSS
 * PER runner; the lightweight `@camstack/types/addon` entry is +20MB). There is
 * NO runtime tree-shaking in Node and the package is externalized, so ONE bare
 * `import { x } from '@camstack/types'` anywhere in the runner's transitive graph
 * re-drags the entire 992KB schema chunk and silently reverts the win. This is
 * exactly how the first attempt failed: `trpc-links.ts` still pulled `readNodePin`
 * from the barrel, dragging the whole chunk back into the runner. See
 * docs/decisions/adr-0028.md.
 *
 * ── What this guard does ───────────────────────────────────────────────────
 * BFS from `addon-runner.ts` over relative (`./` / `../`) imports inside
 * `packages/system/src`, and flag any VALUE import from the bare `@camstack/types`
 * specifier (type-only imports are erased at runtime and allowed). Runner-surface
 * utilities must be imported from `@camstack/types/addon` / `/node` / `/enums`.
 *
 * Run manually: npx tsx scripts/check-runner-barrel-free.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
/**
 * Every entry whose closure must stay schema-free. The addon-runner is loaded by
 * every forked process; `addon-utils` is loaded by every addon that downloads a
 * model or registers a custom action (7 hub runners) — one bare `@camstack/types`
 * value import in `model-downloader.ts` cost each of them ~105 MB.
 */
export const GUARDED_ENTRIES: readonly string[] = [
  'packages/system/src/kernel/moleculer/addon-runner.ts',
  'packages/system/src/addon-utils.ts',
]

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec.replace(/\.js$/, ''))
  const candidates = [
    `${base}.ts`,
    `${base}.mts`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.mts'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

export interface Violation {
  readonly file: string
  readonly line: number
  readonly text: string
}

/**
 * Blank out comments, keeping every byte's position so reported line numbers
 * stay true.
 *
 * The scan below starts at the word `import` wherever it appears and runs to
 * the next `from '…'`. A COMMENT carrying that word therefore swallowed the
 * real statement after it and the guard reported a line that read as prose —
 * which is exactly what it did to a `// … the VALUE import had to move …`
 * note. A guard that a comment can flip is worse than none: this one is
 * textual by necessity, so the text it reads must at least be code.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:'"`])\/\/[^\n]*/g,
      (m, lead: string) => lead + ' '.repeat(m.length - lead.length),
    )
}

/**
 * Every module reference that is evaluated at load: `import … from '<spec>'`,
 * `export { … } from '<spec>'`, `export * [as ns] from '<spec>'`, a bare
 * side-effect `import '<spec>'` and a literal relative `import('./x')`.
 *
 * Re-exports matter as much as imports: `transport/index.ts` re-exporting
 * `local-child-registry.ts` carried the barrel into the runner for days while
 * this guard only followed `import … from` and stayed blind to it.
 */
function* importStatements(source: string): Generator<{ stmt: string; line: number }> {
  const src = stripComments(source)
  const re = new RegExp(
    [
      // import <clause> from '<spec>'
      String.raw`\bimport\s+(?:type\s+)?(?:\*\s+as\s+[\w$]+|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?|\{[^}]*\})\s*from\s*['"][^'"]+['"]`,
      // export [type] { … } from '<spec>'  /  export [type] * [as ns] from '<spec>'
      String.raw`\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"][^'"]+['"]`,
      // import '<spec>'  /  import('./relative') (a bare import('@camstack/types') is
      // nearly always a type position — `import('…').Foo` — so it is not followed)
      String.raw`\bimport\s*['"][^'"]+['"]`,
      String.raw`\bimport\s*\(\s*['"]\.[^'"]*['"]\s*\)`,
    ].join('|'),
    'g',
  )
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length
    yield { stmt: m[0], line }
  }
}

function specifierOf(stmt: string): string {
  const m = stmt.match(/(?:from\s*|import\s*\(?\s*)['"]([^'"]+)['"]/)
  return m ? m[1] : ''
}

/** True when the import brings ONLY types (erased at runtime). */
function isTypeOnly(stmt: string): boolean {
  if (/^(?:import|export)\s+type\b/.test(stmt.trim())) return true
  const brace = stmt.match(/\{([\s\S]*)\}/)
  if (!brace) return false // default / namespace / star / side-effect: a value
  const specs = brace[1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s))
}

/** Walk the closure of `entry`; every barrel value-import or re-export found. */
export function findBarrelViolations(
  entry: string,
  root: string,
): { readonly files: number; readonly violations: readonly Violation[] } {
  const seen = new Set<string>()
  const queue: string[] = [entry]
  const violations: Violation[] = []

  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    let src: string
    try {
      src = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const { stmt, line } of importStatements(src)) {
      const spec = specifierOf(stmt)
      if (spec === '@camstack/types' && !isTypeOnly(stmt)) {
        violations.push({
          file: path.relative(root, file),
          line,
          text: stmt.replace(/\s+/g, ' ').trim(),
        })
      }
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(file, spec)
        if (resolved && !seen.has(resolved)) queue.push(resolved)
      }
    }
  }
  return { files: seen.size, violations }
}

/** Directories of addon source that are UI (browser bundles), not server code. */
const ADDON_UI_DIRS: ReadonlySet<string> = new Set([
  'ui',
  'pages',
  'widgets',
  'components',
  '__tests__',
  'node_modules',
  'dist',
])
/** The admin UI package is a browser bundle end to end. */
const ADDON_UI_PACKAGES: ReadonlySet<string> = new Set(['addon-admin-ui', 'addon-agent-ui'])

const FORBIDDEN_IN_ADDONS = /\bALL_CAPABILITY_DEFINITIONS\b/

function isAddonServerFile(name: string): boolean {
  return /\.m?ts$/.test(name) && !/\.(spec|test)\.m?ts$/.test(name) && !name.endsWith('.d.ts')
}

function* addonServerFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!ADDON_UI_DIRS.has(entry.name)) yield* addonServerFiles(full)
    } else if (isAddonServerFile(entry.name)) {
      yield full
    }
  }
}

/**
 * Addon SERVER code that names `ALL_CAPABILITY_DEFINITIONS` (comments ignored).
 * An addon bundles `@camstack/types`, so the identifier inlines every cap's Zod
 * schema (~+100 MB heap per runner). Facts addons need come as codegen'd plain
 * data from `@camstack/types/addon` (`scripts/generate-addon-cap-facts.ts`).
 */
export function findAddonDefinitionUses(root: string): readonly Violation[] {
  const packagesDir = path.join(root, 'packages')
  const out: Violation[] = []
  for (const pkg of fs.readdirSync(packagesDir).sort()) {
    const src = path.join(packagesDir, pkg, 'src')
    if (!pkg.startsWith('addon-') || ADDON_UI_PACKAGES.has(pkg) || !fs.existsSync(src)) continue
    for (const file of addonServerFiles(src)) {
      const lines = stripComments(fs.readFileSync(file, 'utf-8')).split('\n')
      lines.forEach((text, i) => {
        if (FORBIDDEN_IN_ADDONS.test(text)) {
          out.push({ file: path.relative(root, file), line: i + 1, text: text.trim() })
        }
      })
    }
  }
  return out
}

function main(): void {
  const violations: Violation[] = []
  let files = 0
  for (const entry of GUARDED_ENTRIES) {
    const found = findBarrelViolations(path.join(ROOT, entry), ROOT)
    files += found.files
    violations.push(...found.violations)
  }

  const definitionUses = findAddonDefinitionUses(ROOT)
  if (definitionUses.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n✗ runner-barrel-free guard (D28): addon SERVER code names ALL_CAPABILITY_DEFINITIONS\n` +
        `  (inlines every cap's Zod schema: +~100MB heap per runner that holds the addon).\n` +
        `  Read the fact from a codegen'd table on '@camstack/types/addon' instead: add it to\n` +
        `  scripts/generate-addon-cap-facts.ts, run 'npm run codegen', import it from\n` +
        `  '@camstack/types/addon' (CAP_ADVANCE_FIELDS, CAP_STATE_LEAVES). See docs/decisions/adr-0028.md.\n`,
    )
    for (const v of definitionUses) {
      // eslint-disable-next-line no-console
      console.error(`  ${v.file}:${v.line}\n    ${v.text}`)
    }
    process.exit(1)
  }

  if (violations.length > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `\n✗ runner-barrel-free guard (D28): a guarded closure imports runtime VALUES\n` +
        `  from the '@camstack/types' schema barrel (+~100-146MB RSS per process).\n` +
        `  Guarded entries: ${GUARDED_ENTRIES.join(', ')}\n` +
        `  Import runner-surface utilities from '@camstack/types/addon' (or /node, /enums)\n` +
        `  instead (a type-only import is fine: 'import type' / '{ type X }'). See docs/decisions/adr-0028.md.\n`,
    )
    for (const v of violations) {
      // eslint-disable-next-line no-console
      console.error(`  ${v.file}:${v.line}\n    ${v.text}`)
    }
    process.exit(1)
  }

  // eslint-disable-next-line no-console
  console.log(
    `✔ runner-barrel-free guard: ${files} files across ${GUARDED_ENTRIES.length} guarded entries, 0 barrel value-imports, no ALL_CAPABILITY_DEFINITIONS in addon server code`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

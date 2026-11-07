#!/usr/bin/env tsx
/**
 * Guard (D1021): the template engine is reachable through ONE module.
 *
 * nunjucks does not sandbox — `{{ range.constructor("return process")() }}`
 * runs. The device value-template renderer is safe only because every
 * template passes the grammar whitelist (`template-grammar.ts`) and renders in
 * a worker thread. A second module that imported nunjucks could render a
 * template without either, so:
 *
 *   1. `nunjucks` is imported ONLY by `device-template/nunjucks-internals.ts`
 *      (the typed wrapper). No other source file, in any package.
 *   2. The render worker's relative-import graph never VALUE-imports the bare
 *      `@camstack/types` barrel (D453) — the limits travel in `workerData`;
 *      `@camstack/types/units-lean` is the one allowed subpath.
 *
 * Specs may import nothing from nunjucks either: they render through the
 * renderer, which is what must be proven safe.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_DIR = 'packages/system/src/builtins/device-manager/device-template'
const ALLOWED = `${TEMPLATE_DIR}/nunjucks-internals.ts`
const WORKER_ENTRY = `${TEMPLATE_DIR}/template-worker.ts`
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.nx', '.claude', 'coverage', 'build'])
const IMPORT_RE =
  /^\s*(?:import|export)\s+(?<type>type\s+)?(?<clause>[^'"]*?)\s*from\s*['"](?<spec>[^'"]+)['"]|^\s*import\s*['"](?<bare>[^'"]+)['"]|\brequire\(\s*['"](?<req>[^'"]+)['"]\s*\)|\bimport\(\s*['"](?<dyn>[^'"]+)['"]\s*\)/

export interface Violation {
  readonly file: string
  readonly line: number
  readonly message: string
}

function isNunjucks(spec: string): boolean {
  return spec === 'nunjucks' || spec.startsWith('nunjucks/')
}

export function nunjucksViolations(file: string, source: string): readonly Violation[] {
  if (file === ALLOWED) return []
  const out: Violation[] = []
  source.split('\n').forEach((text, index) => {
    const m = IMPORT_RE.exec(text)
    const spec =
      m?.groups?.['spec'] ?? m?.groups?.['bare'] ?? m?.groups?.['req'] ?? m?.groups?.['dyn']
    if (spec !== undefined && isNunjucks(spec)) {
      out.push({ file, line: index + 1, message: `imports nunjucks; only ${ALLOWED} may` })
    }
  })
  return out
}

export function barrelViolations(file: string, source: string): readonly Violation[] {
  const out: Violation[] = []
  source.split('\n').forEach((text, index) => {
    const m = IMPORT_RE.exec(text)
    const spec = m?.groups?.['spec']
    if (spec === '@camstack/types' && m?.groups?.['type'] === undefined) {
      out.push({
        file,
        line: index + 1,
        message: 'the render worker value-imports the @camstack/types barrel (D453)',
      })
    }
  })
  return out
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) sourceFiles(full, out)
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function workerGraph(): string[] {
  const seen = new Set<string>()
  const queue = [WORKER_ENTRY]
  while (queue.length > 0) {
    const rel = queue.pop()
    if (rel === undefined || seen.has(rel)) continue
    seen.add(rel)
    const source = readFileSync(path.join(ROOT, rel), 'utf8')
    for (const text of source.split('\n')) {
      const spec = IMPORT_RE.exec(text)?.groups?.['spec']
      if (spec === undefined || !spec.startsWith('.')) continue
      queue.push(path.posix.join(path.posix.dirname(rel), spec.replace(/\.js$/, '.ts')))
    }
  }
  return [...seen]
}

function main(): void {
  const violations: Violation[] = []
  for (const top of ['packages', 'server', 'scripts', 'tools']) {
    let files: string[]
    try {
      files = sourceFiles(path.join(ROOT, top))
    } catch {
      continue
    }
    for (const full of files) {
      const rel = path.relative(ROOT, full).split(path.sep).join('/')
      if (
        rel === 'scripts/check-device-template-grammar.ts' ||
        rel.startsWith('scripts/__tests__/')
      )
        continue
      violations.push(...nunjucksViolations(rel, readFileSync(full, 'utf8')))
    }
  }
  for (const rel of workerGraph())
    violations.push(...barrelViolations(rel, readFileSync(path.join(ROOT, rel), 'utf8')))
  if (violations.length === 0) {
    console.log('check-device-template-grammar: OK')
    return
  }
  for (const v of violations) console.error(`${v.file}:${v.line}  ${v.message}`)
  console.error(`\ncheck-device-template-grammar: ${violations.length} violation(s). See D1021.`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
)
  main()

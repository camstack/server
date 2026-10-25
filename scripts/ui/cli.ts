#!/usr/bin/env tsx
/**
 * The local UI toolbox — no MCP, no network, no build.
 *
 *   npm run ui:find -- "<need>"        components + need-table rows for a need
 *   npm run ui:show -- <Component>     one export: file, summary, props, consumers
 *   npm run ui:tokens [-- admin|viewer] the colour tokens, web ↔ viewer
 *   npm run ui:check -- <files|dirs…>  off-system UI shapes, each with its replacement
 *       --staged   check the staged files instead of arguments
 *       --warn     print, but always exit 0 (what the pre-commit hook uses)
 *       --summary  counts per rule instead of every finding
 *
 * Reads the committed catalogue `docs/reference/ui-components.json`
 * (`npm run ui:catalogue` regenerates it). `ui:check` is a developer tool and
 * is never wired into CI.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { type CatalogueEntry, loadCatalogue, type UiCatalogue } from './lib/ui-catalogue.js'
import {
  checkUiSource,
  formatFinding,
  isCheckedFile,
  summarizeFindings,
  type UiFinding,
} from './lib/ui-check.js'
import { rankEntries, rankNeeds } from './lib/ui-search.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const VIEWER_TOKENS = 'camstack/src/theme/tokens.ts'

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function describeEntry(e: CatalogueEntry): string {
  return `${e.name.padEnd(28)} ${e.kind.padEnd(9)} ${e.file}${e.summary ? `\n${' '.repeat(39)}${e.summary.slice(0, 110)}` : ''}`
}

function find(catalogue: UiCatalogue, query: string): void {
  if (query.trim() === '') {
    out('usage: npm run ui:find -- "<need>"   e.g. "confirm before delete", "table with filters"')
    process.exit(2)
  }
  const needs = rankNeeds(catalogue.needs, query).slice(0, 5)
  if (needs.length > 0) {
    out('Need table (docs/ui/need-x-use-y.md):')
    for (const n of needs) {
      out(`  ${n.need}`)
      out(`    admin/addon page: ${n.admin}`)
      if (n.viewer && n.viewer !== '—') out(`    viewer:           ${n.viewer}`)
      if (n.notes) out(`    note:             ${n.notes}`)
    }
    out()
  }
  const entries = rankEntries(catalogue.entries, query).slice(0, 12)
  out(entries.length > 0 ? '@camstack/ui-library exports:' : 'No library export matches.')
  for (const e of entries) out(`  ${describeEntry(e)}`)
  const viewer = rankEntries(catalogue.viewerEntries, query).slice(0, 8)
  if (viewer.length > 0) {
    out()
    out('Viewer kit (camstack/src/components/ui — React Native, viewer app only):')
    for (const e of viewer) out(`  ${describeEntry(e)}`)
  }
  out()
  out('Next: `npm run ui:show -- <Name>` for props and real call sites.')
}

function consumers(name: string): string[] {
  try {
    const raw = execFileSync(
      'git',
      ['grep', '-l', '-w', name, '--', 'packages/*/src/*.tsx', 'packages/*/src/**/*.tsx'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    return raw
      .split('\n')
      .filter(
        (f) => f && !f.startsWith('packages/ui-library/') && !/__tests__|\.spec\.|\.test\./.test(f),
      )
  } catch {
    return []
  }
}

function show(catalogue: UiCatalogue, name: string): void {
  const pool = [...catalogue.entries, ...catalogue.viewerEntries]
  const entry =
    pool.find((e) => e.name === name) ??
    pool.find((e) => e.name.toLowerCase() === name.toLowerCase())
  if (!entry) {
    out(`"${name}" is not exported by @camstack/ui-library or the viewer kit.`)
    const near = rankEntries(pool, name).slice(0, 5)
    if (near.length > 0) out(`Did you mean: ${near.map((e) => e.name).join(', ')}?`)
    out(
      'Admin-ui-local components (AdminPage, AdminTabs, IntegrationHub …) are not in the catalogue: see docs/ui/admin-patterns.md.',
    )
    process.exit(1)
  }
  out(`${entry.name}  (${entry.kind}, ${entry.area})`)
  out(`  file: ${entry.file}`)
  out(
    entry.area === 'viewer'
      ? `  import { ${entry.name} } from '<relative>/components/ui/${path.basename(entry.file)}'  (viewer app)`
      : `  import { ${entry.name} } from '@camstack/ui-library'`,
  )
  if (entry.summary) out(`  ${entry.summary}`)
  if (entry.propsExtends && entry.propsExtends.length > 0) {
    out(`  props extend: ${entry.propsExtends.join(', ')}`)
  }
  if (entry.props && entry.props.length > 0) {
    out('  props:')
    for (const p of entry.props) {
      out(`    ${p.name}${p.optional ? '?' : ''}: ${p.type}`)
      if (p.doc) out(`        ${p.doc.slice(0, 140)}`)
    }
  }
  const used = entry.area === 'viewer' ? [] : consumers(entry.name)
  if (entry.area === 'viewer')
    out('  call sites: grep camstack/src (the submodule is not searched here)')
  else
    out(`  used in ${used.length} file(s) outside the library${used.length > 0 ? ', e.g.:' : ''}`)
  for (const f of used.slice(0, 3)) out(`    ${f}`)
  const needs = catalogue.needs.filter((n) => `${n.admin} ${n.viewer}`.includes(`\`${entry.name}`))
  for (const n of needs) out(`  need-table: ${n.need}`)
}

function parseViewerTokens(file: string): Map<string, { dark: string; light: string }> | null {
  if (!fs.existsSync(file)) return null
  const src = fs.readFileSync(file, 'utf8')
  const block = (label: string): Map<string, string> => {
    const m = new RegExp(`const ${label}: ColorTokens = \\{([\\s\\S]*?)\\n\\}`).exec(src)
    const map = new Map<string, string>()
    if (!m) return map
    for (const kv of m[1].matchAll(/(\w+):\s*'([^']+)'/g)) map.set(kv[1], kv[2])
    return map
  }
  const dark = block('dark')
  const light = block('light')
  const outMap = new Map<string, { dark: string; light: string }>()
  for (const [k, v] of dark) outMap.set(k, { dark: v, light: light.get(k) ?? '' })
  return outMap
}

function tokens(catalogue: UiCatalogue, which: string): void {
  const viewer = parseViewerTokens(path.join(ROOT, VIEWER_TOKENS))
  if (which !== 'viewer') {
    out('Admin UI / ui-library / addon pages — packages/ui-library/src/tailwind/camstack-theme.css')
    out(
      '  utility examples: bg-<token>  text-<token>  border-<token>  bg-<token>/10  var(--color-<token>)',
    )
    out(`  ${'token'.padEnd(22)} ${'dark'.padEnd(9)} ${'light'.padEnd(9)} viewer key`)
    for (const c of catalogue.colors) {
      out(`  ${c.name.padEnd(22)} ${c.dark.padEnd(9)} ${(c.light ?? '—').padEnd(9)} ${c.viewerKey}`)
    }
    out(
      `  radius: ${Object.entries(catalogue.radius)
        .map(([k, v]) => `rounded-${k}=${v}`)
        .join('  ')}`,
    )
    out()
  }
  if (which !== 'admin') {
    out(`Viewer — ${VIEWER_TOKENS} (ColorTokens via useTheme().colors)`)
    if (!viewer) {
      out('  submodule not checked out here; run `npm run ui:tokens` inside the viewer repo.')
      return
    }
    const web = new Map(catalogue.colors.map((c) => [c.viewerKey, c]))
    for (const [key, v] of viewer) {
      const twin = web.get(key)
      const same = twin ? twin.dark === v.dark && twin.light === v.light : false
      const note = twin
        ? same
          ? `= ${twin.name}`
          : `≠ ${twin.name} (DRIFT: web ${twin.dark}/${twin.light})`
        : 'viewer-only'
      out(`  ${key.padEnd(22)} ${v.dark.padEnd(9)} ${v.light.padEnd(9)} ${note}`)
    }
  }
}

function expand(target: string): string[] {
  const abs = path.resolve(ROOT, target)
  if (!fs.existsSync(abs)) return []
  if (fs.statSync(abs).isFile()) return [path.relative(ROOT, abs)]
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.'))
        continue
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else files.push(path.relative(ROOT, p))
    }
  }
  walk(abs)
  return files
}

function stagedFiles(): string[] {
  const raw = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return raw.split('\n').filter(Boolean)
}

/**
 * What counts as UI source: any `.tsx` / `.css` under a package's `src/`, and
 * `.ts` only in admin-ui and ui-library (class-string helpers live there; an
 * addon's `.ts` is backend code whose hex is an OSD colour, not a style).
 */
export function isUiPath(file: string): boolean {
  if (/^packages\/[^/]+\/src\/.*\.(tsx|css)$/.test(file)) return true
  return /^packages\/(addon-admin-ui|ui-library)\/src\/.*\.ts$/.test(file)
}

function check(catalogue: UiCatalogue, args: readonly string[]): void {
  const warn = args.includes('--warn')
  const summary = args.includes('--summary')
  const targets = args.filter((a) => !a.startsWith('--'))
  const files = (args.includes('--staged') ? stagedFiles() : targets.flatMap(expand))
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => isCheckedFile(f) && isUiPath(f))
  if (files.length === 0) {
    if (!args.includes('--staged')) {
      out('usage: npm run ui:check -- <files|dirs…> [--summary] [--warn]   (or --staged)')
      process.exit(2)
    }
    return
  }
  const hexTokens = new Map<string, string>()
  for (const c of catalogue.colors) {
    if (c.name.startsWith('provider-')) continue
    if (!hexTokens.has(c.dark.toLowerCase())) hexTokens.set(c.dark.toLowerCase(), c.name)
    if (c.light && !hexTokens.has(c.light.toLowerCase()))
      hexTokens.set(c.light.toLowerCase(), c.name)
  }
  const libraryComponents = new Set(
    catalogue.entries.filter((e) => e.kind === 'component').map((e) => e.name),
  )
  const findings: UiFinding[] = []
  for (const f of files) {
    const abs = path.join(ROOT, f)
    if (!fs.existsSync(abs)) continue
    findings.push(...checkUiSource(f, fs.readFileSync(abs, 'utf8'), hexTokens, libraryComponents))
  }
  if (summary) {
    const s = summarizeFindings(findings)
    out(
      `ui:check — ${files.length} file(s) scanned, ${findings.length} finding(s) in ${s.files} file(s)`,
    )
    for (const [rule, n] of Object.entries(s.byRule).toSorted((a, b) => b[1] - a[1])) {
      out(`  ${rule.padEnd(20)} ${String(n).padStart(5)} in ${s.filesByRule[rule]} file(s)`)
    }
  } else {
    for (const f of findings) out(formatFinding(f))
    out(
      findings.length === 0
        ? `ui:check — ${files.length} file(s), 0 findings`
        : `ui:check — ${findings.length} finding(s) in ${files.length} file(s). Fix new ones; mark a deliberate exception with \`ui-check-ok: <reason>\`.`,
    )
  }
  if (findings.length > 0 && !warn && !summary) process.exit(1)
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2)
  let catalogue: UiCatalogue
  try {
    catalogue = loadCatalogue(ROOT)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }
  switch (command) {
    case 'find':
      return find(catalogue, rest.join(' '))
    case 'show':
      return show(catalogue, rest[0] ?? '')
    case 'tokens':
      return tokens(catalogue, rest[0] ?? 'all')
    case 'check':
      return check(catalogue, rest)
    default:
      out('usage: tsx scripts/ui/cli.ts <find|show|tokens|check> …')
      process.exit(2)
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

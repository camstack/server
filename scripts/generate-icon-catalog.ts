#!/usr/bin/env tsx
/**
 * Generate `packages/types/src/device/icon-catalog.generated.ts` (D854).
 *
 * The catalog is every lucide icon BOTH surfaces can draw: the admin UI's
 * `lucide-react` (root node_modules) and the viewer's `lucide-react-native`
 * (`camstack/node_modules`, the submodule's own install). The file is generated
 * LOCALLY and COMMITTED — CI never regenerates it (the submodule is absent
 * there), `scripts/check-icon-catalog.ts` only proves the committed file is
 * still drawable by the installed `lucide-react`.
 *
 *   npm run icons:catalog
 *
 * Environment:
 *   CAMSTACK_VIEWER_ROOT  the viewer checkout holding node_modules/lucide-react-native
 *                         (default: <repo>/camstack — set it when this is a worktree
 *                         whose submodule is empty)
 *   LUCIDE_SOURCE_DIR     an extracted lucide-icons/lucide checkout at the SAME
 *                         version as lucide-react (default: the tag tarball is
 *                         downloaded once into the OS temp dir)
 *
 * Where each field comes from:
 *   - key        the canonical (non-alias) module name present in BOTH packages
 *   - tags       `icons/<key>.json` "tags" of lucide-icons/lucide at the tag equal
 *                to the installed lucide-react version (English search words)
 *   - categories the same file's "categories" (first = primary)
 *   - aliases    lucide-react's `dynamicIconImports` alias entries (old spelling →
 *                canonical module) that the viewer's barrel also exports
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, 'packages/types/src/device/icon-catalog.generated.ts')

interface PackageJson {
  readonly version: string
}

interface LucideIconJson {
  readonly tags?: readonly string[]
  readonly categories?: readonly string[]
}

export interface WebIcons {
  /** canonical ids */
  readonly canonical: ReadonlySet<string>
  /** alias → canonical id */
  readonly aliases: ReadonlyMap<string, string>
}

function fail(message: string): never {
  process.stderr.write(`generate-icon-catalog: ${message}\n`)
  process.exit(1)
}

function readVersion(dir: string): string {
  const parsed: PackageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  return parsed.version
}

/** Parse lucide-react's `dynamicIconImports`: `"id": () => import('./icons/<module>.js')`. */
export function readWebIcons(lucideReactDir: string): WebIcons {
  const file = join(lucideReactDir, 'dist/esm/dynamicIconImports.js')
  if (!existsSync(file)) fail(`${file} not found — run npm ci`)
  const canonical = new Set<string>()
  const aliases = new Map<string, string>()
  const re = /^\s*"([^"]+)":\s*\(\)\s*=>\s*import\('\.\/icons\/([^']+)\.js'\)/gm
  for (const m of readFileSync(file, 'utf8').matchAll(re)) {
    const [, id, mod] = m
    if (id === mod) canonical.add(id)
    else aliases.set(id, mod)
  }
  return { canonical, aliases }
}

/** kebab id → the PascalCase export lucide derives from it. */
export function toPascal(id: string): string {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

interface ViewerIcons {
  readonly canonical: ReadonlySet<string>
  /** exported PascalCase name → module id */
  readonly exportsOf: ReadonlyMap<string, string>
}

function readViewerIcons(viewerLucideDir: string): ViewerIcons {
  const iconsDir = join(viewerLucideDir, 'dist/esm/icons')
  const canonical = new Set(
    readdirSync(iconsDir)
      .filter((f) => f.endsWith('.mjs') && f !== 'index.mjs')
      .map((f) => f.slice(0, -'.mjs'.length)),
  )
  const barrel = readFileSync(join(viewerLucideDir, 'dist/esm/lucide-react-native.mjs'), 'utf8')
  const exportsOf = new Map<string, string>()
  for (const m of barrel.matchAll(/^export \{([^}]+)\} from '\.\/icons\/([^']+)\.mjs'/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[1]
      if (name !== undefined) exportsOf.set(name.trim(), m[2])
    }
  }
  return { canonical, exportsOf }
}

function lucideSourceDir(version: string): string {
  const fromEnv = process.env['LUCIDE_SOURCE_DIR']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const cache = join(tmpdir(), `camstack-lucide-source-${version}`)
  const extracted = join(cache, `lucide-${version}`)
  if (existsSync(join(extracted, 'icons'))) return extracted
  mkdirSync(cache, { recursive: true })
  const tgz = join(cache, 'source.tgz')
  const url = `https://codeload.github.com/lucide-icons/lucide/tar.gz/refs/tags/${version}`
  process.stdout.write(`downloading ${url}\n`)
  execFileSync('curl', ['-sSfL', '-m', '180', '-o', tgz, url], { stdio: 'inherit' })
  execFileSync('tar', ['xzf', tgz, '-C', cache], { stdio: 'inherit' })
  if (!existsSync(join(extracted, 'icons'))) fail(`unexpected tarball layout under ${cache}`)
  return extracted
}

function readIconJson(sourceDir: string, id: string): LucideIconJson {
  const file = join(sourceDir, 'icons', `${id}.json`)
  if (!existsSync(file)) return {}
  return JSON.parse(readFileSync(file, 'utf8'))
}

function literal(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function main(): void {
  const webDir = join(ROOT, 'node_modules/lucide-react')
  if (!existsSync(webDir)) fail('node_modules/lucide-react is missing — run npm ci')
  const viewerRoot = process.env['CAMSTACK_VIEWER_ROOT'] ?? join(ROOT, 'camstack')
  const viewerDir = join(viewerRoot, 'node_modules/lucide-react-native')
  if (!existsSync(viewerDir)) {
    fail(
      `${viewerDir} is missing. The catalog is the intersection of lucide-react and the viewer's ` +
        'lucide-react-native, so the viewer must be installed (cd camstack && npm ci) — or point ' +
        'CAMSTACK_VIEWER_ROOT at a checkout that has it. CI never regenerates this file.',
    )
  }

  const webVersion = readVersion(webDir)
  const viewerVersion = readVersion(viewerDir)
  const web = readWebIcons(webDir)
  const viewer = readViewerIcons(viewerDir)

  // The viewer ACCEPTS an id when it has the module or exports the PascalCase
  // name from its barrel. They differ across a rename the two packages disagree
  // on: `waves` is canonical in lucide-react but an alias of `waves-horizontal`
  // in lucide-react-native, so the viewer draws it through its alias export.
  const viewerModuleOf = (id: string): string | undefined =>
    viewer.canonical.has(id) ? id : viewer.exportsOf.get(toPascal(id))
  const keys = [...web.canonical].filter((id) => viewerModuleOf(id) !== undefined).toSorted()
  const keySet = new Set(keys)
  const viewerModules = keys
    .map((id) => [id, viewerModuleOf(id)] as const)
    .filter(([id, mod]) => mod !== id)

  const aliasMap = new Map<string, string>()
  for (const [alias, target] of web.aliases) {
    if (keySet.has(alias) || !keySet.has(target)) continue
    if (viewerModuleOf(alias) === undefined) continue
    aliasMap.set(alias, target)
  }
  const aliases = [...aliasMap].toSorted(([a], [b]) => (a < b ? -1 : 1))

  const source = lucideSourceDir(webVersion)
  const metas = keys.map((id) => ({ id, ...readIconJson(source, id) }))
  const categoryIds = new Set<string>()
  for (const m of metas) for (const c of m.categories ?? []) categoryIds.add(c)
  const uncategorised = metas.filter((m) => (m.categories ?? []).length === 0).length
  if (uncategorised > 0) categoryIds.add('other')
  const categories = [...categoryIds].toSorted()
  const categoryIndex = new Map(categories.map((c, i) => [c, i]))

  const rows = metas.map((m) => {
    const cats = (m.categories ?? []).length === 0 ? ['other'] : (m.categories ?? [])
    const idx = cats.map((c) => categoryIndex.get(c) ?? -1)
    const tags = [...new Set((m.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))]
    return `[[${idx.join(', ')}], [${tags.map(literal).join(', ')}]]`
  })

  const lines = [
    '// GENERATED by scripts/generate-icon-catalog.ts (npm run icons:catalog) — DO NOT EDIT.',
    '// D854: every lucide icon the admin UI (lucide-react) AND the viewer',
    '// (lucide-react-native) can both draw. Committed; CI never regenerates it.',
    `// lucide-react ${webVersion}; lucide-react-native ${viewerVersion}.`,
    `// Tags and categories: lucide-icons/lucide@${webVersion} icons/<id>.json.`,
    '',
    'export const ICON_CATALOG_SOURCE = {',
    `  lucideReact: ${literal(webVersion)},`,
    `  lucideReactNative: ${literal(viewerVersion)},`,
    `  metadata: ${literal(`lucide-icons/lucide@${webVersion} icons/*.json`)},`,
    '} as const',
    '',
    '/** Lucide category ids, alphabetical. `ICON_META` indexes into this. */',
    `export const ICON_CATEGORY_IDS = [${categories.map(literal).join(', ')}] as const`,
    '',
    '/** The catalog keys (the PERSISTED values), sorted. */',
    'export const ICON_KEYS = [',
    ...keys.map((k) => `  ${literal(k)},`),
    '] as const',
    '',
    '/** Parallel to `ICON_KEYS`: [category indexes (first = primary), English tags]. */',
    'export const ICON_META: readonly (readonly [readonly number[], readonly string[]])[] = [',
    ...rows.map((r) => `  ${r},`),
    ']',
    '',
    '/** Keys whose viewer module (`lucide-react-native/icons/<module>`) is not the key. */',
    'export const ICON_VIEWER_MODULES = {',
    ...viewerModules.map(([k, m]) => `  ${literal(k)}: ${literal(m ?? '')},`),
    '} as const',
    '',
    '/** Old spelling → canonical key, for ids both packages still accept. */',
    'export const ICON_ALIASES = {',
    ...aliases.map(([a, t]) => `  ${literal(a)}: ${literal(t)},`),
    '} as const',
    '',
  ]
  writeFileSync(OUT, lines.join('\n'))
  process.stdout.write(
    `icon-catalog: ${keys.length} keys, ${categories.length} categories, ${aliases.length} aliases ` +
      `(web ${web.canonical.size}, viewer ${viewer.canonical.size}, ${uncategorised} uncategorised)\n`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()

#!/usr/bin/env tsx
/**
 * The icon catalog is ONE list, and it is still drawable (D854).
 *
 * `packages/types/src/device/icon-catalog.generated.ts` is generated locally by
 * `npm run icons:catalog` and COMMITTED — CI never regenerates it, because the
 * viewer (a submodule) is absent there. So nothing but this guard notices when
 * it rots. Two things rot it:
 *
 * 1. **The lucide packages move.** A key the installed `lucide-react` can no
 *    longer draw is offered by the picker and renders nothing; the committed
 *    file records the versions it was generated against, and this compares them
 *    with what is installed. When the viewer's `lucide-react-native` is on disk
 *    (it is not in CI), the same is checked against it, and SKIPPED out loud
 *    otherwise — "I could not look" and "I looked and it was fine" are
 *    different answers (D315).
 * 2. **A second vocabulary appears.** Two icon lists on the same two surfaces
 *    with different members is the bug the catalog replaced (D598, D511): a
 *    `*_ICON_IDS` / `*_ICON_KEYS` / `*_ICON_VOCABULARY` array or a union of
 *    icon-name string literals anywhere in `packages/**` is refused. A glyph
 *    TABLE keyed on `IconKey` is not a vocabulary and is fine.
 *
 * Usage: npx tsx scripts/check-icon-catalog.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  ICON_ALIASES,
  ICON_CATALOG_SOURCE,
  ICON_KEYS,
} from '../packages/types/src/device/icon-catalog.generated.js'
import { readWebIcons, toPascal } from './generate-icon-catalog.js'

const ROOT = join(import.meta.dirname, '..')

/** The files that ARE the catalog; they may declare the key list. */
const CATALOG_FILES: ReadonlySet<string> = new Set([
  'packages/types/src/device/icon-catalog.generated.ts',
  'packages/types/src/device/icon-catalog.ts',
])

const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'assets',
  'coverage',
  '.nx',
  'generated',
])

/** `FOO_ICON_IDS = …`, `ICON_KEYS = …`, `*_ICON_VOCABULARY = …` — a list of icon names. */
const VOCABULARY_DECLARATION =
  /\b(?:const|let|var)\s+(?:[A-Z0-9_]*_)?ICON_(?:IDS|KEYS|NAMES|VOCABULARY|REGISTRY)\b/
/** `type FooIconId = 'a' | 'b'` — a union of icon-name literals. */
const VOCABULARY_UNION = /\btype\s+\w*Icon\w*\s*=\s*\|?\s*'[a-z0-9-]+'\s*\|/

export interface SecondVocabulary {
  readonly file: string
  readonly line: number
  readonly text: string
}

/** Pure: the lines of `source` that declare an icon vocabulary. */
export function findVocabularyDeclarations(file: string, source: string): SecondVocabulary[] {
  if (CATALOG_FILES.has(file)) return []
  const found: SecondVocabulary[] = []
  source.split('\n').forEach((text, index) => {
    const trimmed = text.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    if (VOCABULARY_DECLARATION.test(text) || VOCABULARY_UNION.test(text)) {
      found.push({ file, line: index + 1, text: trimmed })
    }
  })
  return found
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      yield* sourceFiles(join(dir, entry.name))
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield join(dir, entry.name)
    }
  }
}

function secondVocabularies(): SecondVocabulary[] {
  const out: SecondVocabulary[] = []
  for (const abs of sourceFiles(join(ROOT, 'packages'))) {
    const file = relative(ROOT, abs)
    out.push(...findVocabularyDeclarations(file, readFileSync(abs, 'utf8')))
  }
  return out
}

/** Pure: why the committed catalog cannot be drawn by a package at `version`. */
export function undrawableKeys(
  keys: readonly string[],
  aliases: Readonly<Record<string, string>>,
  accepted: (id: string) => boolean,
): string[] {
  const problems: string[] = []
  for (const key of keys) if (!accepted(key)) problems.push(key)
  for (const alias of Object.keys(aliases)) if (!accepted(alias)) problems.push(`alias ${alias}`)
  return problems
}

/** An id the viewer's lucide-react-native draws: a module, or a barrel export of its PascalCase name. */
function readViewerAccepted(viewerDir: string): (id: string) => boolean {
  const modules = new Set(
    readdirSync(join(viewerDir, 'dist/esm/icons'))
      .filter((f) => f.endsWith('.mjs') && f !== 'index.mjs')
      .map((f) => f.slice(0, -'.mjs'.length)),
  )
  const barrel = readFileSync(join(viewerDir, 'dist/esm/lucide-react-native.mjs'), 'utf8')
  return (id) =>
    modules.has(id) ||
    barrel.includes(`default as ${toPascal(id)},`) ||
    barrel.includes(`default as ${toPascal(id)} }`)
}

function installedVersion(dir: string): string | undefined {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return undefined
  const parsed: { version: string } = JSON.parse(readFileSync(file, 'utf8'))
  return parsed.version
}

function main(): void {
  const failures: string[] = []
  const regenerate =
    'Regenerate it locally with `npm run icons:catalog` (needs the viewer installed) and commit it.'

  // 1a. lucide-react (the admin surface) — always installed.
  const webDir = join(ROOT, 'node_modules/lucide-react')
  const webVersion = installedVersion(webDir)
  if (webVersion === undefined) {
    failures.push('node_modules/lucide-react is missing — run npm ci.')
  } else {
    if (webVersion !== ICON_CATALOG_SOURCE.lucideReact) {
      failures.push(
        `icon-catalog.generated.ts was generated against lucide-react ${ICON_CATALOG_SOURCE.lucideReact}, ` +
          `${webVersion} is installed. ${regenerate}`,
      )
    }
    const web = readWebIcons(webDir)
    const accepted = (id: string): boolean => web.canonical.has(id) || web.aliases.has(id)
    const bad = undrawableKeys(ICON_KEYS, ICON_ALIASES, accepted)
    if (bad.length > 0) {
      failures.push(
        `${bad.length} catalog entr${bad.length === 1 ? 'y' : 'ies'} lucide-react ${webVersion} cannot draw: ` +
          `${bad.slice(0, 12).join(', ')}${bad.length > 12 ? ', …' : ''}. ${regenerate}`,
      )
    }
  }

  // 1b. lucide-react-native (the viewer surface) — only when the submodule is installed.
  const viewerRoot = process.env['CAMSTACK_VIEWER_ROOT'] ?? join(ROOT, 'camstack')
  const viewerDir = join(viewerRoot, 'node_modules/lucide-react-native')
  const viewerVersion = installedVersion(viewerDir)
  if (viewerVersion === undefined) {
    process.stdout.write(
      'check-icon-catalog: SKIPPED the viewer half — camstack/node_modules/lucide-react-native is not on disk ' +
        '(the submodule is absent in CI). The web half ran.\n',
    )
  } else {
    if (viewerVersion !== ICON_CATALOG_SOURCE.lucideReactNative) {
      failures.push(
        `icon-catalog.generated.ts was generated against lucide-react-native ${ICON_CATALOG_SOURCE.lucideReactNative}, ` +
          `${viewerVersion} is installed. ${regenerate}`,
      )
    }
    const viewer = readViewerAccepted(viewerDir)
    const bad = undrawableKeys(ICON_KEYS, ICON_ALIASES, viewer)
    if (bad.length > 0) {
      failures.push(
        `${bad.length} catalog entr${bad.length === 1 ? 'y' : 'ies'} lucide-react-native ${viewerVersion} cannot draw: ` +
          `${bad.slice(0, 12).join(', ')}${bad.length > 12 ? ', …' : ''}. ${regenerate}`,
      )
    }
  }

  // 2. No second vocabulary.
  for (const v of secondVocabularies()) {
    failures.push(
      `${v.file}:${v.line} declares a second icon vocabulary (\`${v.text}\`). The only list of icons is ` +
        'ICON_KEYS in packages/types/src/device/icon-catalog.ts (D854); type a glyph table `Partial<Record<IconKey, …>>` instead.',
    )
  }

  if (failures.length > 0) {
    process.stderr.write(`check-icon-catalog: ${failures.length} problem(s)\n`)
    for (const f of failures) process.stderr.write(`  - ${f}\n`)
    process.exit(1)
  }
  process.stdout.write(
    `check-icon-catalog: OK (${ICON_KEYS.length} keys, lucide-react ${webVersion})\n`,
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()

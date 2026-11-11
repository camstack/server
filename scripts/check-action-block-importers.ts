#!/usr/bin/env tsx
/**
 * One action block, and a list of who mounts it (D983 enforcement).
 *
 * "An action" is edited in ONE place: `CommandStep` (a target, a vocabulary action, its
 * arguments) and `ActionList` (a list of steps) in the admin UI. A page that needs the
 * operator to pick an action mounts one of them. Three rules:
 *
 * 1. Every file that imports `CommandStep` or `ActionList` is named in `IMPORTERS` below, with
 *    the surface it serves. A new surface adds its line in the same change; a line whose file
 *    no longer mounts the block is refused, so the list stays true.
 * 2. Nothing outside the block imports `DeviceDoActionFields` (the fields under the block) as
 *    a value. A type-only import is not a picker.
 * 3. No UI file outside the block reads the vocabulary offer types (`LooseVocabOffer`,
 *    `ResolvedVocabAction`): a page that does is building its own action picker.
 *
 * Textual: `.ts` / `.tsx` under `packages/<pkg>/src` are read, not run. Specs, `__tests__`,
 * `dist` and generated code are skipped. Rule 3 looks at `.tsx` files everywhere and at every
 * file of the admin UI and the UI library; `packages/types` and `packages/system` define the
 * vocabulary and are not UI.
 *
 * Usage: npx tsx scripts/check-action-block-importers.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The files that mount the shared action block, and the surface each one serves. */
export const IMPORTERS: Readonly<Record<string, string>> = {
  'packages/addon-admin-ui/src/pages/build/automation/AutomationEditor.tsx':
    'the steps of an automation',
  'packages/addon-admin-ui/src/pages/build/actions/ActionEditor.tsx': 'the steps of an Action',
  'packages/addon-admin-ui/src/pages/build/schedulers/PointEditor.tsx':
    'the steps of a scheduler point',
  'packages/addon-admin-ui/src/components/fan-presets/FanPresetDialog.tsx':
    'the steps of a fan preset',
  'packages/addon-admin-ui/src/components/remote/BindingPanel.tsx':
    'the command a remote key sends',
}

/** The block itself: these read each other and the vocabulary freely. */
const BLOCK_PREFIXES: readonly string[] = [
  'packages/addon-admin-ui/src/pages/build/flow/',
  'packages/addon-admin-ui/src/components/device-do-action/',
  'packages/addon-admin-ui/src/pages/build/automation/ActionList.tsx',
  // The if/else of one step: it nests the list for its branches.
  'packages/addon-admin-ui/src/pages/build/automation/StepGuard.tsx',
]
const UI_PACKAGE_PREFIXES: readonly string[] = [
  'packages/addon-admin-ui/src/',
  'packages/ui-library/src/',
]
const NOT_UI_PREFIXES: readonly string[] = ['packages/types/', 'packages/system/']

const IMPORT_RE = /import\s+(type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/g
const BLOCK_MODULE_RE = /(?:^|\/)(?:CommandStep|ActionList)$/
const FIELDS_MODULE_RE = /(?:^|\/)DeviceDoActionFields$/
const VOCAB_TYPE_RE = /\b(?:LooseVocabOffer|ResolvedVocabAction)\b/

export interface SourceFile {
  /** Repo-relative, forward slashes. */
  readonly path: string
  readonly text: string
}

export interface Violation {
  readonly where: string
  readonly message: string
}

interface ImportLine {
  readonly typeOnly: boolean
  readonly names: string
  readonly from: string
}

function importsOf(text: string): ImportLine[] {
  const out: ImportLine[] = []
  for (const m of text.matchAll(IMPORT_RE)) {
    out.push({ typeOnly: m[1] !== undefined, names: m[2] ?? '', from: m[3] ?? '' })
  }
  return out
}

function startsWithAny(file: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => file.startsWith(prefix))
}

export function findViolations(
  sources: readonly SourceFile[],
  importers: Readonly<Record<string, string>>,
): Violation[] {
  const out: Violation[] = []
  const mounting = new Set<string>()
  for (const source of sources) {
    const inBlock = startsWithAny(source.path, BLOCK_PREFIXES)
    const imports = importsOf(source.text)
    if (!inBlock && imports.some((line) => BLOCK_MODULE_RE.test(line.from))) {
      mounting.add(source.path)
      if (importers[source.path] === undefined) {
        out.push({
          where: source.path,
          message:
            'mounts the shared action block (CommandStep / ActionList) but is not in IMPORTERS of scripts/check-action-block-importers.ts: add the file with the surface it serves',
        })
      }
    }
    if (inBlock) continue
    if (imports.some((line) => !line.typeOnly && FIELDS_MODULE_RE.test(line.from))) {
      out.push({
        where: source.path,
        message:
          'imports DeviceDoActionFields, the fields under the shared action block: mount CommandStep (one step) or ActionList (a list) instead',
      })
    }
    const isUi =
      !startsWithAny(source.path, NOT_UI_PREFIXES) &&
      (source.path.endsWith('.tsx') || startsWithAny(source.path, UI_PACKAGE_PREFIXES))
    if (isUi && imports.some((line) => VOCAB_TYPE_RE.test(line.names))) {
      out.push({
        where: source.path,
        message:
          'reads the action vocabulary offers (LooseVocabOffer / ResolvedVocabAction) in a UI file: an action is picked through CommandStep or ActionList, never a page-made picker',
      })
    }
  }
  for (const file of Object.keys(importers)) {
    if (!mounting.has(file)) {
      out.push({
        where: 'scripts/check-action-block-importers.ts',
        message: `IMPORTERS lists "${file}" which no longer mounts the shared action block: remove the line`,
      })
    }
  }
  return out
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (
      name === 'node_modules' ||
      name === 'dist' ||
      name === '__tests__' ||
      name === 'generated'
    ) {
      continue
    }
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (
      (name.endsWith('.ts') || name.endsWith('.tsx')) &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.spec.tsx')
    ) {
      out.push(full)
    }
  }
}

function main(): number {
  const files: string[] = []
  const packagesDir = path.join(ROOT, 'packages')
  for (const pkg of readdirSync(packagesDir)) {
    const src = path.join(packagesDir, pkg, 'src')
    try {
      if (statSync(src).isDirectory()) walk(src, files)
    } catch {
      // a package without a src directory has nothing to read
    }
  }
  const sources: SourceFile[] = files.map((file) => ({
    path: path.relative(ROOT, file).split(path.sep).join('/'),
    text: readFileSync(file, 'utf8'),
  }))
  const violations = findViolations(sources, IMPORTERS)
  for (const v of violations)
    console.error(`check-action-block-importers: ${v.where}: ${v.message}`)
  if (violations.length === 0) console.log('check-action-block-importers: OK')
  return violations.length === 0 ? 0 : 1
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exit(main())
}

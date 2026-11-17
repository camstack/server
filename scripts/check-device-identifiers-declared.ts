#!/usr/bin/env tsx
/**
 * A provider that writes a device's MAC, serial or vendor uid into its free-form
 * metadata also DECLARES it as a typed identifier (D1059).
 *
 * `metadata` is an editable, untyped blob: an identity value that lives only there
 * can be overwritten by the operator, spelled any way, and is invisible to anything
 * that matches devices by identity. The provider owns the truth and states it once
 * through `declareIdentifiers` (a `BaseDevice` method) or `declareDeviceIdentifiers`
 * (the same thing for a populator that holds a device, not a subclass).
 *
 * Scope: one finding per package under `packages/`. A package is checked when its
 * runtime source (no specs, no generated code, comments stripped) calls
 * `setMetadata`. Its
 * "metadata files" are the runtime files that call `setMetadata` or whose name
 * contains `metadata`; when one of them carries an identity key (`mac`,
 * `macAddress`, `serial`, `serialNumber`, `uid`) as an object key, the package must
 * call `declareIdentifiers(` or `declareDeviceIdentifiers(` somewhere in its
 * runtime source. Textual by design: it does not follow the value, it asks that
 * the declaration exist next to the write.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The packages that own the mechanism itself, not a provider. */
const EXEMPT_PACKAGES = new Set(['types', 'system', 'sdk'])

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  '__mocks__',
])
const SOURCE_RE = /\.(?:ts|tsx|mts)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx|mts)$/
const WRITES_METADATA_RE = /\bsetMetadata\b/
const IDENTITY_KEY_RE = /(?:^|[\s{,(])(mac|macAddress|serial|serialNumber|uid)\??\s*:/m
const DECLARES_RE = /\b(?:declareIdentifiers|declareDeviceIdentifiers)\s*\(/

export interface IdentifierSourceFile {
  readonly pkg: string
  readonly rel: string
  readonly content: string
}

export interface UndeclaredIdentifierFinding {
  readonly pkg: string
  /** The metadata file that carries the identity key. */
  readonly file: string
  readonly key: string
}

/** The source without comments, so a doc line naming `setMetadata` is not a write. */
function code(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

function isMetadataFile(file: IdentifierSourceFile): boolean {
  return WRITES_METADATA_RE.test(file.content) || /metadata/i.test(path.basename(file.rel))
}

export function findUndeclaredIdentifiers(
  files: readonly IdentifierSourceFile[],
): UndeclaredIdentifierFinding[] {
  const byPkg = new Map<string, IdentifierSourceFile[]>()
  for (const f of files) {
    if (EXEMPT_PACKAGES.has(f.pkg)) continue
    byPkg.set(f.pkg, [...(byPkg.get(f.pkg) ?? []), { ...f, content: code(f.content) }])
  }
  const findings: UndeclaredIdentifierFinding[] = []
  for (const [pkg, pkgFiles] of byPkg) {
    if (!pkgFiles.some((f) => WRITES_METADATA_RE.test(f.content))) continue
    if (pkgFiles.some((f) => DECLARES_RE.test(f.content))) continue
    for (const f of pkgFiles.filter(isMetadataFile)) {
      const match = IDENTITY_KEY_RE.exec(f.content)
      if (match !== null) {
        findings.push({ pkg, file: f.rel, key: match[1] ?? '?' })
        break
      }
    }
  }
  return findings
}

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function main(): void {
  const files: IdentifierSourceFile[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    const paths: string[] = []
    walk(path.join(ROOT, 'packages', pkg, 'src'), paths)
    for (const p of paths) {
      files.push({
        pkg,
        rel: path.relative(ROOT, p).split(path.sep).join('/'),
        content: readFileSync(p, 'utf-8'),
      })
    }
  }
  const findings = findUndeclaredIdentifiers(files)
  if (findings.length === 0) {
    console.log(
      `check-device-identifiers-declared: ${files.length} runtime files, every provider that writes an identity into metadata declares it`,
    )
    return
  }
  console.error(
    'check-device-identifiers-declared: these providers write a MAC / serial / uid into device metadata but never declare it as an identifier (D1059) — call `this.declareIdentifiers(...)` (or `declareDeviceIdentifiers`) next to the write:',
  )
  for (const f of findings) console.error(`  ${f.pkg}  ${f.file}  (key: ${f.key})`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}

#!/usr/bin/env tsx
/**
 * Addon `types` entry guard — a self-contained addon build does not emit
 * `.d.ts`, so a `package.json` `types` field points at a file that never
 * exists and breaks tooling that trusts the declaration.
 *
 * Framework packages (`types`, `system`, `sdk`, …) and addons that opt into
 * DTS in their Vite preset may keep `types`. Every other CamStack addon must
 * not declare one until its build actually writes the file.
 *
 * Usage: npx tsx scripts/check-addon-types-entry.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGES = path.join(ROOT, 'packages')

/** Packages allowed to declare `types` without being a self-contained addon. */
const FRAMEWORK_ALLOWLIST: ReadonlySet<string> = new Set([
  '@camstack/types',
  '@camstack/system',
  '@camstack/sdk',
  '@camstack/ui-library',
])

interface PackageJson {
  readonly name?: string
  readonly types?: string
  readonly camstack?: { readonly addons?: readonly unknown[] }
  readonly exports?: Record<string, unknown>
}

function readPackageJson(dir: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as PackageJson
}

function hasTypesEntry(pkg: PackageJson): boolean {
  if (typeof pkg.types === 'string' && pkg.types.length > 0) return true
  const dot = pkg.exports?.['.']
  if (typeof dot === 'object' && dot !== null && 'types' in dot) {
    const t = (dot as { types?: unknown }).types
    return typeof t === 'string' && t.length > 0
  }
  return false
}

function main(): void {
  const errors: string[] = []
  for (const entry of fs.readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('addon-')) continue
    const dir = path.join(PACKAGES, entry.name)
    const pkg = readPackageJson(dir)
    const name = pkg.name ?? entry.name
    if (FRAMEWORK_ALLOWLIST.has(name)) continue
    if (pkg.camstack?.addons === undefined || pkg.camstack.addons.length === 0) continue
    if (!hasTypesEntry(pkg)) continue
    errors.push(
      `${name}: declares \`types\` but self-contained addon builds emit no .d.ts — remove \`types\` and \`exports["."].types\` from package.json`,
    )
  }

  if (errors.length > 0) {
    console.error('\x1b[31m✘ addon types entry\x1b[0m\n')
    for (const line of errors) console.error(`  ${line}`)
    process.exit(1)
  }
  console.log('\x1b[32m✔ addon packages do not declare phantom types entries\x1b[0m')
}

main()

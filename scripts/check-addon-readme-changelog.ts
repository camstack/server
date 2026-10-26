#!/usr/bin/env tsx
/**
 * Every published addon package ships a README and a CHANGELOG, and both are
 * in `files` so `npm pack` includes them.
 *
 * The Addons page reads the README from the npm packument and the CHANGELOG
 * from the tarball. A package that forgets either file publishes a card with
 * nothing to read. Builtins inside `@camstack/system` are not separate
 * packages and are out of scope.
 *
 * Usage: tsx scripts/check-addon-readme-changelog.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PACKAGES = path.join(ROOT, 'packages')

interface Problem {
  readonly pkg: string
  readonly message: string
}

function readJson(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...parsed }
    : {}
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : null
}

function nonEmpty(file: string): boolean {
  if (!fs.existsSync(file)) return false
  return fs.readFileSync(file, 'utf8').trim().length > 0
}

function problemsFor(dirName: string): readonly Problem[] {
  const dir = path.join(PACKAGES, dirName)
  const pkgPath = path.join(dir, 'package.json')
  if (!fs.existsSync(pkgPath)) return []
  const pkg = readJson(pkgPath)
  const camstack = asRecord(pkg['camstack'])
  const addons = camstack?.['addons']
  if (!Array.isArray(addons) || addons.length === 0) return []
  const name = typeof pkg['name'] === 'string' ? pkg['name'] : dirName
  const found: Problem[] = []
  const readme = path.join(dir, 'README.md')
  const changelog = path.join(dir, 'CHANGELOG.md')
  if (!nonEmpty(readme)) {
    found.push({ pkg: name, message: 'README.md is missing or empty' })
  }
  if (!nonEmpty(changelog)) {
    found.push({ pkg: name, message: 'CHANGELOG.md is missing or empty' })
  } else if (!/^# Changelog\b/m.test(fs.readFileSync(changelog, 'utf8'))) {
    found.push({ pkg: name, message: 'CHANGELOG.md must start with a "# Changelog" heading' })
  }
  const files = pkg['files']
  if (!Array.isArray(files)) {
    found.push({ pkg: name, message: 'package.json has no files array, so packing is implicit' })
    return found
  }
  const listed = new Set(files.filter((entry): entry is string => typeof entry === 'string'))
  if (!listed.has('README.md')) {
    found.push({ pkg: name, message: 'files does not include README.md' })
  }
  if (!listed.has('CHANGELOG.md')) {
    found.push({ pkg: name, message: 'files does not include CHANGELOG.md' })
  }
  return found
}

const problems = fs
  .readdirSync(PACKAGES)
  .filter((name) => name.startsWith('addon-'))
  .flatMap((name) => problemsFor(name))

if (problems.length > 0) {
  console.error(`✖ addon README/CHANGELOG: ${problems.length} problem(s)`)
  for (const problem of problems) {
    console.error(`  ${problem.pkg}: ${problem.message}`)
  }
  process.exit(1)
}

console.log('✔ addon README and CHANGELOG are present and packed')

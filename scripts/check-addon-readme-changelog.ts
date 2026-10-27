#!/usr/bin/env tsx
/**
 * Every package that reaches npm (addons and framework packages alike) ships
 * a README and a CHANGELOG, and both are in `files` so `npm pack` includes
 * them. The CHANGELOG keeps a `## [Unreleased]` section for
 * `npm run changelog:add` to write into.
 *
 * The Addons page reads the README from the npm packument and the CHANGELOG
 * from the tarball. A package that forgets either file publishes a card with
 * nothing to read. Builtins inside `@camstack/system` are not separate
 * packages and are out of scope; private packages never publish and are out
 * of scope too.
 *
 * Usage: tsx scripts/check-addon-readme-changelog.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { publishedPackages, type WorkspacePackage } from './lib/workspace-packages'

const ROOT = path.resolve(import.meta.dirname, '..')

export interface Problem {
  readonly pkg: string
  readonly message: string
}

function nonEmpty(file: string): boolean {
  if (!fs.existsSync(file)) return false
  return fs.readFileSync(file, 'utf8').trim().length > 0
}

export function problemsFor(root: string, pkg: WorkspacePackage): readonly Problem[] {
  const found: Problem[] = []
  const readme = path.join(root, pkg.dir, 'README.md')
  const changelog = path.join(root, pkg.dir, 'CHANGELOG.md')
  if (!nonEmpty(readme)) {
    found.push({ pkg: pkg.name, message: 'README.md is missing or empty' })
  }
  if (!nonEmpty(changelog)) {
    found.push({ pkg: pkg.name, message: 'CHANGELOG.md is missing or empty' })
  } else {
    const text = fs.readFileSync(changelog, 'utf8')
    if (!/^# Changelog\b/m.test(text)) {
      found.push({ pkg: pkg.name, message: 'CHANGELOG.md must start with a "# Changelog" heading' })
    }
    if (!/^## \[Unreleased\]/m.test(text)) {
      found.push({ pkg: pkg.name, message: 'CHANGELOG.md has no "## [Unreleased]" section' })
    }
  }
  const files = pkg.manifest['files']
  if (!Array.isArray(files)) {
    found.push({ pkg: pkg.name, message: 'package.json has no files array, so packing is implicit' })
    return found
  }
  const listed = new Set(files.filter((entry): entry is string => typeof entry === 'string'))
  if (!listed.has('README.md')) {
    found.push({ pkg: pkg.name, message: 'files does not include README.md' })
  }
  if (!listed.has('CHANGELOG.md')) {
    found.push({ pkg: pkg.name, message: 'files does not include CHANGELOG.md' })
  }
  return found
}

export function allProblems(root: string): readonly Problem[] {
  return publishedPackages(root).flatMap((pkg) => problemsFor(root, pkg))
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const problems = allProblems(ROOT)
  if (problems.length > 0) {
    console.error(`✖ package README/CHANGELOG: ${problems.length} problem(s)`)
    for (const problem of problems) {
      console.error(`  ${problem.pkg}: ${problem.message}`)
    }
    process.exit(1)
  }
  console.log('✔ README and CHANGELOG are present and packed for every published package')
}

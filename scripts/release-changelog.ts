#!/usr/bin/env tsx
/**
 * Release step of the Publish Packages workflow: after the version bump, move
 * each bumped package's `## [Unreleased]` entries under
 * `## [<new version>] - <date>`. A package with no entries (forced through
 * `force_packages`, or published for its closure) gets
 * "Rebuilt against updated dependencies."
 *
 *   tsx scripts/release-changelog.ts <dir>[,<dir>…] [--date YYYY-MM-DD]
 *
 * It reads the version from each package.json, so it must run AFTER the bump
 * (and after a dropped bundler's bump was reverted), and BEFORE `npm publish`
 * so the tarball carries the released changelog.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { firstRelease, releaseUnreleased } from './lib/changelog'
import { readWorkspacePackages } from './lib/workspace-packages'

const ROOT = path.resolve(import.meta.dirname, '..')

export function releaseDirs(
  root: string,
  dirs: readonly string[],
  date: string,
): readonly string[] {
  const packages = readWorkspacePackages(root)
  const messages: string[] = []
  for (const dir of dirs) {
    const pkg = packages.find((candidate) => candidate.dir === dir)
    if (pkg === undefined || pkg.isPrivate) continue
    const file = path.join(root, dir, 'CHANGELOG.md')
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        firstRelease(pkg.version, date, ['Rebuilt against updated dependencies.']),
      )
      messages.push(`${dir}: created CHANGELOG.md at ${pkg.version}`)
      continue
    }
    const result = releaseUnreleased(fs.readFileSync(file, 'utf8'), pkg.version, date)
    if (result.skipped) {
      messages.push(`${dir}: ${pkg.version} already in CHANGELOG.md`)
      continue
    }
    fs.writeFileSync(file, result.text)
    messages.push(`${dir}: released ${pkg.version}${result.rebuilt ? ' (rebuilt line)' : ''}`)
  }
  return messages
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  const args = process.argv.slice(2)
  const dateIndex = args.indexOf('--date')
  const date =
    dateIndex === -1 ? new Date().toISOString().slice(0, 10) : (args[dateIndex + 1] ?? '')
  const list = args[0] !== undefined && !args[0].startsWith('--') ? args[0] : ''
  const dirs = list
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  for (const message of releaseDirs(ROOT, dirs, date)) console.log(`release-changelog: ${message}`)
}

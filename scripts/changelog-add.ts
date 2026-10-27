#!/usr/bin/env tsx
/**
 * Add one line under `## [Unreleased]` of a package's CHANGELOG.md.
 *
 *   npm run changelog:add -- <package> "<line>" [--type added|changed|fixed|removed]
 *
 * `<package>` is the directory name (`addon-ai`), the npm name
 * (`@camstack/addon-ai`) or a repo path. Write what changed for the OPERATOR,
 * one line, in English. The Publish Packages workflow moves the entries under
 * the new version; `scripts/check-changelog-unreleased.ts` refuses a publish
 * of a changed package that has none.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CHANGE_TYPES, addEntry, isChangeType, type ChangeType } from './lib/changelog'
import { readWorkspacePackages, resolvePackage } from './lib/workspace-packages'

const ROOT = path.resolve(import.meta.dirname, '..')

interface Parsed {
  readonly pkg: string
  readonly line: string
  readonly type: ChangeType
}

function parseArgs(argv: readonly string[]): Parsed | string {
  const positional: string[] = []
  let type: ChangeType = 'changed'
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--type' || arg === '-t') {
      const value = argv[i + 1] ?? ''
      if (!isChangeType(value)) return `--type must be one of ${CHANGE_TYPES.join(', ')}`
      type = value
      i += 1
    } else {
      positional.push(arg)
    }
  }
  const [pkg, ...words] = positional
  const line = words.join(' ').trim()
  if (pkg === undefined || line.length === 0) {
    return 'usage: npm run changelog:add -- <package> "<line>" [--type added|changed|fixed|removed]'
  }
  return { pkg, line, type }
}

const parsed = parseArgs(process.argv.slice(2))
if (typeof parsed === 'string') {
  console.error(parsed)
  process.exit(2)
}
const target = resolvePackage(readWorkspacePackages(ROOT), parsed.pkg)
if (target === null) {
  console.error(`changelog:add: no workspace package matches "${parsed.pkg}"`)
  process.exit(2)
}
const file = path.join(ROOT, target.dir, 'CHANGELOG.md')
const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
fs.writeFileSync(file, addEntry(current, parsed.line, parsed.type))
console.log(`changelog:add: ${target.dir}/CHANGELOG.md [Unreleased] ${parsed.type}: ${parsed.line}`)

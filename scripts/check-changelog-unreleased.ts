#!/usr/bin/env tsx
/**
 * A published package whose own files changed since the last `publish-*` tag
 * must have at least one entry under `## [Unreleased]` in its CHANGELOG.md.
 *
 * The diff base is the one the Publish Packages workflow uses: the newest
 * `publish-*` tag (see "Find last publish tag" in
 * .github/workflows/publish-packages.yml), and "own files" is the same
 * `directOwners` the workflow's affected detection runs. Changes that say
 * nothing to an operator do not count: specs, the changelog and README
 * themselves, and the agent notes.
 *
 * A second check: every entry line a CHANGELOG.md gained since the base must sit
 * under `## [Unreleased]` — a hunk cherry-picked across a publish lands under
 * the released heading, and is named with the fix.
 *
 * Usage:
 *   tsx scripts/check-changelog-unreleased.ts [--base <ref>] [--only <dir>,<dir>]
 *
 * `--only` narrows the check to the packages a publish run is about to ship.
 * No publish tag at all means there is nothing to compare against: the check
 * passes (the workflow publishes everything in that case).
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { directOwners } from './ci/publish-scope.mjs'
import { REBUILT_LINE, unreleasedEntryCount } from './lib/changelog'
import { readWorkspacePackages } from './lib/workspace-packages'

const ROOT = path.resolve(import.meta.dirname, '..')

export interface MissingEntry {
  readonly dir: string
  readonly name: string
  /** A few of the changed files, so the message says what moved. */
  readonly sample: readonly string[]
}

const IGNORED_NAMES = new Set(['CHANGELOG.md', 'README.md', 'AGENTS.md', 'CLAUDE.md'])
const SPEC_PATTERN = /\.(spec|test)\.[cm]?[jt]sx?$/

/** True when a package-relative path is a change an operator could notice. */
export function isUserVisibleChange(relativePath: string): boolean {
  const segments = relativePath.split('/')
  if (segments.includes('__tests__') || segments.includes('docs')) return false
  const base = segments[segments.length - 1] ?? ''
  if (IGNORED_NAMES.has(base) || SPEC_PATTERN.test(base)) return false
  return true
}

export function missingEntries(options: {
  readonly root: string
  readonly changedFiles: readonly string[]
  readonly only?: readonly string[]
}): readonly MissingEntry[] {
  const { root, changedFiles, only } = options
  const packages = readWorkspacePackages(root)
  const visible = changedFiles.filter((file) => {
    const owner = packages.find((pkg) => file.startsWith(`${pkg.dir}/`))
    return owner !== undefined && isUserVisibleChange(file.slice(owner.dir.length + 1))
  })
  const missing: MissingEntry[] = []
  for (const dir of directOwners(visible, root)) {
    const pkg = packages.find((candidate) => candidate.dir === dir)
    if (pkg === undefined || pkg.isPrivate) continue
    if (only !== undefined && !only.includes(dir)) continue
    const file = path.join(root, dir, 'CHANGELOG.md')
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    if (unreleasedEntryCount(text) > 0) continue
    missing.push({
      dir,
      name: pkg.name,
      sample: visible.filter((entry) => entry.startsWith(`${dir}/`)).slice(0, 3),
    })
  }
  return missing
}

export function describeMissing(missing: readonly MissingEntry[]): string {
  const lines = [
    `✖ changelog: ${missing.length} package(s) changed since the last publish tag with no [Unreleased] entry`,
  ]
  for (const entry of missing) {
    lines.push(`  ${entry.name} (${entry.dir}) — e.g. ${entry.sample.join(', ')}`)
    lines.push(
      `    npm run changelog:add -- ${entry.dir.split('/')[1]} "<what changed for the operator, one line>" --type changed`,
    )
  }
  return lines.join('\n')
}

export interface MisplacedEntry {
  readonly dir: string
  readonly name: string
  readonly line: string
  /** The released heading the line landed under. */
  readonly heading: string
}

const LINE_PREVIEW = 100

/** Entry lines (`- …`) a unified diff adds; the publish bot's rebuilt line is not one. */
export function addedEntryLines(diff: string): readonly string[] {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trimEnd())
    .filter((line) => /^-\s+\S/.test(line) && line !== `- ${REBUILT_LINE}`)
}

/**
 * Added entry lines that sit under a released heading and nowhere under
 * `## [Unreleased]`: a hunk cherry-picked across a publish.
 */
export function misplacedEntries(
  changelogText: string,
  addedLines: readonly string[],
): readonly { readonly line: string; readonly heading: string }[] {
  const placed = new Map<string, { unreleased: boolean; released: string | null }>()
  let heading = ''
  for (const raw of changelogText.split('\n')) {
    const line = raw.trimEnd()
    if (/^##\s/.test(line)) {
      heading = line
      continue
    }
    if (!/^-\s+\S/.test(line) || heading === '') continue
    const entry = placed.get(line) ?? { unreleased: false, released: null }
    if (heading === '## [Unreleased]') entry.unreleased = true
    else entry.released ??= heading
    placed.set(line, entry)
  }
  const out: { line: string; heading: string }[] = []
  for (const line of new Set(addedLines)) {
    const entry = placed.get(line)
    if (entry !== undefined && !entry.unreleased && entry.released !== null) {
      out.push({ line, heading: entry.released })
    }
  }
  return out
}

export function describeMisplaced(misplaced: readonly MisplacedEntry[]): string {
  const lines = [
    `✖ changelog: ${misplaced.length} line(s) added since the last publish tag sit under a released heading`,
  ]
  for (const entry of misplaced) {
    const preview =
      entry.line.length > LINE_PREVIEW ? `${entry.line.slice(0, LINE_PREVIEW)}…` : entry.line
    lines.push(`  ${entry.name} (${entry.dir}) — "${preview}" is under ${entry.heading}`)
    lines.push('    move it under ## [Unreleased]')
  }
  return lines.join('\n')
}

function findMisplaced(base: string, changedFiles: readonly string[]): readonly MisplacedEntry[] {
  const packages = readWorkspacePackages(ROOT)
  const out: MisplacedEntry[] = []
  for (const file of changedFiles) {
    if (path.basename(file) !== 'CHANGELOG.md') continue
    const abs = path.join(ROOT, file)
    if (!fs.existsSync(abs)) continue
    const added = addedEntryLines(git('diff', '--unified=0', base, '--', file))
    const pkg = packages.find((candidate) => `${candidate.dir}/CHANGELOG.md` === file)
    for (const hit of misplacedEntries(fs.readFileSync(abs, 'utf8'), added)) {
      out.push({ dir: pkg?.dir ?? path.dirname(file), name: pkg?.name ?? file, ...hit })
    }
  }
  return out
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * CI compares against the newest `publish-*` tag on origin. A clone that has
 * not fetched the last publish's tag would grade against an older base and
 * pass a change CI then refuses, so fetch the tags first (best effort: an
 * offline run keeps the local tags and says so).
 */
function fetchPublishTags(): void {
  try {
    execFileSync('git', ['fetch', '--quiet', '--tags', 'origin'], {
      stdio: 'ignore',
      timeout: 30_000,
    })
  } catch {
    console.log(
      '⚠ changelog: could not fetch publish tags from origin — grading against local tags',
    )
  }
}

function main(): number {
  if (argValue('--base') === undefined) fetchPublishTags()
  const base =
    argValue('--base') ??
    git('tag', '--list', 'publish-*', '--sort=-creatordate').split('\n')[0]?.trim()
  if (base === undefined || base === '') {
    console.log('✔ changelog: no publish tag, nothing to compare against')
    return 0
  }
  const changedFiles = git('diff', '--name-only', base, '--', '.', ':(exclude)package-lock.json')
    .split('\n')
    .filter(Boolean)
  const onlyArg = argValue('--only')
  const only =
    onlyArg === undefined
      ? undefined
      : onlyArg
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
  const missing = missingEntries({
    root: ROOT,
    changedFiles,
    ...(only === undefined ? {} : { only }),
  })
  const misplaced = findMisplaced(base, changedFiles)
  if (misplaced.length > 0) console.error(describeMisplaced(misplaced))
  if (missing.length > 0) console.error(describeMissing(missing))
  if (missing.length > 0 || misplaced.length > 0) return 1
  console.log(`✔ changelog: every package changed since ${base} has an [Unreleased] entry`)
  return 0
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(main())
}

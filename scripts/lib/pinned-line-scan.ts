/**
 * A ratchet over a textual pattern: count the matching lines per file, compare
 * with a pinned count, fail when a file grows past its pin or a pin is stale.
 * The pin only ever goes DOWN — a migration that removes a hit lowers it in the
 * same commit, so the debt is a number that shrinks, not a paragraph.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  '__mocks__',
])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx|mts|cts)$/

export interface ScannedFile {
  readonly rel: string
  readonly content: string
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
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

/** Runtime source: every package's `src` and the backend's, minus the files `skip` names. */
export function readRuntimeSource(root: string, skip: (rel: string) => boolean): ScannedFile[] {
  const roots = [path.join(root, 'server/backend/src')]
  for (const pkg of readdirSync(path.join(root, 'packages'))) {
    roots.push(path.join(root, 'packages', pkg, 'src'))
  }
  const paths: string[] = []
  for (const dir of roots) walk(dir, paths)
  return paths
    .map((p) => ({
      rel: path.relative(root, p).split(path.sep).join('/'),
      content: readFileSync(p, 'utf-8'),
    }))
    .filter((f) => !skip(f.rel))
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export function countMatchingLines(
  files: readonly ScannedFile[],
  pattern: RegExp,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const { rel, content } of files) {
    let n = 0
    for (const text of content.split('\n')) {
      if (!isCommentLine(text) && pattern.test(text)) n += 1
    }
    if (n > 0) counts.set(rel, n)
  }
  return counts
}

export function compareToPins(
  counts: ReadonlyMap<string, number>,
  pins: Readonly<Record<string, number>>,
): string[] {
  const problems: string[] = []
  for (const [file, n] of counts) {
    const pinned = pins[file] ?? 0
    if (n > pinned)
      problems.push(`${file}: ${n} hit(s), pinned ${pinned} — new ones are not allowed`)
  }
  for (const [file, pinned] of Object.entries(pins)) {
    const n = counts.get(file) ?? 0
    if (n < pinned) problems.push(`${file}: ${n} hit(s), pinned ${pinned} — lower the pin`)
  }
  return problems
}

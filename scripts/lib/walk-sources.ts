/**
 * walk-sources — the ONE way a repository guard enumerates the files it judges.
 *
 * Why this exists (2026-09-20). Every guard carried a private `walk()`: its own
 * skip set, its own extension filter, its own idea of what a comment is — and
 * sixty of them had no idea at all. Two of the three causes of the 14 red CI
 * runs of 2026-09-18/19 were exactly that: `check-cgroup-path-single-owner`
 * fired on a cgroup path quoted in a DOCBLOCK, and a whole-tree walk from the
 * repository root cost `check-no-service-account-keys` 130 s under load,
 * because it descended into everything `git` never carries.
 *
 * Two decisions, both visible in the signature:
 *
 *  1. **A guard judges what a commit CARRIES.** The file list comes from
 *     `git ls-files`, not from `readdir`: build output, worktrees, agent data
 *     roots, the viewer submodule's `node_modules` and every other untracked
 *     tree are not the guard's business, and not walking them is where the
 *     time goes. (A guard that must see untracked files — none does today —
 *     can pass `tracked: false` and get the old `readdir` walk.)
 *
 *  2. **A comment is not code.** Every entry carries `source` (verbatim, for
 *     the guards whose subject is TEXT — a private key in a comment is still a
 *     leak) and `code` (comments blanked to spaces, line count preserved, for
 *     the guards whose subject is what EXECUTES). A guard picks one and says
 *     which; a `//` inside a string literal is left alone, so the worst case is
 *     a dropped match, never an invented one.
 *
 * The other fifty-five guards keep their private walkers for now — D548 says
 * why: a mass edit across the whole set was judged not worth its blast radius
 * on the day this landed. Move one here when you touch it.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface SourceFile {
  /** Absolute path. */
  readonly file: string
  /** Repo-relative, forward slashes. */
  readonly rel: string
  /** Verbatim contents. */
  readonly source: string
  /** Contents with every comment blanked to spaces; line numbers survive. */
  readonly code: string
}

export interface WalkOptions {
  /** Extensions to keep. Default: TypeScript/JavaScript source. */
  readonly extensions?: readonly string[]
  /** Keep `*.spec.*`, `*.test.*` and `__tests__/` files. Default false. */
  readonly includeTests?: boolean
  /** Keep `*.d.ts`. Default false. */
  readonly includeDeclarations?: boolean
  /** Enumerate via `git ls-files` (default) or `readdir`. */
  readonly tracked?: boolean
  /**
   * Keep tracked BUILD OUTPUT ({@link TRACKED_BUILD_OUTPUT}). Default false: a
   * guard about what source code DOES has no verdict on a minified bundle that
   * another repository built. A guard about TEXT — a leaked credential — asks
   * for it, because a key in a bundle still ships.
   */
  readonly includeBuildOutput?: boolean
}

/**
 * Tracked paths that are build output, not source. The viewer's web bundle is
 * built in the `camstack` submodule's repository (with its own CI) and
 * committed here so the orchestrator can serve it. It inlines every enum
 * member it imports from `@camstack/types`, so a source guard naming an
 * owner-only identifier fired on it the day a pin first bundled one
 * (2026-10-01: `check-field-claims` and `check-owner-only-events`, red on
 * three minified files).
 */
export const TRACKED_BUILD_OUTPUT: readonly RegExp[] = [
  // EXACT bundle locations, not the viewer directory: a hand-written file that
  // lands beside the bundle is source, and must still be judged (D695 review).
  /^packages\/addon-pipeline-orchestrator\/assets\/viewer\/_expo\/static\/js\/web\/[^/]+\.js$/,
  /^packages\/addon-pipeline-orchestrator\/assets\/viewer\/embed\/assets\/[^/]+\.js$/,
]

const DEFAULT_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']

/** Directories the `readdir` fallback never enters. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.nx',
  '.next',
  'ios',
  'android',
  'releases',
])

/**
 * Blank block and line comments to spaces, preserving line structure.
 *
 * Strings are respected only enough to not cut a `//` inside a quoted literal
 * (`'https://…'`): the scanner tracks whether it is inside `'`, `"` or a
 * template literal. Nested templates and regex literals are not modelled —
 * both can only DROP a match, which is the safe direction for a guard.
 */
export function stripComments(source: string): string {
  const out: string[] = []
  let i = 0
  let quote: string | null = null
  while (i < source.length) {
    const ch = source[i] ?? ''
    const next = source[i + 1] ?? ''
    if (quote !== null) {
      out.push(ch)
      if (ch === '\\') {
        out.push(next)
        i += 2
        continue
      }
      if (ch === quote || (ch === '\n' && quote !== '`')) quote = null
      i += 1
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out.push(ch)
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      for (let j = i; j < stop; j++) out.push(source[j] === '\n' ? '\n' : ' ')
      i = stop
      continue
    }
    if (ch === '/' && next === '/') {
      let j = i
      while (j < source.length && source[j] !== '\n') {
        out.push(' ')
        j++
      }
      i = j
      continue
    }
    out.push(ch)
    i += 1
  }
  return out.join('')
}

function isTestPath(rel: string): boolean {
  return (
    rel.includes('/__tests__/') || rel.includes('/__mocks__/') || /\.(spec|test)\.[a-z]+$/.test(rel)
  )
}

function trackedUnder(root: string, roots: readonly string[]): string[] {
  const present = roots.filter((r) => fs.existsSync(path.join(root, r)))
  if (present.length === 0) return []
  const out = execFileSync('git', ['ls-files', '-z', '--', ...present], {
    cwd: root,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out.split('\0').filter((f) => f.length > 0)
}

function readdirUnder(root: string, roots: readonly string[]): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'))
    }
  }
  for (const r of roots) walk(path.join(root, r))
  return out
}

/**
 * Every source file under `roots` (repo-relative directories), read once.
 * A root that does not exist contributes nothing.
 */
export function walkSources(
  root: string,
  roots: readonly string[],
  options: WalkOptions = {},
): readonly SourceFile[] {
  const extensions = new Set(options.extensions ?? DEFAULT_EXTENSIONS)
  const rels = options.tracked === false ? readdirUnder(root, roots) : trackedUnder(root, roots)
  const out: SourceFile[] = []
  for (const rel of rels) {
    const ext = path.extname(rel)
    if (!extensions.has(ext)) continue
    if (!options.includeDeclarations && rel.endsWith('.d.ts')) continue
    if (!options.includeTests && isTestPath(rel)) continue
    if (!options.includeBuildOutput && TRACKED_BUILD_OUTPUT.some((p) => p.test(rel))) {
      continue
    }
    const file = path.join(root, rel)
    let source: string
    try {
      source = fs.readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    out.push({ file, rel, source, code: stripComments(source) })
  }
  return out
}

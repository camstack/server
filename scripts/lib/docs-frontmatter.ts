/**
 * The primitives both halves of the docs system read the repository with.
 *
 * `check-docs-drift.ts` (the guard) and `subsystem-map.ts` (the index) ask the
 * same four questions — what does this document claim, what files exist, does
 * this glob match, when did that code last change — and if they answered them
 * with two copies of the code they would eventually disagree about what a claim
 * IS. A doc could then be covered in the index and unguarded by the ratchet, or
 * the reverse, and nothing would report the contradiction. So the definitions
 * live here once.
 *
 * The two set expressions in `claimGlobs` / `stalenessGlobs` are the whole of
 * D145: `covers:` claims coverage and arms nothing, `applies-to:` does both.
 */
import { execFileSync } from 'node:child_process'

export interface Frontmatter {
  /** "I verified this page against these files on `last-verified`." */
  readonly appliesTo: readonly string[]
  /** "This page describes these files." Coverage only — never staleness (D145). */
  readonly covers: readonly string[]
  readonly lastVerified: string | null
}

export interface ParsedFrontmatter {
  readonly fm: Frontmatter
  /** Line offset of the body, so a reported line number points at the real line. */
  readonly offset: number
}

const EMPTY: Frontmatter = { appliesTo: [], covers: [], lastVerified: null }

/** Every glob a document CLAIMS — what the coverage index joins on. */
export function claimGlobs(fm: Frontmatter): readonly string[] {
  return [...fm.appliesTo, ...fm.covers]
}

/**
 * Every glob that ARMS the staleness ratchet — `applies-to` alone.
 *
 * Widening this to include `covers` would make every class-level page (one that
 * describes twenty providers, one of which changes daily) permanently suspect,
 * pinning `--max-stale` above zero forever. See D145.
 */
export function stalenessGlobs(fm: Frontmatter): readonly string[] {
  return fm.appliesTo
}

/**
 * Minimal YAML subset — only the keys the docs system reads, in either flow
 * (`applies-to: [a, b]`) or block (`- a`) form. Deliberately not a YAML parser:
 * a dependency here would be a dependency in the pre-commit hook.
 */
export function parseFrontmatter(body: string): ParsedFrontmatter {
  if (!body.startsWith('---\n')) return { fm: EMPTY, offset: 0 }
  const end = body.indexOf('\n---', 4)
  if (end === -1) return { fm: EMPTY, offset: 0 }
  const block = body.slice(4, end)
  const lines = block.split('\n')

  const appliesTo: string[] = []
  const covers: string[] = []
  let lastVerified: string | null = null
  let openList: string[] | null = null
  for (const line of lines) {
    const listItem = /^\s*-\s+(.+?)\s*$/.exec(line)
    if (openList !== null && listItem) {
      openList.push(listItem[1].replaceAll(/['"]/g, ''))
      continue
    }
    openList = null
    const kv = /^([\w-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, value] = kv
    if (key === 'applies-to' || key === 'covers') {
      const target = key === 'covers' ? covers : appliesTo
      const flow = /^\[(.*)\]$/.exec(value.trim())
      if (flow) {
        for (const part of flow[1].split(',')) {
          const cleaned = part.trim().replaceAll(/['"]/g, '')
          if (cleaned.length > 0) target.push(cleaned)
        }
      } else if (value.trim().length > 0) {
        target.push(value.trim().replaceAll(/['"]/g, ''))
      } else {
        openList = target
      }
      continue
    }
    if (key === 'last-verified') lastVerified = value.trim().replaceAll(/['"]/g, '')
  }
  return { fm: { appliesTo, covers, lastVerified }, offset: block.split('\n').length + 2 }
}

/**
 * Glob → anchored RegExp over repo-relative paths. `**` crosses separators, `*`
 * does not.
 *
 * A TRAILING `**` means "everything below", and it used to compile to
 * `[^/]*[^/]*` — one segment. Nothing caught it, because the only consumer was
 * `check-docs-drift.ts` asking "does this glob match at ALL", and
 * `packages/x/src/**` always matched something directly inside `src/`. The
 * subsystem map COUNTS matches instead of testing for one, so the same bug would
 * have silently orphaned every nested file in the repository.
 */
export function globToRegExp(glob: string): RegExp {
  // ONE pass over the three wildcard forms. Three chained `replaceAll`s would
  // eat each other's output — the `*` pass rewrites the `[^/]*` that the `**`
  // pass just produced — which is how the trailing-`**` bug above survived.
  const escaped = glob.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&')
  const source = escaped.replaceAll(/\*\*\/|\*\*|\*/g, (match) => {
    if (match === '**/') return '(?:.*/)?'
    return match === '**' ? '.*' : '[^/]*'
  })
  return new RegExp(`^${source}$`)
}

/**
 * The repo's files, so a glob can be matched without walking `node_modules`.
 *
 * `--others --exclude-standard` includes files that exist but are not staged
 * yet, which matters locally: a doc written alongside brand-new code would
 * otherwise fail its own glob until the code was added to the index. That
 * leniency is WRONG in CI, where nothing is untracked — `committedOnly` asks the
 * question a fresh clone would ask.
 */
export function repoFiles(root: string, committedOnly: boolean): ReadonlySet<string> {
  const args = committedOnly
    ? ['ls-files', '--cached']
    : ['ls-files', '--cached', '--others', '--exclude-standard']
  const raw = execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    // A working tree with a few thousand un-ignored scratch files exceeds Node's
    // 1MB default and kills the caller with ENOBUFS on every commit. A guard
    // that dies is a guard that stopped guarding.
    maxBuffer: 64 * 1024 * 1024,
  })
  return new Set(raw.split('\n').filter((l) => l.length > 0))
}

/** Newest commit date (YYYY-MM-DD) touching any of `paths`, or null. */
let rootCommitCache: string | null | undefined

/**
 * The repository's initial commit, or `null` when git cannot say.
 *
 * Used to tell "this code changed on that date" apart from "that date is when
 * the history began". See {@link lastCommitDate}.
 */
function rootCommit(root: string): string | null {
  if (rootCommitCache !== undefined) return rootCommitCache
  try {
    const out = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
      cwd: root,
      encoding: 'utf-8',
    }).trim()
    // A repo can have several root commits (a subtree merge). Any of them means
    // the same thing here: the file's history starts at the beginning.
    rootCommitCache = out.length > 0 ? out.split('\n')[0]!.trim() : null
  } catch {
    rootCommitCache = null
  }
  return rootCommitCache
}

/**
 * When the code behind these paths last changed — or `null` when git cannot
 * know.
 *
 * ## Why the initial commit answers `null`
 *
 * This repository's history was squashed to a single initial commit on
 * 2026-09-09, at the operator's request. Afterwards `git log -1` on ANY file
 * answered that day, so every page whose `last-verified` predated it went
 * suspect at once: 36 of them, none because a line of code had moved. The
 * staleness ratchet, whose ceiling is zero, went permanently red — and a guard
 * that is permanently red is the one that gets scrolled past and then disabled,
 * which is exactly what had already happened to this repo's CI.
 *
 * The date was not wrong so much as MEANINGLESS: after a reset, git no longer
 * knows when the described code last changed. Reporting "changed today" turns
 * "I cannot know" into a claim — the same shape D315 forbids of an unanswered
 * query, and D237 of a dropped observation.
 *
 * So a file whose only commit IS the root commit answers `null`, and the caller
 * treats that as "no information" rather than "changed now". Staleness returns
 * on its own the moment a real commit touches the file, which is the only
 * moment it means anything again.
 */
export function lastCommitDate(root: string, paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  try {
    // A RELEASE commit is not a change to the code a document describes.
    //
    // `npm run publish` writes one: it moves `version` in every package.json it
    // publishes, in the lockfile, and in the Unraid deployment templates, which
    // embed the image tag. Nothing else. On 2026-09-09 that made
    // `terminal.md`, `osd-manager.md` and `unraid.md` suspect — three pages
    // whose described code had not moved a line, flagged because a number in a
    // manifest under their glob had.
    //
    // Skipped by SUBJECT because that is what identifies the machine that wrote
    // it. The cost is stated rather than hidden: real work committed under one
    // of these subjects would be invisible to this ratchet. The publish script
    // is the only thing that writes them, and it writes nothing but versions.
    //
    // BOTH subjects, because the workflow changed its wording and the skip did
    // not. `chore(release): publish N package(s)` is the old one; the CI writes
    // `chore: publish packages (patch) [skip ci]` today, and for as long as it
    // has, every version bump has counted as real work. Two agents found this
    // independently on 2026-09-15, each from a different doc flagged for
    // nothing: `terminal.md`, `osd-manager.md` and `unraid.md` are the pages it
    // keeps catching, and they are exactly the ones this skip was written for.
    const sha = execFileSync(
      'git',
      [
        'log',
        '-1',
        '--format=%H',
        '--invert-grep',
        // Multiple `--grep` are OR-ed, and `--invert-grep` inverts the OR.
        '--grep=^chore(release): publish',
        '--grep=^chore: publish packages',
        '--',
        ...paths,
      ],
      { cwd: root, encoding: 'utf-8' },
    ).trim()
    if (sha.length === 0) return null
    if (sha === rootCommit(root)) return null
    const out = execFileSync('git', ['log', '-1', '--format=%cs', sha], {
      cwd: root,
      encoding: 'utf-8',
    }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * Extensions that count as "a unit of this system". Markdown, JSON and shell
 * are deliberately out: a taxonomy that had to claim every fixture and lockfile
 * would be a taxonomy nobody kept accurate.
 */
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.py']

/**
 * Excluded from the file universe the subsystem map measures. The prototype
 * behind `docs/design/documentation-map-and-plan.md` §2.2 got this wrong twice
 * before its numbers meant anything:
 *
 * - tests describe code that is already claimed by the code's own subsystem;
 * - `.claude/worktrees/` is a SECOND CHECKOUT of this repo inside itself, so
 *   every file in it would count twice (the same trap vitest and
 *   `check-docs-drift.ts` each had to be told about);
 * - `dist/` is a copy of source, and `.design-sync` is a vendored mirror.
 */
export function isSourceFile(rel: string): boolean {
  if (!SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext))) return false
  if (rel.endsWith('.config.ts') || rel.endsWith('.d.ts')) return false
  if (/(^|\/)(__tests__|__mocks__|node_modules|dist|build|\.venv)\//.test(rel)) return false
  if (/\.(spec|test)\.[cm]?tsx?$/.test(rel)) return false
  if (rel.startsWith('.claude/') || rel.startsWith('camstack/')) return false
  // `docs/` and `scratchpad/` hold illustrative and throwaway code. A taxonomy
  // that had to claim a frozen spec's example file would be claiming history.
  if (rel.startsWith('docs/') || rel.startsWith('scratchpad/')) return false
  if (rel.includes('/.design-sync/')) return false
  return true
}

/**
 * Public-docs staleness — the pure half of `check-public-docs-staleness.ts`.
 *
 * The public site (repo `camstack/docs`, pages under `content/docs/**.mdx`) is a
 * separate repository, so the internal drift guard cannot see it and nothing told
 * anyone when a page there started describing last week's server. A page now
 * declares, in its frontmatter, the server code it describes — with the same two
 * keys and the same meaning as the internal docs (D145):
 *
 *   - `applies-to:` — "I verified this page against these files on
 *     `last-verified`." Claims the code AND arms the reminder.
 *   - `covers:`     — "this page describes these files." Claims only.
 *
 * Globs are relative to camstack-server. A glob starting `camstack/` names the
 * VIEWER (the submodule), and is matched against the viewer's own history,
 * because the server repo only sees a gitlink there.
 *
 * Everything here is a REMINDER (D751): the CLI exits 0 unless `--strict`.
 *
 * All git access goes through {@link GitPort} so the logic is testable without a
 * repository; `createGitPort` is the real one.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { claimGlobs, globToRegExp, parseFrontmatter, stalenessGlobs } from './docs-frontmatter.js'

/** The viewer is the `camstack/` submodule; its paths are judged in its own history. */
export const VIEWER_PREFIX = 'camstack/'

/** Commits written by the publish train move version numbers, nothing a page describes. */
export const RELEASE_SUBJECTS: readonly RegExp[] = [
  /^chore\(release\): publish/,
  /^chore: publish packages/,
  /^chore: bump version to /,
]

/** How many of the newest relevant commits a stale page lists. */
export const DEFAULT_COMMITS_SHOWN = 5

export type RepoId = 'server' | 'viewer'

export interface Commit {
  readonly hash: string
  /** Committer time, epoch seconds. */
  readonly time: number
  /** Committer date, YYYY-MM-DD in the committer's zone. */
  readonly date: string
  readonly subject: string
}

export interface GitPort {
  /** Tracked files of a repo, or null when that checkout is absent. */
  files(repo: RepoId): ReadonlySet<string> | null
  /** Commits touching any of `pathspecs` (repo-relative globs) after `sinceEpoch`, newest first. */
  commitsAfter(repo: RepoId, pathspecs: readonly string[], sinceEpoch: number): readonly Commit[]
  /** The newest commit touching a docs page (path relative to the docs repo), or null. */
  pageLastCommit(docsRelPath: string): Commit | null
}

export interface PageInput {
  /** Relative to the docs repo, e.g. `content/docs/detection/models.mdx`. */
  readonly file: string
  readonly body: string
}

export interface DeadGlob {
  readonly glob: string
  readonly reason: 'matches-nothing' | 'viewer-absent'
}

export interface PageVerdict {
  readonly file: string
  readonly claims: readonly string[]
  readonly armed: readonly string[]
  readonly lastVerified: string | null
  /** What the reference instant was taken from. */
  readonly reference: 'last-verified' | 'page-commit' | 'none'
  readonly referenceEpoch: number | null
  readonly commits: readonly Commit[]
  readonly dead: readonly DeadGlob[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})$/

/** `camstack/src/x.ts` → viewer + `src/x.ts`; anything else is the server's. */
export function splitRepo(glob: string): {
  readonly repo: RepoId
  readonly spec: string
} {
  if (glob.startsWith(VIEWER_PREFIX)) {
    return { repo: 'viewer', spec: glob.slice(VIEWER_PREFIX.length) }
  }
  return { repo: 'server', spec: glob }
}

/** Does a glob match at least one tracked file (or name a tracked directory)? */
export function globMatches(spec: string, files: ReadonlySet<string>): boolean {
  const clean = spec.replace(/\/$/, '')
  if (files.has(clean)) return true
  const prefix = `${clean}/`
  const re = clean.includes('*') ? globToRegExp(clean) : null
  for (const file of files) {
    if (file.startsWith(prefix)) return true
    if (re !== null && (re.test(file) || re.test(path.posix.dirname(file)))) return true
  }
  return false
}

/** End of a calendar day in the local zone, as epoch seconds. */
export function endOfDayEpoch(isoDate: string): number {
  const [y = 0, m = 1, d = 1] = isoDate.split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d, 23, 59, 59).getTime() / 1000)
}

/**
 * The instant after which a server commit makes the page suspect.
 *
 * `last-verified` is either a DATE (`2026-10-07`, meaning "as of the end of that
 * day") or an ISO DATETIME with an offset (`2026-10-07T05:27:16+02:00`). The
 * datetime form exists because a day is too coarse on a repository that lands
 * dozens of commits a day: a page verified at 05:00 must be flagged for a change
 * at 18:00 the same day. A page's own later commits never count as verification
 * — editing a page is not checking it against the code — so without
 * `last-verified` the page's last commit is only the fallback.
 */
export function referenceInstant(
  lastVerified: string | null,
  pageCommit: Commit | null,
): {
  readonly reference: PageVerdict['reference']
  readonly epoch: number | null
} {
  if (lastVerified !== null) {
    if (ISO_DATE.test(lastVerified)) {
      return { reference: 'last-verified', epoch: endOfDayEpoch(lastVerified) }
    }
    if (ISO_DATETIME.test(lastVerified)) {
      return {
        reference: 'last-verified',
        epoch: Math.floor(Date.parse(lastVerified) / 1000),
      }
    }
  }
  if (pageCommit !== null) return { reference: 'page-commit', epoch: pageCommit.time }
  return { reference: 'none', epoch: null }
}

/** A release commit is not a change to described code. */
export function isReleaseCommit(commit: Commit): boolean {
  return RELEASE_SUBJECTS.some((re) => re.test(commit.subject))
}

function deadGlobs(claims: readonly string[], git: GitPort): DeadGlob[] {
  const out: DeadGlob[] = []
  for (const glob of claims) {
    const { repo, spec } = splitRepo(glob)
    const files = git.files(repo)
    if (files === null) {
      out.push({ glob, reason: 'viewer-absent' })
      continue
    }
    if (!globMatches(spec, files)) out.push({ glob, reason: 'matches-nothing' })
  }
  return out
}

function relevantCommits(armed: readonly string[], since: number, git: GitPort): Commit[] {
  const byRepo = new Map<RepoId, string[]>()
  for (const glob of armed) {
    const { repo, spec } = splitRepo(glob)
    if (git.files(repo) === null) continue
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), spec])
  }
  const all: Commit[] = []
  for (const [repo, specs] of byRepo) {
    for (const c of git.commitsAfter(repo, specs, since)) {
      if (c.time > since && !isReleaseCommit(c)) all.push(c)
    }
  }
  return all.toSorted((a, b) => b.time - a.time)
}

/** Judge one page. */
export function assessPage(page: PageInput, git: GitPort): PageVerdict {
  const { fm } = parseFrontmatter(page.body)
  const claims = claimGlobs(fm)
  const armed = stalenessGlobs(fm)
  const { reference, epoch } = referenceInstant(fm.lastVerified, git.pageLastCommit(page.file))
  const commits = epoch !== null && armed.length > 0 ? relevantCommits(armed, epoch, git) : []
  return {
    file: page.file,
    claims,
    armed,
    lastVerified: fm.lastVerified,
    reference,
    referenceEpoch: epoch,
    commits,
    dead: deadGlobs(claims, git),
  }
}

export interface Report {
  readonly pages: number
  readonly stale: readonly PageVerdict[]
  readonly uncovered: readonly string[]
  readonly dead: readonly PageVerdict[]
}

export function summarize(verdicts: readonly PageVerdict[]): Report {
  return {
    pages: verdicts.length,
    stale: verdicts.filter((v) => v.commits.length > 0),
    uncovered: verdicts.filter((v) => v.claims.length === 0).map((v) => v.file),
    dead: verdicts.filter((v) => v.dead.length > 0),
  }
}

/** Every `.md`/`.mdx` page under `content/docs`, relative to the docs repo. */
export function collectPages(docsRoot: string): PageInput[] {
  const base = path.join(docsRoot, 'content', 'docs')
  const out: PageInput[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else if (/\.mdx?$/.test(entry.name)) {
        const file = path.relative(docsRoot, abs).split(path.sep).join('/')
        out.push({ file, body: fs.readFileSync(abs, 'utf-8') })
      }
    }
  }
  walk(base)
  return out.toSorted((a, b) => a.file.localeCompare(b.file))
}

// ── Rendering ──────────────────────────────────────────────────────────────

function pageName(file: string): string {
  return file.replace(/^content\/docs\//, '').replace(/\.mdx?$/, '')
}

export function renderReport(report: Report, commitsShown: number): string[] {
  const lines: string[] = []
  lines.push(`Public docs staleness — ${report.pages} page(s) checked`)
  lines.push('')
  if (report.stale.length === 0) {
    lines.push('No page describes server code that changed after it was verified.')
  } else {
    lines.push(
      `${report.stale.length} page(s) describe code that changed after they were verified:`,
    )
    for (const v of report.stale) {
      const since = v.lastVerified !== null ? `last-verified ${v.lastVerified}` : 'no last-verified'
      lines.push('')
      lines.push(`  ${pageName(v.file)}  (${since}; ${v.commits.length} newer commit(s))`)
      for (const c of v.commits.slice(0, commitsShown)) {
        lines.push(`      ${c.hash.slice(0, 9)} ${c.date} ${c.subject}`)
      }
      if (v.commits.length > commitsShown) {
        lines.push(`      … ${v.commits.length - commitsShown} more`)
      }
    }
  }
  lines.push('')
  lines.push(
    `${report.uncovered.length} page(s) declare no \`applies-to:\`/\`covers:\` (coverage gap):`,
  )
  lines.push(`  ${report.uncovered.map(pageName).join(', ') || '—'}`)
  if (report.dead.length > 0) {
    lines.push('')
    lines.push(`${report.dead.length} page(s) claim globs that match nothing:`)
    for (const v of report.dead) {
      for (const d of v.dead) {
        const why = d.reason === 'viewer-absent' ? 'viewer checkout absent' : 'matches nothing'
        lines.push(`  ${pageName(v.file)}: \`${d.glob}\` (${why})`)
      }
    }
  }
  return lines
}

// ── The real git port ──────────────────────────────────────────────────────

const GIT_BUFFER = 64 * 1024 * 1024

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: GIT_BUFFER,
  })
}

/** `%H%x09%ct%x09%cs%x09%s` lines → commits. */
export function parseLog(raw: string): Commit[] {
  const out: Commit[] = []
  for (const line of raw.split('\n')) {
    const [hash, time, date, ...subject] = line.split('\t')
    if (!hash || !time || !date) continue
    out.push({ hash, time: Number(time), date, subject: subject.join('\t') })
  }
  return out
}

const LOG_FORMAT = '--format=%H%x09%ct%x09%cs%x09%s'

export interface Roots {
  readonly server: string
  readonly viewer: string | null
  readonly docs: string
}

function isRepo(dir: string | null): dir is string {
  return dir !== null && fs.existsSync(path.join(dir, '.git'))
}

export function createGitPort(roots: Roots): GitPort {
  const repoDir = (repo: RepoId): string | null =>
    repo === 'server' ? roots.server : isRepo(roots.viewer) ? roots.viewer : null
  const fileCache = new Map<RepoId, ReadonlySet<string> | null>()
  return {
    files(repo) {
      if (!fileCache.has(repo)) {
        const dir = repoDir(repo)
        const set =
          dir === null
            ? null
            : new Set(
                git(dir, ['ls-files', '--cached'])
                  .split('\n')
                  .filter((l) => l.length > 0),
              )
        fileCache.set(repo, set)
      }
      return fileCache.get(repo) ?? null
    },
    commitsAfter(repo, specs, sinceEpoch) {
      const dir = repoDir(repo)
      if (dir === null || specs.length === 0) return []
      const pathspecs = specs.map((s) => `:(glob)${s}`)
      const raw = git(dir, ['log', `--since=@${sinceEpoch}`, LOG_FORMAT, '--', ...pathspecs])
      return parseLog(raw)
    },
    pageLastCommit(file) {
      const raw = git(roots.docs, ['log', '-1', LOG_FORMAT, '--', file])
      return parseLog(raw)[0] ?? null
    },
  }
}

// ── Entry (used by the CLI and by the tests) ───────────────────────────────

export interface RunOptions {
  readonly serverRoot: string
  readonly docsRoot: string | null
  readonly viewerRoot: string | null
  readonly strict: boolean
  readonly commitsShown?: number
}

export interface RunResult {
  readonly exitCode: 0 | 1
  readonly lines: readonly string[]
  readonly report: Report | null
}

/**
 * Where the public docs checkout is: `CAMSTACK_DOCS_DIR`, else the sibling
 * `../docs` of camstack-server. Null when neither holds a docs repo.
 */
export function locateDocs(serverRoot: string, env: NodeJS.ProcessEnv): string | null {
  const candidates = [env['CAMSTACK_DOCS_DIR'], path.resolve(serverRoot, '..', 'docs')]
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'content', 'docs'))) return dir
  }
  return null
}

export function run(options: RunOptions): RunResult {
  if (options.docsRoot === null || !fs.existsSync(path.join(options.docsRoot, 'content', 'docs'))) {
    return {
      exitCode: 0,
      report: null,
      lines: [
        'Public docs staleness — skipped: no camstack/docs checkout found.',
        '  Clone it next to camstack-server (../docs) or set CAMSTACK_DOCS_DIR.',
      ],
    }
  }
  const port = createGitPort({
    server: options.serverRoot,
    viewer: options.viewerRoot,
    docs: options.docsRoot,
  })
  const verdicts = collectPages(options.docsRoot).map((page) => assessPage(page, port))
  const report = summarize(verdicts)
  const lines = renderReport(report, options.commitsShown ?? DEFAULT_COMMITS_SHOWN)
  const failing = report.stale.length > 0 || report.dead.length > 0
  return { exitCode: options.strict && failing ? 1 : 0, lines, report }
}

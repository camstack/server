/**
 * The public-docs staleness reminder (D751): a page whose `applies-to` code
 * changed after `last-verified` is listed with the commits; a page claiming
 * nothing is a coverage gap; a glob matching nothing is dead; no docs checkout
 * is a skip, not a failure — and only `--strict` ever exits non-zero.
 *
 * Built on throwaway git repositories with pinned commit dates, because the
 * thing under test is exactly "what does git say changed after this instant".
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  type Commit,
  endOfDayEpoch,
  globMatches,
  isReleaseCommit,
  locateDocs,
  referenceInstant,
  run,
  splitRepo,
} from '../lib/public-docs-staleness.js'

const created: string[] = []
const shared: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

afterAll(() => {
  for (const dir of shared.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pds-${name}-`))
  created.push(dir)
  return dir
}

function git(cwd: string, args: readonly string[], date?: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  })
}

function initRepo(name: string): string {
  const dir = tempDir(name)
  git(dir, ['init', '-q', '-b', 'main'])
  return dir
}

function commitFile(repo: string, file: string, body: string, subject: string, date: string): void {
  const abs = path.join(repo, file)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
  git(repo, ['add', file])
  git(repo, ['commit', '-q', '-m', subject], date)
}

function page(frontmatter: string): string {
  return `---\ntitle: T\ndescription: D\n${frontmatter}---\n\nBody.\n`
}

let serverRepo: string | null = null

/**
 * A server repo with an old root, one real change and one release commit after
 * 2026-10-01. Read-only for every test, so it is built once.
 */
function serverFixture(): string {
  if (serverRepo !== null) return serverRepo
  const repo = initRepo('server')
  created.splice(created.indexOf(repo), 1)
  shared.push(repo)
  serverRepo = repo
  commitFile(repo, 'README.md', 'root', 'chore: root', '2026-09-01T10:00:00+00:00')
  commitFile(repo, 'packages/a/src/engine.ts', '1', 'feat: engine v1', '2026-09-20T10:00:00+00:00')
  commitFile(
    repo,
    'packages/a/src/engine.ts',
    '2',
    'fix(engine): the engine changed',
    '2026-10-05T10:00:00+00:00',
  )
  commitFile(
    repo,
    'packages/a/src/engine.ts',
    '3',
    'chore: publish packages (patch) [skip ci]',
    '2026-10-06T10:00:00+00:00',
  )
  commitFile(repo, 'packages/b/src/other.ts', '1', 'feat: unrelated', '2026-10-06T11:00:00+00:00')
  return repo
}

function docsFixture(pages: Record<string, string>): string {
  const repo = initRepo('docs')
  for (const [name, body] of Object.entries(pages)) {
    commitFile(repo, `content/docs/${name}.mdx`, body, `docs: ${name}`, '2026-10-01T09:00:00+00:00')
  }
  return repo
}

describe('pure pieces', () => {
  it('splits a viewer glob from a server glob', () => {
    expect(splitRepo('camstack/src/x.ts')).toEqual({
      repo: 'viewer',
      spec: 'src/x.ts',
    })
    expect(splitRepo('packages/a/**')).toEqual({
      repo: 'server',
      spec: 'packages/a/**',
    })
  })

  it('matches files, directories and globs', () => {
    const files = new Set(['packages/a/src/engine.ts', 'Dockerfile'])
    expect(globMatches('packages/a/src/**', files)).toBe(true)
    expect(globMatches('packages/a', files)).toBe(true)
    expect(globMatches('Dockerfile', files)).toBe(true)
    expect(globMatches('packages/a/src/*.py', files)).toBe(false)
    expect(globMatches('packages/gone/**', files)).toBe(false)
  })

  it('a date means the end of that day; a datetime is that instant', () => {
    expect(referenceInstant('2026-10-05', null)).toEqual({
      reference: 'last-verified',
      epoch: endOfDayEpoch('2026-10-05'),
    })
    expect(referenceInstant('2026-10-05T10:00:00+00:00', null).epoch).toBe(
      Date.UTC(2026, 9, 5, 10) / 1000,
    )
  })

  it('without last-verified the page commit is the reference; editing a page never counts as verifying it', () => {
    const pageCommit: Commit = {
      hash: 'h',
      time: 42,
      date: '2026-10-01',
      subject: 's',
    }
    expect(referenceInstant(null, pageCommit)).toEqual({
      reference: 'page-commit',
      epoch: 42,
    })
    expect(referenceInstant('2026-10-05', pageCommit).epoch).toBe(endOfDayEpoch('2026-10-05'))
    expect(referenceInstant(null, null)).toEqual({
      reference: 'none',
      epoch: null,
    })
  })

  it('release commits are not changes to described code', () => {
    const c = (subject: string): Commit => ({
      hash: 'h',
      time: 1,
      date: 'd',
      subject,
    })
    expect(isReleaseCommit(c('chore: publish packages (patch) [skip ci]'))).toBe(true)
    expect(isReleaseCommit(c('chore(release): publish 3 package(s)'))).toBe(true)
    expect(isReleaseCommit(c('fix(engine): the engine changed'))).toBe(false)
  })
})

describe('the reminder against real repositories', () => {
  it('flags a page whose applies-to code changed after last-verified, listing the commit', () => {
    const server = serverFixture()
    const docs = docsFixture({
      stale: page(
        "last-verified: '2026-10-01T00:00:00+00:00'\napplies-to:\n  - 'packages/a/src/**'\n",
      ),
      fresh: page("last-verified: 2026-10-06\napplies-to:\n  - 'packages/a/src/**'\n"),
    })
    const result = run({
      serverRoot: server,
      docsRoot: docs,
      viewerRoot: null,
      strict: false,
    })
    expect(result.exitCode).toBe(0)
    const stale = result.report?.stale ?? []
    expect(stale.map((v) => v.file)).toEqual(['content/docs/stale.mdx'])
    // The release commit and the unrelated file are not evidence.
    expect(stale[0]?.commits.map((c) => c.subject)).toEqual(['fix(engine): the engine changed'])
    expect(result.lines.join('\n')).toContain('fix(engine): the engine changed')
  })

  it('without last-verified, measures from the page last commit', () => {
    const server = serverFixture()
    const docs = docsFixture({
      nodate: page("applies-to:\n  - 'packages/a/src/engine.ts'\n"),
    })
    const result = run({
      serverRoot: server,
      docsRoot: docs,
      viewerRoot: null,
      strict: false,
    })
    expect(result.report?.stale.map((v) => v.reference)).toEqual(['page-commit'])
  })

  it('covers: claims coverage but never arms the reminder (D145)', () => {
    const server = serverFixture()
    const docs = docsFixture({
      claimed: page("last-verified: 2026-09-01\ncovers:\n  - 'packages/a/src/**'\n"),
    })
    const result = run({
      serverRoot: server,
      docsRoot: docs,
      viewerRoot: null,
      strict: false,
    })
    expect(result.report?.stale).toEqual([])
    expect(result.report?.uncovered).toEqual([])
  })

  it('lists a page with no claims as a coverage gap', () => {
    const server = serverFixture()
    const docs = docsFixture({
      bare: page(''),
      claimed: page("covers: ['packages/a/**']\n"),
    })
    const result = run({
      serverRoot: server,
      docsRoot: docs,
      viewerRoot: null,
      strict: false,
    })
    expect(result.report?.uncovered).toEqual(['content/docs/bare.mdx'])
    expect(result.lines.join('\n')).toContain('coverage gap')
  })

  it('reports a glob that matches nothing, and a viewer glob when the viewer is absent', () => {
    const server = serverFixture()
    const docs = docsFixture({
      dead: page(
        "applies-to:\n  - 'packages/gone/**'\n  - 'camstack/src/x.ts'\n  - 'packages/a/src/engine.ts'\n",
      ),
    })
    const result = run({
      serverRoot: server,
      docsRoot: docs,
      viewerRoot: null,
      strict: false,
    })
    expect(result.exitCode).toBe(0)
    expect(result.report?.dead[0]?.dead).toEqual([
      { glob: 'packages/gone/**', reason: 'matches-nothing' },
      { glob: 'camstack/src/x.ts', reason: 'viewer-absent' },
    ])
  })

  it('judges a camstack/ glob in the viewer history', () => {
    const server = serverFixture()
    const viewer = initRepo('viewer')
    commitFile(viewer, 'src/screen.tsx', '1', 'feat: screen', '2026-10-04T10:00:00+00:00')
    const docs = docsFixture({
      app: page("last-verified: 2026-10-02\napplies-to:\n  - 'camstack/src/screen.tsx'\n"),
    })
    const result = run({
      serverRoot: server,
      docsRoot: docs,
      viewerRoot: viewer,
      strict: false,
    })
    expect(result.report?.dead).toEqual([])
    expect(result.report?.stale[0]?.commits.map((c) => c.subject)).toEqual(['feat: screen'])
  })

  it('--strict exits 1 on a stale page; the default never does', () => {
    const server = serverFixture()
    const docs = docsFixture({
      stale: page("last-verified: 2026-10-01\napplies-to:\n  - 'packages/a/src/**'\n"),
    })
    expect(
      run({
        serverRoot: server,
        docsRoot: docs,
        viewerRoot: null,
        strict: false,
      }).exitCode,
    ).toBe(0)
    expect(
      run({
        serverRoot: server,
        docsRoot: docs,
        viewerRoot: null,
        strict: true,
      }).exitCode,
    ).toBe(1)
  })

  it('skips with a message, exit 0, when there is no docs checkout', () => {
    const server = serverFixture()
    const result = run({
      serverRoot: server,
      docsRoot: null,
      viewerRoot: null,
      strict: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.report).toBeNull()
    expect(result.lines[0]).toContain('skipped')
    expect(locateDocs(server, { CAMSTACK_DOCS_DIR: path.join(server, 'nope') })).toBeNull()
  })

  it('finds the docs checkout through CAMSTACK_DOCS_DIR', () => {
    const docs = docsFixture({ bare: page('') })
    expect(locateDocs(tempDir('elsewhere'), { CAMSTACK_DOCS_DIR: docs })).toBe(docs)
  })
})

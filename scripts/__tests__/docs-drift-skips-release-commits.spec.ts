/**
 * A version bump is not work on the code a document describes.
 *
 * `lastCommitDate` skips the publish script's own commits by SUBJECT, because
 * that is what identifies the machine that wrote them: they touch every
 * `package.json` and every Unraid template to move a number, and nothing else.
 * Without the skip, every release makes suspect every page whose `applies-to`
 * globs happen to include a manifest.
 *
 * The skip matched one subject and the workflow had since started writing
 * another. Measured in this repo's own history on 2026-09-15: 15 commits under
 * `chore(release): publish N package(s)` (skipped, correctly) and 15 under
 * `chore: publish packages (patch) [skip ci]` (NOT skipped — the subject CI
 * writes today). For as long as that has been true, every version bump has
 * counted as real work.
 *
 * Two agents found it independently the same afternoon, each arriving from a
 * different page flagged for nothing: `terminal.md`, `osd-manager.md` and
 * `unraid.md` — which are precisely the pages the skip exists to protect.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.join(__dirname, '..', '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'docs-frontmatter.ts'), 'utf8')

/** The `--grep` patterns the skip actually passes to git. */
function grepPatterns(): readonly string[] {
  return [...SOURCE.matchAll(/'--grep=([^']+)'/g)].map((m) => m[1] as string)
}

/**
 * The subjects the two release writers commit, with their interpolations
 * replaced by sample values: the CI workflow and the local `publish.sh`.
 */
function writerSubjects(): readonly string[] {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github', 'workflows', 'publish-packages.yml'),
    'utf8',
  )
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'publish.sh'), 'utf8')
  const ci = /git commit[^\n]*-m "(chore: publish packages[^"]*)"/.exec(workflow)?.[1]
  const local = /git commit[^\n]*-m "(chore\(release\): publish[^"]*)"/.exec(script)?.[1]
  return [ci, local]
    .filter((subject): subject is string => subject !== undefined)
    .map((subject) => subject.replace(/\$\{\{[^}]*\}\}/g, 'patch').replace(/\$\{[^}]*\}/g, '3'))
}

/** Whether `pattern` matches `subject` the way `git log --grep` would (POSIX BRE). */
function gitRegexMatches(pattern: string, subject: string): boolean {
  const res = spawnSync('grep', ['-q', '-e', pattern], {
    input: `${subject}\n`,
  })
  return res.status === 0
}

describe('the docs ratchet skips the publish script', () => {
  it('skips BOTH release subjects — the old one and the one CI writes today', () => {
    const patterns = grepPatterns()
    expect(patterns).toContain('^chore(release): publish')
    expect(patterns).toContain('^chore: publish packages')
  })

  // The patterns are only worth anything if they match what the writers really
  // write. A regex that matches nothing is the same as no skip at all, and it
  // would go unnoticed exactly as the missing one did. Each pattern is checked
  // against the subject its WRITER produces (read from the writer's source), in
  // git's own regex dialect (POSIX basic, which `grep` speaks too) — history
  // alone cannot prove it: the repo was re-imported on 2026-10-04 (9de2dd4a4)
  // and the local `publish.sh` subject has not been written since.
  it('every pattern matches the subject one of its writers produces', () => {
    const subjects = writerSubjects()
    expect(subjects).toHaveLength(2)
    for (const pattern of grepPatterns()) {
      const matched = subjects.filter((subject) => gitRegexMatches(pattern, subject))
      expect(matched, `${pattern} matches no writer subject`).not.toEqual([])
    }
    for (const subject of subjects) {
      const matchedBy = grepPatterns().filter((pattern) => gitRegexMatches(pattern, subject))
      expect(matchedBy, `writer subject "${subject}" is skipped by no pattern`).not.toEqual([])
    }
  })

  // And the subject CI writes today must match commits that really exist, so a
  // rewording in the workflow that the writer extraction above misses still
  // turns this red once the history moves on.
  it('the CI publish pattern matches commits that really exist in this repo', () => {
    const pattern = '^chore: publish packages'
    expect(grepPatterns()).toContain(pattern)
    const found = execFileSync('git', ['log', '-1', '--format=%H', `--grep=${pattern}`, '-400'], {
      cwd: ROOT,
      encoding: 'utf-8',
    }).trim()
    expect(found, `no commit in the last 400 matches ${pattern}`).not.toBe('')
  })

  // `--invert-grep` inverts the OR of every `--grep`, so adding one narrows
  // what counts as a real commit. Dropping it would silently widen it back.
  it('inverts the match, rather than selecting it', () => {
    expect(SOURCE).toContain("'--invert-grep'")
  })
})

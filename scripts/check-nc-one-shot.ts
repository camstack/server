#!/usr/bin/env tsx
/**
 * A notification is ONE message and nothing follows it (D692).
 *
 * ## The failure this catches
 *
 * D142 sent a notification, waited for a name, and sent the name as a SECOND
 * message carrying the same push `tag`, on the promise that "a phone collapses
 * the two". Zentik honours no tag, so every such follow-up arrived as a
 * duplicate (D686). D143 then grew a message in place with a `:enhanced` key
 * and a `groupIdleSec` burst merge. D692 removes all three: a grouped
 * immediate rule sends once, when its window closes. A paragraph in a doc does
 * not stop one of them coming back "just for this case"; this does.
 *
 * ## What it checks
 *
 *  1. The dispatcher builds no `tag:` property. A tag is the one thing a
 *     follow-up needs in order to replace the first message; without it a
 *     second send is visibly a second send. Comments are blanked first.
 *  2. Outside {@link ALLOW_LIST}, no TypeScript source under `packages/` (or
 *     `camstack/src`, when the viewer submodule is checked out) names
 *     `:enhanced` or `groupIdleSec`. Tests, `.d.ts`, build output, generated
 *     cap routers and `docs/reference/` are not scanned: the tracked-file walk
 *     never yields build output (`packages/types/dist` still contains
 *     `groupIdleSec`), and the generated sources are excluded by path.
 *
 * Every allow-list entry names a file that MUST still contain a retired name:
 * an entry nothing needs is a hole, so the guard fails on it (stale allowance).
 *
 * `camstack/src/**` is allowed wholesale until the viewer pin bump — the
 * submodule is a separate repository. It is scanned only when it is on disk and
 * the count is printed; when absent the guard SAYS it did not look (D315).
 *
 * Usage: tsx scripts/check-nc-one-shot.ts
 */
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkSources } from './lib/walk-sources.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const DISPATCHER_FILE = 'packages/addon-post-analysis/src/notification-center/dispatcher.ts'

/** The retired follow-up vocabulary. */
export const RETIRED_NAMES: readonly string[] = [':enhanced', 'groupIdleSec']

/** A file that may still name a retired key, and why. */
export interface OneShotAllowance {
  readonly file: string
  readonly reason: string
}

/**
 * Exact files. An entry here that no longer names a retired key fails the
 * guard (see {@link findStaleAllowances}).
 */
export const ALLOW_LIST: readonly OneShotAllowance[] = [
  {
    file: 'packages/types/src/capabilities/notification-rules.cap.ts',
    reason: 'the retired clear keys a stored rule is still allowed to empty',
  },
  {
    file: 'packages/addon-post-analysis/src/notification-center/rule-retired-fields.ts',
    reason: 'the read projection of a stored groupIdleSec onto groupingSec',
  },
  {
    file: 'packages/addon-post-analysis/src/notification-center/rule-store.ts',
    reason: 'names the retired clear keys to keep them out of the stored patch',
  },
]

/** The viewer is a separate repository: allowed until the pin bump. */
export const VIEWER_PREFIX = 'camstack/src/'

const SCAN_ROOTS: readonly string[] = ['packages']
const VIEWER_ROOT = 'camstack/src'

export interface OneShotViolation {
  readonly file: string
  readonly line: number
  readonly rule: 'dispatcher-tag' | 'retired-follow-up-name' | 'stale-allowance'
  readonly excerpt: string
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function excerptAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  return text.slice(start, end === -1 ? text.length : end).trim()
}

/**
 * `tag: …` as an object-literal property (bare or quoted key) in comment-free
 * `code`. `tag?: string` in an interface is a declaration, not a build, and is
 * not matched.
 */
export function findTagViolations(code: string, rel: string): readonly OneShotViolation[] {
  const out: OneShotViolation[] = []
  for (const m of code.matchAll(/(?:\btag|['"`]tag['"`])\s*:/g)) {
    const at = m.index ?? 0
    out.push({
      file: rel,
      line: lineOf(code, at),
      rule: 'dispatcher-tag',
      excerpt: excerptAt(code, at),
    })
  }
  return out
}

export function isAllowed(rel: string): boolean {
  return rel.startsWith(VIEWER_PREFIX) || ALLOW_LIST.some((a) => a.file === rel)
}

/** A retired name in comment-free `code` of a file outside the allow-list. */
export function findRetiredNameViolations(code: string, rel: string): readonly OneShotViolation[] {
  if (isAllowed(rel)) return []
  const out: OneShotViolation[] = []
  for (const name of RETIRED_NAMES) {
    let from = code.indexOf(name)
    while (from !== -1) {
      out.push({
        file: rel,
        line: lineOf(code, from),
        rule: 'retired-follow-up-name',
        excerpt: excerptAt(code, from),
      })
      from = code.indexOf(name, from + name.length)
    }
  }
  return out
}

export function namesRetiredKey(code: string): boolean {
  return RETIRED_NAMES.some((n) => code.includes(n))
}

/** Allow-list entries whose file no longer names a retired key (or is gone). */
export function findStaleAllowances(
  codeByFile: ReadonlyMap<string, string>,
): readonly OneShotViolation[] {
  const out: OneShotViolation[] = []
  for (const a of ALLOW_LIST) {
    const code = codeByFile.get(a.file)
    if (code === undefined || !namesRetiredKey(code)) {
      out.push({
        file: a.file,
        line: 1,
        rule: 'stale-allowance',
        excerpt: `allowed for "${a.reason}" but names none of ${RETIRED_NAMES.join(', ')} — delete the entry`,
      })
    }
  }
  return out
}

/** Paths that are generated, not authored: a cap router names every cap key. */
function isGenerated(rel: string): boolean {
  return rel.includes('/generated/') || rel.includes('.generated.')
}

function main(): void {
  const violations: OneShotViolation[] = []

  const files = walkSources(ROOT, SCAN_ROOTS).filter((f) => !isGenerated(f.rel))
  const dispatcher = files.find((f) => f.rel === DISPATCHER_FILE)
  if (dispatcher === undefined) {
    violations.push({
      file: DISPATCHER_FILE,
      line: 1,
      rule: 'dispatcher-tag',
      excerpt: 'the dispatcher was not found — a guard that cannot look has not passed',
    })
  } else {
    violations.push(...findTagViolations(dispatcher.code, dispatcher.rel))
  }
  for (const f of files) violations.push(...findRetiredNameViolations(f.code, f.rel))

  const codeByFile = new Map(files.map((f) => [f.rel, f.code]))
  violations.push(...findStaleAllowances(codeByFile))

  let viewerNote = `${VIEWER_ROOT}: not checked out — skipped (could not look)`
  if (existsSync(path.join(ROOT, VIEWER_ROOT))) {
    const viewer = walkSources(ROOT, [VIEWER_ROOT], { tracked: false })
    const hits = viewer.filter((f) => namesRetiredKey(f.code)).length
    viewerNote = `${VIEWER_ROOT}: ${viewer.length} files scanned, ${hits} still name a retired key (allowed until the pin bump)`
  }

  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `check-nc-one-shot: OK — ${files.length} source files; the dispatcher builds no tag, ` +
        `${ALLOW_LIST.length} allow-listed files; ${viewerNote}`,
    )
    return
  }
  // eslint-disable-next-line no-console
  console.error('check-nc-one-shot: FAILED\n')
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`  - ${v.file}:${v.line} [${v.rule}] ${v.excerpt}`)
  }
  // eslint-disable-next-line no-console
  console.error(
    [
      '',
      'A notification is ONE message and nothing follows it (D692):',
      '  dispatcher-tag          a push tag exists so a second send can replace the first; Zentik',
      '                          honours none, so a tagged follow-up is a duplicate (D686).',
      '  retired-follow-up-name  `:enhanced` and `groupIdleSec` were the deferred / grown message.',
      '                          Only the retired-key and migration handling may name them:',
      ...ALLOW_LIST.map((a) => `                            ${a.file}`),
      '  stale-allowance         an allow-list entry nothing needs is a hole — delete it.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()

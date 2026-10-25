#!/usr/bin/env tsx
/**
 * No document points at a commit SHA.
 *
 * ── What this prevents ─────────────────────────────────────────────────────
 * The repository's history was squashed to a single initial commit on
 * 2026-09-09, at the operator's request. Every SHA any document had ever cited
 * stopped resolving that afternoon — 389 of them across 137 files, removed in
 * the same pass. A SHA in prose is a pointer with no owner: nothing updates it,
 * nothing notices when it dies, and a reader who tries it gets `bad object`
 * rather than the reasoning it was standing in for.
 *
 * The rule is not "history will be squashed again". It is that a record should
 * carry the reasoning itself. "Fixed at 15:58, deployed at 15:59 to all three
 * nodes" survives any history operation; "fixed in `0325c97a0`" does not, and
 * says less.
 *
 * ── Why a guard and not a note ─────────────────────────────────────────────
 * Within four hours of the cleanup, two fresh SHA references had already been
 * written into `adr-0420` and `sessions.md` by work landing the same
 * afternoon. Nobody was careless: citing the commit you are superseding is the
 * natural thing to write. A rule nothing checks has already been broken
 * somewhere.
 *
 * ── What is NOT a violation ────────────────────────────────────────────────
 * Hex that is not a commit: track ids, session ids, agent ids, handles,
 * workflow ids (`241431591` is this repo's CI workflow), model hashes, colour
 * literals. The check is deliberately narrow — a backticked 7-40 hex token that
 * git RESOLVES to a commit object in this repository. A token git cannot
 * resolve is left alone, because it is far more likely to be evidence in an
 * audit than a pointer: `7781d055` in adr-0399 is the track whose re-acquisition
 * the record is about, and deleting it would destroy the argument.
 *
 * Usage: npx tsx scripts/check-no-commit-sha-references.ts
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const CANDIDATE = /`([0-9a-f]{7,40})`/g

interface Hit {
  readonly file: string
  readonly line: number
  readonly sha: string
}

function docFiles(): string[] {
  // A glob of `docs/**/*.md` misses markdown that sits directly in `docs/`.
  // List the tree and filter in JS instead.
  const out = execFileSync('git', ['ls-files', 'docs/'], { cwd: ROOT, encoding: 'utf-8' })
  return out.split('\n').filter((f) => f.endsWith('.md'))
}

/**
 * Which of these tokens git resolves to a COMMIT — ONE `git cat-file
 * --batch-check` over all of them. The previous shape spawned one `git` per
 * distinct token, and this repository's records quote hashes as evidence by
 * the hundred: 22 s on 2026-09-20, all of it process start-up.
 */
function commitsAmong(tokens: ReadonlySet<string>): ReadonlySet<string> {
  if (tokens.size === 0) return new Set()
  const out = execFileSync('git', ['cat-file', '--batch-check'], {
    cwd: ROOT,
    encoding: 'utf-8',
    input: `${[...tokens].join('\n')}\n`,
    stdio: ['pipe', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  })
  // A hit prints `<full-sha> commit <size>`; a miss `<token> missing` (or
  // `ambiguous`). The token was a PREFIX of the full sha printed back.
  const fullShas = out
    .split('\n')
    .map((line) => line.split(' '))
    .filter((parts) => parts[1] === 'commit')
    .map((parts) => parts[0] ?? '')
  return new Set([...tokens].filter((t) => fullShas.some((c) => c.startsWith(t))))
}

const candidates: Hit[] = []
for (const file of docFiles()) {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf-8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    for (const m of (lines[i] ?? '').matchAll(CANDIDATE)) {
      candidates.push({ file, line: i + 1, sha: m[1] ?? '' })
    }
  }
}
const resolved = new Set(candidates.map((c) => c.sha))
const commits = commitsAmong(resolved)
const hits: Hit[] = candidates.filter((c) => commits.has(c.sha))

if (hits.length > 0) {
  console.error('\n\x1b[31m✘ a document points at a commit SHA\x1b[0m')
  for (const h of hits) console.error(`    ${h.file}:${h.line} — \`${h.sha}\``)
  console.error(
    '\n  Say what changed and when, not which commit said it. A SHA stops\n' +
      '  resolving the moment the history is rewritten, and the reader gets\n' +
      '  `bad object` instead of the reasoning. See the docblock in this file.\n',
  )
  process.exit(1)
}

console.log(
  `  \x1b[32m✔\x1b[0m  no document points at a commit SHA (${String(resolved.size)} hex token(s) checked, the rest are ids and evidence)`,
)

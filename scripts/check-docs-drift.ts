#!/usr/bin/env tsx
/**
 * Docs drift guard — the half of the sync story that `docs-generate.ts` cannot
 * cover.
 *
 * `docs-generate.ts` owns everything DERIVABLE (package/addon/capability
 * tables): it rewrites those files, so they cannot rot. What remains is
 * hand-written prose — architecture explanations, decisions, invariants — and
 * prose rots in exactly one mechanical way: it points at code that moved.
 *
 * The audit that motivated this found 8 of 24 file references in `AGENTS.md`
 * dead, and 9 packages listed that no longer existed. Nothing failed, because
 * nothing checked. So:
 *
 *   1. DEAD PATHS (hard failure). Every repo path a doc mentions must resolve.
 *      Objective, and the fix is always small — so it blocks the commit.
 *
 *   2. `applies-to` GLOBS (hard failure). A doc's frontmatter declares which
 *      code it describes. A glob matching nothing means the doc outlived its
 *      subject.
 *
 *   3. STALENESS (RATCHET — fails only when the number GROWS). If the code
 *      under `applies-to` changed after the doc's `last-verified` date, the doc
 *      is *suspect*, not necessarily wrong. Failing on any staleness at all
 *      would force a human to touch docs to land an unrelated commit, which is
 *      precisely the treadmill this setup exists to remove — but "report only"
 *      meant the count sat at 10 for a month with nobody reading the line.
 *
 *      So CI passes `--max-stale <n>` with the count pinned at what it is
 *      today. Everyday work is unaffected: touching code under an ALREADY
 *      stale doc changes nothing. Only pushing a doc that was verified-current
 *      into suspect fails, and the fix is to read that one doc and bump its
 *      `last-verified`. Verify a doc and the ceiling drops with it.
 *
 *      `--strict` remains: zero tolerance, for a scheduled job that wants it.
 *
 * Where paths are looked for: inline code spans (`like/this.ts`) and markdown
 * link targets. NOT inside fenced code blocks — those hold illustrative
 * snippets and shell one-liners where a non-existent path is often the point.
 *
 * Escape hatch: `<!-- drift-ok: why -->` on the same line. Used where naming a
 * path that no longer exists is the actual point — a record describing rot, or a
 * planned file that does not exist yet.
 *
 * Usage:
 *   npm run docs:check                          — generated-file sync + this guard
 *   tsx scripts/check-docs-drift.ts --committed-only --max-stale 10   (CI)
 *   tsx scripts/check-docs-drift.ts --max-stale 10                    (pre-commit hook, same ceiling)
 *   tsx scripts/check-docs-drift.ts --strict
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  claimGlobs,
  globToRegExp,
  lastCommitDate,
  parseFrontmatter,
  repoFiles,
  stalenessGlobs,
} from './lib/docs-frontmatter.js'

const ROOT = path.resolve(import.meta.dirname, '..')

/**
 * Working notes (superpowers, archive, and the dot-superpowers tree) moved to the
 * sibling planning repo and are not in this checkout, so there is nothing frozen
 * sibling planning repo and are not in this checkout, so there is nothing frozen
 * to exclude. `docs/design/` stays in scope. Two of its documents are marked
 * required reading and are linked from the architecture pages, so they have to
 * stay true — and checking them immediately found `packages/agent/src/…`
 * references in the transport deep dive, a package that no longer exists. The
 * genuinely historical ones there carry `<!-- drift-ok -->` per line instead.
 */

/**
 * Excluded wherever they appear, not just at the repo root — a dependency's own
 * README is full of paths into ITS repo (`packages/addon-auth/node_modules/jose`
 * alone contributed 38 "failures"), and build output is a copy of source.
 *
 * `.claude/worktrees` is a SECOND CHECKOUT of this repo inside itself. An agent
 * working there writes docs referencing files that exist only on its branch, so
 * every one reads as a dead path here and blocks an unrelated commit on main.
 * Same trap vitest hit collecting those worktrees as test files (2026-08-05);
 * this is the second place that needed telling.
 */
const EXCLUDED_SEGMENTS: readonly string[] = ['node_modules', 'dist', 'build', '.venv', '.claude']

/** First path segments that mark a token as a repo path worth resolving. */
const REPO_ROOTS: readonly string[] = [
  'packages',
  'server',
  'scripts',
  'docs',
  'tools',
  'e2e',
  '.github',
  '.claude',
  '.husky',
]

/**
 * Same-line escape hatch. A trailing reason is encouraged and matched:
 * `<!-- drift-ok: naming a package that no longer exists is the point -->`.
 */
const IGNORE_TOKEN = /<!--\s*drift-ok/

// ── File collection ────────────────────────────────────────────────────────

function isExcluded(rel: string): boolean {
  return rel.split('/').some((segment) => EXCLUDED_SEGMENTS.includes(segment))
}

/**
 * Every markdown doc this guard owns: `docs/**`, every `AGENTS.md`, and every
 * `README.md`.
 *
 * READMEs are in scope because the root one had rotted just as badly as
 * `AGENTS.md` — it pointed at `packages/kernel`, `packages/core`,
 * `packages/agent`, `packages/addon-stream-broker` and ten `docs/*.md` files that
 * had all moved or gone. A README is the first thing anyone reads, so it is the
 * worst place for a dead path.
 *
 * A SUBMODULE's own markdown is not ours to check, for the same reason
 * `resolves` accepts a path inside one on sight: its references are relative to
 * ITS root, not to this one, and the verdict must not depend on who checked
 * what out. `camstack/README.md` names `scripts/write-manifest-for-build.js` —
 * a real file in the viewer — and it read as a dead path here on every machine
 * with the submodule populated, while CI (which checks out without submodules)
 * saw nothing at all and passed.
 */
const SUBMODULE_PREFIXES: readonly string[] = submodulePrefixes(ROOT)

function collectDocs(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(ROOT, abs)
      if (isExcluded(rel)) continue
      // A SUBMODULE's documentation belongs to another repository, and so do
      // the paths in it: `camstack/README.md` names `scripts/…` meaning the
      // VIEWER's scripts, which this guard then resolved against this repo's
      // `scripts/` and called dead. `resolves()` already refuses to judge paths
      // INTO a submodule for the same reason; walking into one to collect its
      // docs was the other half of that mistake. Matched by PREFIX so a doc
      // nested inside a submodule is skipped too, not only its root.
      if (SUBMODULE_PREFIXES.some((prefix) => `${rel}/`.startsWith(prefix))) continue
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.claude') {
          continue
        }
        walk(abs)
        continue
      }
      const owned =
        entry.name === 'AGENTS.md' || entry.name === 'README.md' || rel.startsWith('docs/')
      if (owned && entry.name.endsWith('.md')) out.push(rel)
    }
  }
  walk(ROOT)
  out.push(...skillDocs())
  return out.toSorted()
}

/**
 * The repository's skills (`.claude/skills/**`) are prose that names paths
 * like any doc — and they rotted unseen, because `.claude` is excluded above
 * (it also holds agent worktrees). `add-capability`'s (now `camstack-capability`) "Ship it" section went
 * stale exactly this way. Walked explicitly, worktrees never reached.
 */
function skillDocs(): string[] {
  const dir = path.join(ROOT, '.claude', 'skills')
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  const walk = (abs: string): void => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const child = path.join(abs, entry.name)
      if (entry.isDirectory()) walk(child)
      else if (entry.name.endsWith('.md')) out.push(path.relative(ROOT, child))
    }
  }
  walk(dir)
  return out
}

// ── Path extraction ────────────────────────────────────────────────────────

interface PathRef {
  readonly doc: string
  readonly line: number
  readonly raw: string
}

/**
 * Strips fenced code blocks, keeping line numbering intact (fence bodies become
 * empty lines) so reported line numbers still point at the real line.
 */
function stripFences(lines: readonly string[]): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      out.push('')
      continue
    }
    out.push(inFence ? '' : line)
  }
  return out
}

/** `a/{b,c}/d.ts` → [`a/b/d.ts`, `a/c/d.ts`]. Single level, which is all we use. */
function expandBraces(token: string): string[] {
  const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(token)
  if (!match) return [token]
  const [, before, list, after] = match
  return list.split(',').flatMap((part) => expandBraces(`${before}${part.trim()}${after}`))
}

function looksLikeRepoPath(token: string): boolean {
  if (!token.includes('/')) return false
  // Placeholders / template syntax / npm scopes are not paths to resolve.
  if (/[<>$\s]/.test(token) || token.startsWith('@') || token.includes('://')) return false
  const first = token.split('/')[0]
  return REPO_ROOTS.includes(first)
}

function extractPathRefs(doc: string, body: string): PathRef[] {
  const refs: PathRef[] = []
  const lines = stripFences(body.split('\n'))
  for (const [index, line] of lines.entries()) {
    if (IGNORE_TOKEN.test(line)) continue
    const candidates: string[] = []
    for (const m of line.matchAll(/`([^`\n]+)`/g)) candidates.push(m[1])
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) candidates.push(m[1])
    for (const candidate of candidates) {
      // Trim trailing markdown punctuation that rides along inside a span.
      const token = candidate.replace(/[.,;:]+$/, '')
      if (!looksLikeRepoPath(token)) continue
      refs.push({ doc, line: index + 1, raw: token })
    }
  }
  return refs
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Paths of every registered git SUBMODULE, with a trailing slash.
 *
 * A submodule is a gitlink: `git ls-files` reports the mount point (`camstack`)
 * and nothing below it, so every path inside one has always fallen through to
 * the `fs.existsSync` arm. That arm answers a question about the CHECKOUT, not
 * about the documentation — and the two environments disagree. A developer's
 * tree has the submodule populated, so `camstack/src/data/use-snapshot.ts`
 * resolved; CI runs `actions/checkout` WITHOUT `submodules: true`, so the same
 * reference was a hard failure there. Four ADRs and two same-day design docs
 * went red on a guard that had been green on every machine that wrote them.
 *
 * A file inside another repository is therefore accepted on sight. This guard
 * cannot verify it — it is not in this repository's history — and pretending
 * otherwise makes the verdict a function of who checked out what.
 * `docs-frontmatter.ts` already draws the same line the other way round:
 * `isSourceFile` excludes `camstack/` from the file universe the subsystem map
 * measures, for exactly this reason.
 */
function submodulePrefixes(root: string): readonly string[] {
  try {
    const raw = execFileSync('git', ['ls-files', '--stage'], {
      cwd: root,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const out: string[] = []
    for (const line of raw.split('\n')) {
      // `<mode> <sha> <stage>\t<path>` — mode 160000 is a gitlink.
      if (!line.startsWith('160000 ')) continue
      const tab = line.indexOf('\t')
      if (tab === -1) continue
      out.push(`${line.slice(tab + 1)}/`)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Path segments that mark a reference as BUILD OUTPUT.
 *
 * `packages/types/dist` is git-ignored and produced by `npm run build`. Whether
 * it is on disk therefore says nothing about the documentation and everything
 * about whether anyone ran a build in THIS checkout: it exists in the main tree
 * and does not exist in a fresh worktree, where the same seven references in
 * the session diary (now private) and one design doc turned the check red and kept it
 * red — and a permanently red check is one everyone learns to skip past.
 *
 * Exactly the argument `SUBMODULE_PREFIXES` makes one line below: this guard
 * cannot verify a path that is not in this repository's history, and pretending
 * otherwise makes the verdict a function of who built what. The prose is also
 * usually ABOUT the artefact (a codegen ordering deadlock, a stale `dist` in a
 * shared checkout), so there is nothing to rewrite.
 */
const BUILD_OUTPUT_SEGMENTS: readonly string[] = ['dist', 'build']

/**
 * A reference resolves if it is a tracked file, a tracked directory prefix, a
 * glob with at least one match, a path inside a registered submodule, a path
 * into build output, or simply present on disk (`camstack-data/` paths are
 * git-ignored but real and worth documenting).
 */
function resolves(ref: string, tracked: ReadonlySet<string>): boolean {
  // Drop a `#heading` fragment — the file is what has to exist. (Validating the
  // anchor too would be nice and would also make every heading rename a doc
  // failure, which is the wrong trade.)
  const clean = ref.replace(/#.*$/, '').replace(/\/$/, '')
  if (clean.length === 0) return true
  // A submodule's contents belong to another repository. Checked BEFORE the
  // filesystem so the answer cannot depend on whether this checkout populated
  // it — that is the whole point.
  if (SUBMODULE_PREFIXES.some((prefix) => clean.startsWith(prefix))) return true
  // Build output, for the same reason and also before the filesystem.
  if (clean.split('/').some((segment) => BUILD_OUTPUT_SEGMENTS.includes(segment))) return true
  // `file.ts:123` — verify the file AND that the line exists, since a stale
  // line number is the most common form of half-rot.
  const lineMatch = /^(.*):(\d+)$/.exec(clean)
  if (lineMatch) {
    const [, file, lineNo] = lineMatch
    const abs = path.join(ROOT, file)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false
    const count = fs.readFileSync(abs, 'utf-8').split('\n').length
    return Number(lineNo) <= count
  }
  if (tracked.has(clean)) return true
  if (fs.existsSync(path.join(ROOT, clean))) return true
  if (clean.includes('*')) {
    const re = globToRegExp(clean)
    for (const file of tracked) {
      if (re.test(file)) return true
      // A glob may name a directory (`packages/*/src`); match prefixes too.
      if (re.test(path.dirname(file))) return true
    }
    return false
  }
  // Tracked directory?
  const prefix = `${clean}/`
  for (const file of tracked) if (file.startsWith(prefix)) return true
  return false
}

// ── Entry ──────────────────────────────────────────────────────────────────

interface Problem {
  readonly doc: string
  readonly line: number
  readonly message: string
}

/**
 * `--max-stale <n>`: the ceiling the staleness ratchet enforces. Absent ⇒ no
 * ceiling — a report only. Since 2026-09-20 the pre-commit hook passes CI's
 * ceiling (read out of ci.yml) so the two agree: an advisory hook printed
 * "(not a failure)" over the same list CI failed on, for a whole day.
 */
function maxStaleArg(argv: readonly string[]): number | null {
  const index = argv.indexOf('--max-stale')
  if (index < 0) return null
  const raw = argv[index + 1]
  const value = Number(raw)
  if (raw === undefined || !Number.isInteger(value) || value < 0) {
    console.error(`✘ --max-stale needs a non-negative integer, got: ${String(raw)}`)
    process.exit(2)
  }
  return value
}

function main(): void {
  const strict = process.argv.includes('--strict')
  const maxStale = maxStaleArg(process.argv)
  const tracked = repoFiles(ROOT, process.argv.includes('--committed-only'))
  const docs = collectDocs()

  const errors: Problem[] = []
  const stale: string[] = []

  for (const doc of docs) {
    const body = fs.readFileSync(path.join(ROOT, doc), 'utf-8')

    // Generated files are owned by their generator, and each has its own
    // `--check` in `npm run docs:check`. Re-checking their paths here would only
    // ever report a bug in the generator as a bug in the prose.
    if (/generated by `?scripts\//i.test(body)) continue
    // A template's paths are placeholders by definition.
    if (path.basename(doc) === 'template.md') continue

    for (const ref of extractPathRefs(doc, body)) {
      const variants = expandBraces(ref.raw)
      const dead = variants.filter((v) => !resolves(v, tracked))
      if (dead.length > 0) {
        errors.push({
          doc,
          line: ref.line,
          message: `dead path reference: ${dead.map((d) => `\`${d}\``).join(', ')}`,
        })
      }
    }

    // BOTH claim keys are validated: a glob pointing at deleted code is wrong
    // whether the page verified it or merely describes it.
    const { fm } = parseFrontmatter(body)
    for (const glob of claimGlobs(fm)) {
      if (!resolves(glob, tracked)) {
        const key = fm.covers.includes(glob) ? 'covers' : 'applies-to'
        errors.push({
          doc,
          line: 1,
          message: `frontmatter \`${key}\` matches nothing: \`${glob}\``,
        })
      }
    }

    // Staleness arms off `applies-to` ALONE. `covers:` is a coverage claim on a
    // class the page generalises to, and arming it would make every such page
    // permanently suspect — see D145.
    const armed = stalenessGlobs(fm)
    if (fm.lastVerified !== null && armed.length > 0) {
      const changed = lastCommitDate(ROOT, armed)
      if (changed !== null && changed > fm.lastVerified) {
        stale.push(`${doc} — last-verified ${fm.lastVerified}, described code changed ${changed}`)
      }
    }
  }

  const ceiling = strict ? 0 : maxStale
  if (stale.length > 0) {
    const verdict =
      ceiling === null || stale.length <= ceiling ? 'not a failure' : 'OVER THE CEILING'
    console.log(`\x1b[33m⚠ ${stale.length} doc(s) may be stale\x1b[0m (${verdict}):`)
    for (const s of stale) console.log(`    ${s}`)
  }

  if (errors.length > 0) {
    console.error(`\x1b[31m✘ ${errors.length} docs drift problem(s)\x1b[0m:`)
    for (const e of errors) console.error(`    ${e.doc}:${e.line} — ${e.message}`)
    console.error('\n  Fix the reference, or add `<!-- drift-ok -->` on that line if intentional.')
    process.exit(1)
  }

  if (ceiling !== null && stale.length > ceiling) {
    console.error(
      `\x1b[31m✘ ${stale.length} stale doc(s), ceiling is ${ceiling}\x1b[0m — a doc that was ` +
        'verified-current just went suspect.',
    )
    console.error(
      '  Read the doc(s) above, confirm they still describe the code, and bump their\n' +
        '  `last-verified` frontmatter. If one is genuinely wrong, fix it. Raising the\n' +
        '  `--max-stale` in .github/workflows/ci.yml is not a fix — the ratchet only goes down.',
    )
    process.exit(1)
  }

  // A ceiling that no longer binds is a ceiling nobody will lower. Say so.
  if (ceiling !== null && ceiling > 0 && stale.length < ceiling) {
    console.log(
      `  \x1b[33m↓\x1b[0m stale docs down to ${stale.length} (ceiling ${ceiling}) — lower ` +
        '`--max-stale` in .github/workflows/ci.yml so the ratchet holds',
    )
  }

  console.log(`  ✔ ${docs.length} docs checked, no dead references`)
}

main()

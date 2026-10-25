/**
 * The skill pointers — short, GENERATED blocks that send any agent harness to
 * the one source of a procedure (`.claude/skills/<id>/SKILL.md` + `docs/`).
 *
 * Why generated pointers and not copies: a copy drifts the day the skill is
 * edited, and a symlink breaks on Windows and inside npm tarballs. A pointer
 * holds nothing that can go stale except the paths it names, and the docs
 * check (`gen-skill-pointers.ts --check`) fails when a block is missing or
 * differs from what this module renders.
 *
 * Who reads what (verified 2026-10-09, see
 * docs/design/2026-10-09-repo-skills-and-ui-skill-plan.md):
 *   - Codex: `AGENTS.md`, root down to the working directory, concatenated
 *     under a 32 KiB default cap; skills only from `.agents/skills` (not used
 *     here — Cursor would list every skill twice), so Codex finds a skill
 *     through these pointers and opens the file.
 *   - Cursor: `AGENTS.md` (nested ones apply to files under them), Agent
 *     Skills in `.claude/skills/`, and `.cursor/rules/*.mdc`.
 *   - Claude Code: `.claude/skills/` natively; `CLAUDE.md` (= `@AGENTS.md`)
 *     nested per package.
 *
 * This module is the engine: markers, splicing, file creation, `.mdc`
 * rendering and the plan. WHAT each file says comes from `ui-pointers.ts`
 * (the UI blocks) and `skill-registry.ts` (every other skill).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const GENERATOR = 'scripts/skills/gen-skill-pointers.ts'

/** Codex's default `project_doc_max_bytes`: root + nested AGENTS.md, concatenated. */
export const CODEX_AGENTS_CAP_BYTES = 32 * 1024

export interface BlockSpec {
  /** Marker id — the block is fenced by `camstack-<id>:begin` / `:end`. */
  readonly id: string
  /** Section heading used when the block is appended to a file without it. */
  readonly heading: string
  readonly lines: readonly string[]
  /**
   * Where a NEW block goes in an existing file: `end` (default), `top` —
   * before the first `## ` section, so it survives Codex truncating the tail
   * of a long package file — or `under-heading`: first thing under the
   * existing `## <heading>` (falls back to `end` when the file has none). An
   * existing block is always replaced in place.
   */
  readonly placement?: 'end' | 'top' | 'under-heading'
}

export function blockBegin(id: string): string {
  return `<!-- camstack-${id}:begin — written by \`npx tsx ${GENERATOR}\`; edit the generator, not this block -->`
}

export function blockEnd(id: string): string {
  return `<!-- camstack-${id}:end -->`
}

export function renderBlock(spec: BlockSpec): string {
  return [blockBegin(spec.id), ...spec.lines, blockEnd(spec.id)].join('\n')
}

/**
 * The span of block `id` in `text`, markers included, or null. The begin
 * marker is matched by its stable prefix so a block written by an older
 * generator path is still found (and rewritten), never duplicated.
 */
function blockSpan(text: string, id: string): { start: number; end: number } | null {
  const start = text.indexOf(`<!-- camstack-${id}:begin`)
  if (start === -1) return null
  const endMarker = blockEnd(id)
  const end = text.indexOf(endMarker, start)
  if (end === -1) return null
  return { start, end: end + endMarker.length }
}

/** The current block `id` in `text`, markers included, or null. */
export function extractBlock(text: string, id: string): string | null {
  const span = blockSpan(text, id)
  return span === null ? null : text.slice(span.start, span.end)
}

/**
 * `text` with block `spec.id` replaced — or, when it has none, with the block
 * appended as its own section at the end. Idempotent.
 */
export function spliceBlock(text: string, spec: BlockSpec): string {
  const span = blockSpan(text, spec.id)
  const block = renderBlock(spec)
  if (span !== null) return text.slice(0, span.start) + block + text.slice(span.end)
  if (spec.placement === 'under-heading') {
    const heading = `## ${spec.heading}\n\n`
    const at = text.indexOf(heading)
    if (at !== -1) {
      const cut = at + heading.length
      return `${text.slice(0, cut)}${block}\n${text.slice(cut)}`
    }
  }
  const section = `## ${spec.heading}\n\n${block}\n`
  const firstSection = spec.placement === 'top' ? /^## /m.exec(text) : null
  if (firstSection !== null) {
    return `${text.slice(0, firstSection.index)}${section}\n${text.slice(firstSection.index)}`
  }
  const trimmed = text.replace(/\s+$/, '')
  return `${trimmed}\n\n${section}`
}

/**
 * `text` without block `id` (and without the heading this module appended
 * right above it, when that is what precedes it). Unchanged when absent.
 */
export function removeBlock(text: string, id: string, heading: string): string {
  const span = blockSpan(text, id)
  if (span === null) return text
  const appendedHeading = `## ${heading}\n\n`
  const rawBefore = text.slice(0, span.start)
  const before = (
    rawBefore.endsWith(appendedHeading) ? rawBefore.slice(0, -appendedHeading.length) : rawBefore
  ).replace(/\s+$/, '')
  const after = text.slice(span.end).replace(/^\s+/, '')
  return after.length > 0 ? `${before}\n\n${after}` : `${before}\n`
}

export const CLAUDE_IMPORT = '@AGENTS.md\n'

export interface AgentsTarget {
  /** Repo-relative path of the AGENTS.md. */
  readonly file: string
  /** Package directory, for the title of a created file; absent = the root. */
  readonly pkg?: string
  readonly blocks: readonly BlockSpec[]
}

export function newAgentsFile(target: AgentsTarget): string {
  const title = target.pkg ? `# AGENTS.md — ${target.pkg}` : '# AGENTS.md'
  const sections = target.blocks.flatMap((b) => [`## ${b.heading}`, '', renderBlock(b), ''])
  return [
    title,
    '',
    'Package-level instructions for any coding agent. The repository-wide rules',
    'are in the root `AGENTS.md`; `CLAUDE.md` beside this file is a one-line',
    '`@AGENTS.md` import for Claude Code. Edit only this file.',
    '',
    ...sections,
  ].join('\n')
}

export interface MdcTarget {
  readonly file: string
  readonly description: string
  /** Empty = an agent-requested rule (Cursor picks it by description). */
  readonly globs: readonly string[]
  /** Sent with EVERY request — keep the body a few lines. */
  readonly alwaysApply?: boolean
  readonly body: readonly string[]
}

export function renderMdc(target: MdcTarget): string {
  const front = ['---', `description: ${target.description}`]
  if (target.globs.length > 0) front.push(`globs: ${target.globs.join(', ')}`)
  front.push(`alwaysApply: ${target.alwaysApply === true}`, '---')
  return [...front, ...target.body, ''].join('\n')
}

export function mdcHeader(source: string): string {
  return `<!-- Written by \`npx tsx ${GENERATOR}\` — a pointer, not a copy. ${source} -->`
}

// ── Plan / apply ───────────────────────────────────────────────────────────

export interface PointerWrite {
  readonly file: string
  readonly content: string
}

export interface PointerPlan {
  readonly writes: PointerWrite[]
  readonly problems: string[]
}

/** Several sources may target one file: merge their blocks, first source first. */
export function mergeTargets(targets: readonly AgentsTarget[]): AgentsTarget[] {
  const byFile = new Map<string, AgentsTarget>()
  for (const t of targets) {
    const prev = byFile.get(t.file)
    if (prev === undefined) {
      byFile.set(t.file, t)
      continue
    }
    const ids = new Set(prev.blocks.map((b) => b.id))
    byFile.set(t.file, {
      file: t.file,
      ...((prev.pkg ?? t.pkg) ? { pkg: prev.pkg ?? t.pkg } : {}),
      blocks: [...prev.blocks, ...t.blocks.filter((b) => !ids.has(b.id))],
    })
  }
  return [...byFile.values()]
}

/**
 * Every file the pointers own, with the content it must have.
 *
 * `owned` names block ids this generator writes; a block of an owned id found
 * in an AGENTS.md the plan no longer targets with it is removed (`known` lists
 * those other AGENTS.md files) — so dropping a target cannot leave an orphan.
 */
export function planPointers(
  root: string,
  agents: readonly AgentsTarget[],
  mdcs: readonly MdcTarget[],
  options: {
    readonly owned?: readonly { readonly id: string; readonly heading: string }[]
    readonly known?: readonly string[]
  } = {},
): PointerPlan {
  const writes: PointerWrite[] = []
  const problems: string[] = []
  const read = (rel: string): string | null => {
    const abs = path.join(root, rel)
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
  }
  const merged = mergeTargets(agents)
  const planned = new Set(merged.map((t) => t.file))
  for (const target of merged) {
    const current = read(target.file)
    if (current === null) {
      if (target.pkg === undefined) {
        problems.push(`${target.file} is missing`)
        continue
      }
      writes.push({ file: target.file, content: newAgentsFile(target) })
    } else {
      let next = current
      for (const block of target.blocks) next = spliceBlock(next, block)
      const wanted = new Set(target.blocks.map((b) => b.id))
      for (const o of options.owned ?? []) {
        if (!wanted.has(o.id)) next = removeBlock(next, o.id, o.heading)
      }
      writes.push({ file: target.file, content: next })
    }
    if (target.pkg !== undefined) {
      const claude = path.posix.join(path.posix.dirname(target.file), 'CLAUDE.md')
      const existing = read(claude)
      if (existing === null) writes.push({ file: claude, content: CLAUDE_IMPORT })
      else if (!existing.includes('@AGENTS.md')) {
        problems.push(`${claude} exists and does not import @AGENTS.md — fix it by hand`)
      }
    }
  }
  for (const file of options.known ?? []) {
    if (planned.has(file)) continue
    const current = read(file)
    if (current === null) continue
    let next = current
    for (const o of options.owned ?? []) next = removeBlock(next, o.id, o.heading)
    if (next !== current) writes.push({ file, content: next })
  }
  for (const mdc of mdcs) writes.push({ file: mdc.file, content: renderMdc(mdc) })
  return { writes, problems }
}

/** The writes whose content differs from what is on disk. */
export function staleWrites(root: string, writes: readonly PointerWrite[]): PointerWrite[] {
  return writes.filter((w) => {
    const abs = path.join(root, w.file)
    return !fs.existsSync(abs) || fs.readFileSync(abs, 'utf8') !== w.content
  })
}

/**
 * The share of Codex's cap the ROOT `AGENTS.md` may use. The rest is left for
 * the package file Codex appends when it runs inside a package.
 */
export const ROOT_AGENTS_BUDGET_BYTES = 28 * 1024

export interface CodexBudget {
  /** The root alone is over its budget — fail. */
  readonly errors: string[]
  /** A root → package chain is over the cap — report; shorten the package file. */
  readonly warnings: string[]
}

/**
 * Codex concatenates `AGENTS.md` from the repository root down to the working
 * directory and stops reading at 32 KiB, silently dropping the rest — so a
 * pointer block at the end of an over-long package file never reaches it. The
 * root is the one file every chain carries, so it gets a hard budget; a chain
 * over the cap is reported so the package file can be shortened.
 */
export function codexBudget(
  root: string,
  agentsFiles: readonly string[],
  writes: readonly PointerWrite[],
  cap: number = CODEX_AGENTS_CAP_BYTES,
  rootBudget: number = ROOT_AGENTS_BUDGET_BYTES,
): CodexBudget {
  const pending = new Map(writes.map((w) => [w.file, w.content]))
  const size = (rel: string): number | null => {
    const content = pending.get(rel)
    if (content !== undefined) return Buffer.byteLength(content)
    const abs = path.join(root, rel)
    return fs.existsSync(abs) ? fs.statSync(abs).size : null
  }
  const errors: string[] = []
  const warnings: string[] = []
  const rootSize = size('AGENTS.md') ?? 0
  if (rootSize > rootBudget) {
    errors.push(
      `AGENTS.md is ${rootSize} bytes, over its ${rootBudget}-byte budget (Codex reads ${cap} bytes of root + package AGENTS.md) — shorten it`,
    )
  }
  for (const file of agentsFiles) {
    if (file === 'AGENTS.md') continue
    const parts = path.posix.dirname(file).split('/')
    const chain = [
      'AGENTS.md',
      ...parts.map((_, i) => `${parts.slice(0, i + 1).join('/')}/AGENTS.md`),
    ]
    const present = [...new Set(chain)].filter((rel) => size(rel) !== null)
    const total = present.reduce((sum, rel) => sum + (size(rel) ?? 0), 0)
    if (total > cap) {
      warnings.push(
        `${file}: root + package AGENTS.md is ${total} bytes, over Codex's ${cap}-byte cap (${present.join(' + ')}) — Codex drops the tail of ${file}`,
      )
    }
  }
  return { errors, warnings }
}

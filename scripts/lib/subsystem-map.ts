/**
 * The subsystem map — the one index in this repository whose input is curated.
 *
 * Everything else under `docs/reference/` is derived from the workspace, so it
 * cannot rot. A *subsystem* cannot be: nothing in the manifests says that decode,
 * inference, tracking and the confirmation gate are one story, or that
 * `addon-export-hap` and `provider-homeassistant/src/ha-export` are two halves of
 * "ecosystem export". Manifests know packages, capabilities know methods, the
 * call graph knows edges — none of them knows chapters.
 *
 * So exactly one fact is hand-written (`docs/subsystems.yaml`: id, title, one
 * sentence, an owner doc, globs) and every join over it is generated:
 *
 *   docs/reference/subsystems.md   subsystem → files, claiming docs, what is uncovered
 *   docs/reference/coverage.md     unit → claiming docs → each one's last-verified
 *
 * Deliberately absent from both pages: any git commit date. `docs-generate
 * --check` runs in CI, so a page containing "when did this code last change"
 * would drift on every commit that touched any source file and make the docs job
 * red for reasons no author could act on. Freshness lives in the guard
 * (`check-docs-drift.ts`), which is allowed to disagree with yesterday.
 *
 * Rationale: `docs/design/documentation-map-and-plan.md` §3. The two-key
 * frontmatter rule this joins on: D145.
 */
import { claimGlobs, globToRegExp } from './docs-frontmatter.js'

// ── Model ──────────────────────────────────────────────────────────────────

export interface SubsystemEntry {
  readonly id: string
  readonly title: string
  /** One sentence. The only free prose in the whole index. */
  readonly purpose: string
  /** The page that OWNS this subsystem, or null while nobody has written one. */
  readonly ownerDoc: string | null
  readonly globs: readonly string[]
}

/** One document's claims, already parsed out of its frontmatter. */
export interface DocClaim {
  readonly doc: string
  readonly appliesTo: readonly string[]
  readonly covers: readonly string[]
  readonly lastVerified: string | null
}

export interface SubsystemMapInput {
  readonly taxonomy: readonly SubsystemEntry[]
  /** Repo-relative source files, already filtered by `isSourceFile`. */
  readonly sourceFiles: readonly string[]
  readonly docs: readonly DocClaim[]
  /** Every markdown file that exists, for validating `owner-doc`. */
  readonly existingDocs: ReadonlySet<string>
}

export type ClaimKind = 'applies-to' | 'covers' | 'both'

export interface ClaimingDoc {
  readonly doc: string
  readonly via: ClaimKind
  readonly lastVerified: string | null
  /** How many of the subject's files this document claims. */
  readonly files: number
}

/** ❌ nobody · ⚠️ described but not by its own owner doc · ✅ owned. */
export type SubsystemStatus = 'covered' | 'partial' | 'uncovered'

export interface SubsystemView {
  readonly entry: SubsystemEntry
  readonly files: readonly string[]
  readonly claimedFiles: number
  readonly uncoveredFiles: readonly string[]
  readonly docs: readonly ClaimingDoc[]
  readonly freshest: string | null
  readonly status: SubsystemStatus
}

/** A package, or one `src/<dir>` of a package too large to be one unit. */
export interface UnitView {
  readonly unit: string
  readonly files: number
  readonly docs: readonly ClaimingDoc[]
  readonly subsystems: readonly string[]
}

export interface SubsystemMap {
  readonly subsystems: readonly SubsystemView[]
  readonly units: readonly UnitView[]
  /** Source files no subsystem claims — the ratchet. */
  readonly orphans: readonly string[]
  readonly deadGlobs: readonly { readonly id: string; readonly glob: string }[]
  readonly missingOwnerDocs: readonly { readonly id: string; readonly doc: string }[]
  readonly totalFiles: number
  readonly uncoveredSubsystems: number
}

// ── Taxonomy parsing ───────────────────────────────────────────────────────

/**
 * Minimal YAML subset for `docs/subsystems.yaml`, matching the deliberate
 * no-parser stance of `docs-frontmatter.ts`: this runs in the pre-commit hook,
 * and a hook that pulls a YAML library is a hook that breaks on a cold install.
 *
 * Supported, and nothing else: a top-level sequence of mappings, scalar values,
 * a folded `purpose: >` block, and a `globs:` sequence.
 */
export function parseSubsystemsYaml(text: string): readonly SubsystemEntry[] {
  interface Draft {
    id: string
    title: string
    purpose: string[]
    ownerDoc: string | null
    globs: string[]
  }
  const drafts: Draft[] = []
  let current: Draft | null = null
  let mode: 'none' | 'globs' | 'purpose' = 'none'

  const push = (): void => {
    if (current !== null) drafts.push(current)
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue

    const entryStart = /^-\s+id:\s*(.+)$/.exec(line)
    if (entryStart) {
      push()
      current = { id: entryStart[1].trim(), title: '', purpose: [], ownerDoc: null, globs: [] }
      mode = 'none'
      continue
    }
    if (current === null) continue

    const listItem = /^\s+-\s+(.+)$/.exec(line)
    if (listItem && mode === 'globs') {
      current.globs.push(listItem[1].trim().replaceAll(/['"]/g, ''))
      continue
    }
    const kv = /^\s+([\w-]+):\s*(.*)$/.exec(line)
    if (kv) {
      const [, key, value] = kv
      const trimmed = value.trim()
      mode = 'none'
      if (key === 'title') current.title = trimmed
      else if (key === 'owner-doc') current.ownerDoc = trimmed.length > 0 ? trimmed : null
      else if (key === 'globs') mode = 'globs'
      else if (key === 'purpose') {
        if (trimmed === '>' || trimmed === '|') mode = 'purpose'
        else current.purpose.push(trimmed)
      }
      continue
    }
    if (mode === 'purpose') current.purpose.push(line.trim())
  }
  push()

  const seen = new Set<string>()
  return drafts.map((d) => {
    if (seen.has(d.id)) throw new Error(`docs/subsystems.yaml: duplicate id \`${d.id}\``)
    seen.add(d.id)
    return {
      id: d.id,
      title: d.title,
      purpose: d.purpose.join(' ').trim(),
      ownerDoc: d.ownerDoc,
      globs: d.globs,
    }
  })
}

// ── Units ──────────────────────────────────────────────────────────────────

/**
 * A package is one unit until it is too big to reason about as one, at which
 * point its `src/<dir>` children become the units. 60 is where this repository's
 * packages stop being "a thing" and start being "a place things live" —
 * `addon-pipeline` at 250 files says nothing useful as a single row, while its
 * `stream-broker` / `recorder` / `detection-pipeline` split does.
 */
const UNIT_SPLIT_THRESHOLD = 60

function packageOf(file: string): string | null {
  const parts = file.split('/')
  if ((parts[0] === 'packages' || parts[0] === 'server') && parts.length > 2) {
    return `${parts[0]}/${parts[1]}`
  }
  return null
}

function unitOf(file: string, split: ReadonlySet<string>): string {
  const pkg = packageOf(file)
  if (pkg === null) return file.split('/')[0]
  const parts = file.split('/')
  if (split.has(pkg) && parts[2] === 'src' && parts.length > 4) return `${pkg}/src/${parts[3]}`
  return pkg
}

function splitPackages(files: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>()
  for (const file of files) {
    const pkg = packageOf(file)
    if (pkg === null) continue
    counts.set(pkg, (counts.get(pkg) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, n]) => n > UNIT_SPLIT_THRESHOLD).map(([pkg]) => pkg))
}

// ── The join ───────────────────────────────────────────────────────────────

function matchAll(globs: readonly string[], files: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>()
  for (const glob of globs) {
    const re = globToRegExp(glob)
    for (const file of files) if (re.test(file)) out.add(file)
  }
  return out
}

function claimKind(
  doc: DocClaim,
  files: ReadonlySet<string>,
  universe: readonly string[],
): ClaimKind | null {
  const byApplies = [...matchAll(doc.appliesTo, universe)].some((f) => files.has(f))
  const byCovers = [...matchAll(doc.covers, universe)].some((f) => files.has(f))
  if (byApplies && byCovers) return 'both'
  if (byApplies) return 'applies-to'
  if (byCovers) return 'covers'
  return null
}

function freshestOf(docs: readonly ClaimingDoc[]): string | null {
  const dates = docs.map((d) => d.lastVerified).filter((d): d is string => d !== null)
  return dates.length === 0 ? null : (dates.toSorted().at(-1) ?? null)
}

export function buildSubsystemMap(input: SubsystemMapInput): SubsystemMap {
  const universe = [...input.sourceFiles].toSorted()

  // Each document's claimed files, computed ONCE — `claimGlobs` is the union
  // `applies-to ∪ covers` from D145 and is the only definition of "claims".
  const docFiles = new Map<string, ReadonlySet<string>>()
  for (const doc of input.docs) {
    docFiles.set(doc.doc, matchAll(claimGlobs(doc), universe))
  }

  const claimedAnywhere = new Set<string>()
  for (const files of docFiles.values()) for (const f of files) claimedAnywhere.add(f)

  const assigned = new Set<string>()
  const subsystemsOf = new Map<string, string[]>()
  const deadGlobs: { id: string; glob: string }[] = []
  const missingOwnerDocs: { id: string; doc: string }[] = []

  const subsystems: SubsystemView[] = input.taxonomy.map((entry) => {
    for (const glob of entry.globs) {
      const re = globToRegExp(glob)
      if (!universe.some((f) => re.test(f))) deadGlobs.push({ id: entry.id, glob })
    }
    if (entry.ownerDoc !== null && !input.existingDocs.has(entry.ownerDoc)) {
      missingOwnerDocs.push({ id: entry.id, doc: entry.ownerDoc })
    }

    const files = [...matchAll(entry.globs, universe)].toSorted()
    for (const f of files) {
      assigned.add(f)
      const list = subsystemsOf.get(f)
      if (list) list.push(entry.id)
      else subsystemsOf.set(f, [entry.id])
    }

    const fileSet = new Set(files)
    const docs: ClaimingDoc[] = []
    for (const doc of input.docs) {
      const claimed = docFiles.get(doc.doc) ?? new Set<string>()
      const overlap = files.filter((f) => claimed.has(f))
      if (overlap.length === 0) continue
      const via = claimKind(doc, fileSet, universe)
      if (via === null) continue
      docs.push({ doc: doc.doc, via, lastVerified: doc.lastVerified, files: overlap.length })
    }
    docs.sort((a, b) => b.files - a.files || a.doc.localeCompare(b.doc))

    const uncoveredFiles = files.filter((f) => !claimedAnywhere.has(f))
    const ownedByItsPage = entry.ownerDoc !== null && docs.some((d) => d.doc === entry.ownerDoc)
    const status: SubsystemStatus =
      docs.length === 0 ? 'uncovered' : ownedByItsPage ? 'covered' : 'partial'

    return {
      entry,
      files,
      claimedFiles: files.length - uncoveredFiles.length,
      uncoveredFiles,
      docs,
      freshest: freshestOf(docs),
      status,
    }
  })

  // ── the same data, pivoted by unit ──
  const split = splitPackages(universe)
  const unitFiles = new Map<string, string[]>()
  for (const file of universe) {
    const unit = unitOf(file, split)
    const list = unitFiles.get(unit)
    if (list) list.push(file)
    else unitFiles.set(unit, [file])
  }

  const units: UnitView[] = [...unitFiles].map(([unit, files]) => {
    const fileSet = new Set(files)
    const docs: ClaimingDoc[] = []
    for (const doc of input.docs) {
      const claimed = docFiles.get(doc.doc) ?? new Set<string>()
      const overlap = files.filter((f) => claimed.has(f))
      if (overlap.length === 0) continue
      const via = claimKind(doc, fileSet, universe)
      if (via === null) continue
      docs.push({ doc: doc.doc, via, lastVerified: doc.lastVerified, files: overlap.length })
    }
    docs.sort((a, b) => b.files - a.files || a.doc.localeCompare(b.doc))
    const ids = new Set<string>()
    for (const f of files) for (const id of subsystemsOf.get(f) ?? []) ids.add(id)
    return { unit, files: files.length, docs, subsystems: [...ids].toSorted() }
  })
  units.sort((a, b) => b.files - a.files || a.unit.localeCompare(b.unit))

  return {
    subsystems,
    units,
    orphans: universe.filter((f) => !assigned.has(f)),
    deadGlobs,
    missingOwnerDocs,
    totalFiles: universe.length,
    uncoveredSubsystems: subsystems.filter((s) => s.status === 'uncovered').length,
  }
}

// ── Guard decisions ────────────────────────────────────────────────────────

export type ProblemKind = 'dead-glob' | 'missing-owner-doc' | 'orphans'

export interface SubsystemProblem {
  readonly kind: ProblemKind
  readonly message: string
}

/**
 * `maxOrphans` is a RATCHET, pinned in CI exactly as `--max-stale` is: a file in
 * no subsystem is a hole in the taxonomy, not a broken build, and hard-failing
 * on it would make every new package hostage to a docs edit. Dead globs and
 * missing owner docs are hard failures — both mean the curated file describes
 * something that is not there, and the fix is always one line.
 */
export function findSubsystemProblems(
  map: SubsystemMap,
  maxOrphans: number | null,
): readonly SubsystemProblem[] {
  const problems: SubsystemProblem[] = []
  for (const { id, glob } of map.deadGlobs) {
    problems.push({
      kind: 'dead-glob',
      message: `subsystem \`${id}\`: glob \`${glob}\` matches no source file — the subsystem outlived its code`,
    })
  }
  for (const { id, doc } of map.missingOwnerDocs) {
    problems.push({
      kind: 'missing-owner-doc',
      message: `subsystem \`${id}\`: owner-doc \`${doc}\` does not exist`,
    })
  }
  if (maxOrphans !== null && map.orphans.length > maxOrphans) {
    problems.push({
      kind: 'orphans',
      message: `${String(map.orphans.length)} source file(s) belong to no subsystem, ceiling is ${String(maxOrphans)}`,
    })
  }
  return problems
}

// ── Rendering ──────────────────────────────────────────────────────────────

const STATUS_MARK: Readonly<Record<SubsystemStatus, string>> = {
  covered: '✅',
  partial: '⚠️',
  uncovered: '❌',
}

function code(value: string): string {
  return `\`${value}\``
}

function mdTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(' | ')} |`
  const rule = `| ${headers.map(() => '---').join(' | ')} |`
  const body = rows.map((r) => `| ${r.join(' | ')} |`)
  return [head, rule, ...body].join('\n')
}

function docLabel(d: ClaimingDoc): string {
  const name = d.doc.replace(/^docs\//, '')
  return d.via === 'covers' ? `${code(name)} _(covers)_` : code(name)
}

/** Documents, shortened: ADRs collapse to a count — 25 of them help nobody read. */
function docsCell(docs: readonly ClaimingDoc[]): string {
  if (docs.length === 0) return '—'
  const pages = docs.filter((d) => !/\/adr-\d+\.md$/.test(d.doc))
  const adrs = docs.length - pages.length
  const shown = pages.slice(0, 3).map(docLabel)
  if (pages.length > 3) shown.push(`+${String(pages.length - 3)} more`)
  if (adrs > 0) shown.push(`${String(adrs)} ADR${adrs === 1 ? '' : 's'}`)
  return shown.join(', ')
}

/** Uncovered files as directories with counts — a 631-line file list is not a to-do. */
function uncoveredCell(files: readonly string[]): string {
  if (files.length === 0) return '—'
  const byDir = new Map<string, number>()
  for (const f of files) {
    const dir = f.slice(0, f.lastIndexOf('/'))
    byDir.set(dir, (byDir.get(dir) ?? 0) + 1)
  }
  const sorted = [...byDir].toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = sorted.slice(0, 6).map(([dir, n]) => `${code(dir)} (${String(n)})`)
  if (sorted.length > 6) shown.push(`+${String(sorted.length - 6)} more directories`)
  return shown.join(', ')
}

export function renderSubsystemsPage(map: SubsystemMap, banner: string): string {
  const lines: string[] = [banner, '# Subsystem index', '']
  lines.push(
    'Every chapter of this system, what it consists of, and which documents claim',
    'it. The taxonomy — id, title, one sentence of purpose, an owning page and a',
    'set of globs — is the only hand-written input, in `docs/subsystems.yaml`.',
    'Everything else on this page is a join over the workspace and over document',
    'frontmatter, so it cannot disagree with the repository.',
    '',
    `**${String(map.subsystems.length)} subsystems · ${String(map.totalFiles)} source files · ` +
      `${String(map.orphans.length)} file(s) in no subsystem.**`,
    '',
    'Status: ✅ its own owner page claims it · ⚠️ described only by other documents',
    '(often decision records, which are normative and never re-verified) · ❌ no',
    'document claims a single file of it.',
    '',
    'Freshest is the newest `last-verified` among the claiming documents. It is not',
    'compared against the code here on purpose — that comparison belongs to',
    '`scripts/check-docs-drift.ts`, which is allowed to change its mind between',
    'commits. A generated page may not.',
    '',
  )
  lines.push(
    mdTable(
      ['Subsystem', 'Files', 'Documents', 'Freshest', 'State'],
      map.subsystems.map((s) => [
        s.entry.title,
        String(s.files.length),
        docsCell(s.docs),
        s.freshest ?? '—',
        STATUS_MARK[s.status],
      ]),
    ),
  )
  lines.push('', '## What each subsystem is, and what is uncovered inside it', '')
  for (const s of map.subsystems) {
    lines.push(`### ${STATUS_MARK[s.status]} ${s.entry.title}`, '')
    lines.push(s.entry.purpose, '')
    const owner = s.entry.ownerDoc === null ? '— none' : code(s.entry.ownerDoc)
    lines.push(
      `- **Owner doc**: ${owner}`,
      `- **Code**: ${s.entry.globs.map(code).join(', ')}`,
      `- **Files**: ${String(s.files.length)} (${String(s.claimedFiles)} claimed by some document)`,
      `- **Uncovered**: ${uncoveredCell(s.uncoveredFiles)}`,
      '',
    )
  }
  if (map.orphans.length > 0) {
    lines.push('## Claimed by no subsystem', '')
    lines.push(
      'The taxonomy has a hole here. This list is the `--max-orphans` ratchet in',
      '`.github/workflows/ci.yml`; it only ever goes down.',
      '',
      uncoveredCell(map.orphans),
      '',
    )
  }
  return lines.join('\n')
}

export function renderCoveragePage(map: SubsystemMap, banner: string): string {
  const claimed = map.units.filter((u) => u.docs.length > 0)
  const claimedFiles = claimed.reduce((n, u) => n + u.files, 0)
  const lines: string[] = [banner, '# Documentation coverage, by unit', '']
  lines.push(
    'The subsystem index pivoted the other way: one row per unit of code — a',
    'package, or one `src/<dir>` of a package too large to be a single row — and',
    'the documents that claim it.',
    '',
    'A document claims a unit by naming any of its files in frontmatter, under',
    '`applies-to` (which also arms the staleness ratchet) or `covers` (which',
    'claims coverage and arms nothing — D145). A unit claimed only by decision',
    'records is a real state and is shown as such: a record says what rule holds,',
    'it never describes how the thing works, and it is never re-verified.',
    '',
    `**${String(map.units.length)} units · ${String(map.totalFiles)} source files · ` +
      `${String(claimed.length)} units claimed by at least one document ` +
      `(${String(claimedFiles)} files).**`,
    '',
  )
  lines.push(
    mdTable(
      ['Unit', 'Files', 'Subsystem(s)', 'Claimed by', 'Freshest'],
      map.units.map((u) => [
        code(u.unit),
        String(u.files),
        u.subsystems.length === 0 ? '—' : u.subsystems.map(code).join(', '),
        docsCell(u.docs),
        freshestOf(u.docs) ?? '—',
      ]),
    ),
  )
  lines.push('')
  return lines.join('\n')
}

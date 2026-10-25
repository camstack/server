import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DevelopOverlay } from '../config.js'
import { headingSlug, splitByHeading } from './headings.js'
import { loadPlanningDocs, planningCloneRoot, type PlanningIndexStatus } from './planning.js'
import type { KnowledgeDoc, KnowledgeHit, KnowledgeKind } from './types.js'

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'worktrees', '.claude', 'coverage'])

export interface KnowledgeIndex {
  readonly docs: readonly KnowledgeDoc[]
  readonly builtAt: number
  /** Present when the sibling planning clone was indexed; otherwise one notice. */
  readonly planning: PlanningIndexStatus
  search(query: string, opts?: { kinds?: readonly KnowledgeKind[]; limit?: number }): KnowledgeHit[]
  getById(id: string): KnowledgeDoc | undefined
}

interface CachedIndex {
  index: KnowledgeIndex
  signature: string
}

const cacheByRoot = new Map<string, CachedIndex>()

export function getKnowledgeIndex(workspaceRoot: string, overlay: DevelopOverlay): KnowledgeIndex {
  const signature = buildSignature(workspaceRoot, overlay)
  const cached = cacheByRoot.get(workspaceRoot)
  if (cached && cached.signature === signature) return cached.index
  const index = buildIndex(workspaceRoot, overlay)
  cacheByRoot.set(workspaceRoot, { index, signature })
  return index
}

/** Test helper — drop caches between cases. */
export function clearKnowledgeCache(): void {
  cacheByRoot.clear()
}

function buildSignature(workspaceRoot: string, overlay: DevelopOverlay): string {
  const roots = [
    path.join(workspaceRoot, 'docs', 'decisions'),
    path.join(workspaceRoot, 'docs', 'architecture'),
    path.join(workspaceRoot, 'docs', 'reference', 'guards.md'),
    path.join(workspaceRoot, 'docs', 'subsystems.yaml'),
    path.join(workspaceRoot, 'AGENTS.md'),
    planningCloneRoot(workspaceRoot),
    ...overlay.memoryRoots,
    ...overlay.skillRoots,
  ]
  const parts = roots.map((r) => {
    try {
      const st = fs.statSync(r)
      return `${r}:${st.mtimeMs}:${st.isDirectory() ? 'd' : 'f'}`
    } catch {
      return `${r}:missing`
    }
  })
  return parts.join('|')
}

function buildIndex(workspaceRoot: string, overlay: DevelopOverlay): KnowledgeIndex {
  const planningLoad = loadPlanningDocs(workspaceRoot)
  const docs: KnowledgeDoc[] = []
  docs.push(...loadAdrs(workspaceRoot))
  docs.push(...loadArchitecture(workspaceRoot))
  docs.push(...loadAgents(workspaceRoot))
  docs.push(...loadGuards(workspaceRoot))
  docs.push(...loadSubsystems(workspaceRoot))
  docs.push(...loadMemory(overlay.memoryRoots, workspaceRoot))
  docs.push(...loadPrivateSkills(overlay.skillRoots, workspaceRoot))
  docs.push(...planningLoad.docs)

  const byId = new Map(docs.map((d) => [d.id, d]))
  const inverted = buildInverted(docs)

  return {
    docs,
    planning: planningLoad.planning,
    builtAt: Date.now(),
    getById(id) {
      return byId.get(id)
    },
    search(query, opts) {
      return searchDocs(docs, inverted, query, opts?.kinds, opts?.limit ?? 12)
    },
  }
}

function loadAdrs(root: string): KnowledgeDoc[] {
  const dir = path.join(root, 'docs', 'decisions')
  if (!fs.existsSync(dir)) return []
  const out: KnowledgeDoc[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith('adr-') || !name.endsWith('.md')) continue
    const filePath = path.join(dir, name)
    const text = readSafe(filePath)
    if (!text) continue
    const fm = parseFrontmatter(text)
    const id = String(fm.id ?? name.replace(/\.md$/, ''))
    const decision = section(text, 'Decision') ?? ''
    const context = section(text, 'Context') ?? ''
    const enforcement = section(text, 'Enforcement') ?? ''
    out.push({
      id: normalizeAdrId(id),
      kind: 'adr',
      path: filePath,
      relativePath: path.relative(root, filePath),
      title: String(fm.title ?? id),
      body: [decision, context, enforcement].filter(Boolean).join('\n\n'),
      mtimeMs: fs.statSync(filePath).mtimeMs,
      meta: {
        status: fm.status,
        appliesTo: fm['applies-to'] ?? fm.appliesTo,
        covers: fm.covers,
        supersedes: fm.supersedes,
        supersededBy: fm['superseded-by'] ?? fm.supersededBy,
        date: fm.date,
        decision,
        enforcement,
        rawId: id,
      },
    })
  }
  return out
}

function loadArchitecture(root: string): KnowledgeDoc[] {
  const dir = path.join(root, 'docs', 'architecture')
  if (!fs.existsSync(dir)) return []
  const out: KnowledgeDoc[] = []
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue
    const filePath = path.join(dir, name)
    const text = readSafe(filePath)
    if (!text) continue
    // Split by headings so search can hit sections.
    const chunks = splitByHeading(text)
    for (const chunk of chunks) {
      const id = `arch:${name.replace(/\.md$/, '')}${chunk.heading ? `#${headingSlug(chunk.heading)}` : ''}`
      out.push({
        id,
        kind: 'architecture',
        path: filePath,
        relativePath: path.relative(root, filePath),
        title: chunk.heading || name.replace(/\.md$/, ''),
        body: chunk.body.slice(0, 8000),
        mtimeMs: fs.statSync(filePath).mtimeMs,
        meta: { heading: chunk.heading },
      })
    }
  }
  return out
}

function loadAgents(root: string): KnowledgeDoc[] {
  const out: KnowledgeDoc[] = []
  const candidates = [
    path.join(root, 'AGENTS.md'),
    path.join(root, 'camstack', 'AGENTS.md'),
    ...findAgentsUnder(path.join(root, 'packages')),
  ]
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue
    // Skip worktree copies
    if (filePath.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) continue
    const text = readSafe(filePath)
    if (!text) continue
    const rel = path.relative(root, filePath)
    out.push({
      id: `agents:${rel}`,
      kind: 'agents',
      path: filePath,
      relativePath: rel,
      title: `AGENTS — ${rel}`,
      body: text.slice(0, 12000),
      mtimeMs: fs.statSync(filePath).mtimeMs,
    })
  }
  return out
}

function findAgentsUnder(packagesDir: string): string[] {
  if (!fs.existsSync(packagesDir)) return []
  const found: string[] = []
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const agents = path.join(packagesDir, entry.name, 'AGENTS.md')
    if (fs.existsSync(agents)) found.push(agents)
  }
  return found
}

function loadGuards(root: string): KnowledgeDoc[] {
  const filePath = path.join(root, 'docs', 'reference', 'guards.md')
  const text = readSafe(filePath)
  if (!text) return []
  const out: KnowledgeDoc[] = []
  const rowRe = /^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|$/gm
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(text)) !== null) {
    const guardPath = m[1]!.trim()
    const refuses = m[2]!.trim()
    out.push({
      id: `guard:${guardPath}`,
      kind: 'guard',
      path: filePath,
      relativePath: path.relative(root, filePath),
      title: guardPath,
      body: refuses,
      mtimeMs: fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0,
      meta: { command: guardPath.startsWith('scripts/') ? `npx tsx ${guardPath}` : guardPath },
    })
  }
  return out
}

function loadSubsystems(root: string): KnowledgeDoc[] {
  const filePath = path.join(root, 'docs', 'subsystems.yaml')
  const text = readSafe(filePath)
  if (!text) return []
  const out: KnowledgeDoc[] = []
  // Lightweight YAML subset: `- id:` blocks.
  const blocks = text.split(/\n(?=- id:)/)
  for (const block of blocks) {
    const idMatch = /^-?\s*id:\s*(\S+)/m.exec(block)
    if (!idMatch) continue
    const id = idMatch[1]!
    const title = /title:\s*(.+)/.exec(block)?.[1]?.trim() ?? id
    const purpose = extractFolded(block, 'purpose') ?? ''
    const globs = [...block.matchAll(/^\s+-\s+(.+)$/gm)].map((x) => x[1]!.trim())
    out.push({
      id: `subsystem:${id}`,
      kind: 'subsystem',
      path: filePath,
      relativePath: path.relative(root, filePath),
      title,
      body: `${purpose}\n${globs.join('\n')}`,
      mtimeMs: fs.statSync(filePath).mtimeMs,
      meta: { subsystemId: id, globs, purpose },
    })
  }
  return out
}

function loadMemory(roots: readonly string[], workspaceRoot: string): KnowledgeDoc[] {
  const out: KnowledgeDoc[] = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    walkFiles(root, (filePath) => {
      if (!filePath.endsWith('.md')) return
      const text = readSafe(filePath)
      if (!text) return
      const rel = path.relative(workspaceRoot, filePath)
      const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path.basename(filePath)
      out.push({
        id: `memory:${filePath}`,
        kind: 'memory',
        path: filePath,
        relativePath: rel.startsWith('..') ? filePath : rel,
        title,
        body: text.slice(0, 6000),
        private: true,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      })
    })
  }
  return out
}

function loadPrivateSkills(roots: readonly string[], workspaceRoot: string): KnowledgeDoc[] {
  const out: KnowledgeDoc[] = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    walkFiles(root, (filePath) => {
      const base = path.basename(filePath)
      if (base !== 'SKILL.md' && !filePath.endsWith('.md')) return
      // Prefer camstack-* skill dirs and repo skills.
      const parent = path.basename(path.dirname(filePath))
      if (
        !/camstack/i.test(parent) &&
        base !== 'SKILL.md' &&
        !filePath.includes(`${path.sep}.claude${path.sep}skills`)
      ) {
        return
      }
      const text = readSafe(filePath)
      if (!text) return
      const id = parent.startsWith('camstack') ? parent : path.basename(filePath, '.md')
      out.push({
        id: `skill:${id}`,
        kind: 'skill',
        path: filePath,
        relativePath: path.relative(workspaceRoot, filePath).startsWith('..')
          ? filePath
          : path.relative(workspaceRoot, filePath),
        title: id,
        body: text.slice(0, 8000),
        private: /\/\.claude\//.test(filePath) || parent.startsWith('camstack'),
        mtimeMs: fs.statSync(filePath).mtimeMs,
      })
    })
  }
  // Also index repo .claude/skills
  const repoSkills = path.join(workspaceRoot, '.claude', 'skills')
  if (fs.existsSync(repoSkills)) {
    for (const entry of fs.readdirSync(repoSkills, { withFileTypes: true })) {
      const skillFile = entry.isDirectory()
        ? path.join(repoSkills, entry.name, 'SKILL.md')
        : entry.name.endsWith('.md')
          ? path.join(repoSkills, entry.name)
          : null
      if (!skillFile || !fs.existsSync(skillFile)) continue
      const text = readSafe(skillFile)
      if (!text) continue
      const id = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/, '')
      if (out.some((d) => d.id === `skill:${id}`)) continue
      out.push({
        id: `skill:${id}`,
        kind: 'skill',
        path: skillFile,
        relativePath: path.relative(workspaceRoot, skillFile),
        title: id,
        body: text.slice(0, 8000),
        mtimeMs: fs.statSync(skillFile).mtimeMs,
      })
    }
  }
  return out
}

// ── Search (simple TF × IDF over tokenized docs) ───────────────────────────

interface Inverted {
  readonly df: Map<string, number>
  readonly tf: Map<string, Map<string, number>> // term -> docId -> count
  readonly docLen: Map<string, number>
  readonly avgLen: number
  readonly N: number
}

function buildInverted(docs: readonly KnowledgeDoc[]): Inverted {
  const df = new Map<string, number>()
  const tf = new Map<string, Map<string, number>>()
  const docLen = new Map<string, number>()
  let totalLen = 0
  for (const doc of docs) {
    const tokens = tokenize(`${doc.title} ${doc.body}`)
    docLen.set(doc.id, tokens.length)
    totalLen += tokens.length
    const seen = new Set<string>()
    const counts = new Map<string, number>()
    for (const t of tokens) {
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
    for (const [term, count] of counts) {
      if (!tf.has(term)) tf.set(term, new Map())
      tf.get(term)!.set(doc.id, count)
      if (!seen.has(term)) {
        seen.add(term)
        df.set(term, (df.get(term) ?? 0) + 1)
      }
    }
  }
  return {
    df,
    tf,
    docLen,
    avgLen: docs.length > 0 ? totalLen / docs.length : 1,
    N: docs.length,
  }
}

function searchDocs(
  docs: readonly KnowledgeDoc[],
  inverted: Inverted,
  query: string,
  kinds: readonly KnowledgeKind[] | undefined,
  limit: number,
): KnowledgeHit[] {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return []
  const scores = new Map<string, number>()
  const k1 = 1.2
  const b = 0.75
  for (const term of qTokens) {
    const postings = inverted.tf.get(term)
    if (!postings) continue
    const df = inverted.df.get(term) ?? 1
    const idf = Math.log(1 + (inverted.N - df + 0.5) / (df + 0.5))
    for (const [docId, termFreq] of postings) {
      const dl = inverted.docLen.get(docId) ?? inverted.avgLen
      const denom = termFreq + k1 * (1 - b + b * (dl / inverted.avgLen))
      const score = (idf * (termFreq * (k1 + 1))) / denom
      scores.set(docId, (scores.get(docId) ?? 0) + score)
    }
  }
  const byId = new Map(docs.map((d) => [d.id, d]))
  const hits: KnowledgeHit[] = []
  for (const [docId, score] of scores) {
    const doc = byId.get(docId)
    if (!doc) continue
    if (kinds && kinds.length > 0 && !kinds.includes(doc.kind)) continue
    hits.push({
      id: doc.id,
      kind: doc.kind,
      path: doc.path,
      relativePath: doc.relativePath,
      title: doc.title,
      score: Math.round(score * 1000) / 1000,
      snippet: makeSnippet(doc.body || doc.title, qTokens),
      ...(doc.private ? { private: true } : {}),
      ...(doc.source ? { source: doc.source } : {}),
    })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, limit)
}

function makeSnippet(body: string, terms: readonly string[]): string {
  const lower = body.toLowerCase()
  let best = 0
  for (const t of terms) {
    const idx = lower.indexOf(t)
    if (idx >= 0) {
      best = idx
      break
    }
  }
  const start = Math.max(0, best - 80)
  const slice = body
    .slice(start, start + 220)
    .replace(/\s+/g, ' ')
    .trim()
  return (start > 0 ? '…' : '') + slice + (start + 220 < body.length ? '…' : '')
}

// ── ADR helpers exported for tools ─────────────────────────────────────────

export function normalizeAdrId(raw: string): string {
  const s = raw.trim()
  const dOnly = /^D?(\d+)$/i.exec(s)
  if (dOnly) return `D${Number(dOnly[1])}`
  const adr = /^adr-0*(\d+)/i.exec(s)
  if (adr) return `D${Number(adr[1])}`
  if (/^D\d+/i.test(s)) return `D${Number(s.slice(1))}`
  return s.startsWith('D') || s.startsWith('d') ? `D${s.slice(1)}` : s
}

export function getDecision(index: KnowledgeIndex, id: string): KnowledgeDoc | null {
  const norm = normalizeAdrId(id)
  const direct = index.docs.find((d) => d.kind === 'adr' && d.id === norm)
  if (direct) return direct
  // Also match by file name fragment
  const needle = norm.replace(/^D/, '').padStart(4, '0')
  return (
    index.docs.find(
      (d) => d.kind === 'adr' && (d.relativePath.includes(`adr-${needle}`) || d.id === norm),
    ) ?? null
  )
}

export function decisionsForPath(index: KnowledgeIndex, filePath: string): KnowledgeDoc[] {
  const normalized = filePath.replace(/\\/g, '/')
  const hits: KnowledgeDoc[] = []
  for (const doc of index.docs) {
    if (doc.kind !== 'adr') continue
    const applies = doc.meta?.appliesTo
    const covers = doc.meta?.covers
    const lists = [...asPathList(applies), ...asPathList(covers)]
    if (lists.some((p) => pathMatches(normalized, p))) hits.push(doc)
  }
  // Also grep (Dnn) comments in the file if it exists
  if (fs.existsSync(filePath)) {
    const text = readSafe(filePath) ?? ''
    for (const m of text.matchAll(/\((D\d+)\)/g)) {
      const doc = getDecision(index, m[1]!)
      if (doc && !hits.some((h) => h.id === doc.id)) hits.push(doc)
    }
  }
  return hits
}

export function trapsFor(
  index: KnowledgeIndex,
  topic: string,
): { skills: KnowledgeHit[]; guards: KnowledgeHit[]; memory: KnowledgeHit[] } {
  const skills = index.search(topic, { kinds: ['skill'], limit: 8 })
  const guards = index.search(topic, { kinds: ['guard'], limit: 8 })
  const memory = index.search(topic, { kinds: ['memory'], limit: 8 })
  return { skills, guards, memory }
}

export function subsystemOf(
  index: KnowledgeIndex,
  filePath: string,
): { id: string; title: string; globs: string[] }[] {
  const normalized = filePath.replace(/\\/g, '/')
  const out: { id: string; title: string; globs: string[] }[] = []
  for (const doc of index.docs) {
    if (doc.kind !== 'subsystem') continue
    const globs = metaStrings(doc.meta?.globs)
    if (globs.some((g) => pathMatches(normalized, g))) {
      out.push({
        id: String(doc.meta?.subsystemId ?? doc.id),
        title: doc.title,
        globs,
      })
    }
  }
  return out
}

export function subsystemMap(
  index: KnowledgeIndex,
): { id: string; title: string; purpose: string; globs: string[] }[] {
  return index.docs
    .filter((d) => d.kind === 'subsystem')
    .map((d) => ({
      id: String(d.meta?.subsystemId ?? d.id),
      title: d.title,
      purpose: String(d.meta?.purpose ?? ''),
      globs: metaStrings(d.meta?.globs),
    }))
}

export function guardsFor(
  index: KnowledgeIndex,
  paths: readonly string[],
): { guard: string; command: string; refuses: string; score: number }[] {
  const query = paths.join(' ')
  return index.search(query, { kinds: ['guard'], limit: 20 }).map((h) => ({
    guard: h.title,
    command: h.title.startsWith('scripts/') ? `npx tsx ${h.title}` : h.title,
    refuses: h.snippet,
    score: h.score,
  }))
}

// ── tiny parsers ───────────────────────────────────────────────────────────

function readSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const block = text.slice(4, end)
  const out: Record<string, unknown> = {}
  let currentKey: string | null = null
  let listAcc: string[] | null = null
  for (const line of block.split('\n')) {
    if (/^\s+-\s+/.test(line) && currentKey && listAcc) {
      listAcc.push(line.replace(/^\s+-\s+/, '').trim())
      out[currentKey] = listAcc
      continue
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    currentKey = m[1]!
    const val = m[2]!.trim()
    if (val === '') {
      listAcc = []
      out[currentKey] = listAcc
    } else {
      listAcc = null
      out[currentKey] = val.replace(/^["']|["']$/g, '')
    }
  }
  return out
}

function section(text: string, name: string): string | null {
  const re = new RegExp(`^##\\s+${name}\\s*$`, 'im')
  const m = re.exec(text)
  if (!m || m.index === undefined) return null
  const start = m.index + m[0].length
  const rest = text.slice(start)
  const next = /^##\s+/m.exec(rest)
  return (next ? rest.slice(0, next.index) : rest).trim()
}

function extractFolded(block: string, key: string): string | null {
  const re = new RegExp(`${key}:\\s*>\\s*\\n((?:\\s{2,}.+\\n?)+)`)
  const m = re.exec(block)
  if (!m) {
    const one = new RegExp(`${key}:\\s*(.+)`).exec(block)
    return one?.[1]?.trim() ?? null
  }
  return m[1]!
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_/.-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}

function asPathList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  return []
}

function pathMatches(filePath: string, pattern: string): boolean {
  const p = pattern.replace(/\\/g, '/').replace(/^\.\//, '')
  const f = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  if (p.includes('*')) {
    const re = new RegExp(
      '^' +
        p
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '::DOUBLE::')
          .replace(/\*/g, '[^/]*')
          .replace(/::DOUBLE::/g, '.*') +
        '$',
    )
    return re.test(f)
  }
  return f === p || f.endsWith('/' + p) || f.includes(p)
}

function walkFiles(dir: string, visit: (filePath: string) => void, depth = 0): void {
  if (depth > 6) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIR_NAMES.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, visit, depth + 1)
    else if (entry.isFile()) visit(full)
  }
}

function metaStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

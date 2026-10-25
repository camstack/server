import * as fs from 'node:fs'
import * as path from 'node:path'
import type { KnowledgeDoc } from './types.js'

/**
 * The planning clone is the sibling of the main checkout, named `planning`.
 * A git worktree's parent is still inside the checkout, so `../planning` from
 * the worktree is the wrong place — resolve the main checkout first.
 */
const GITDIR_LINE = /^gitdir:\s*(.+)\s*$/m
const WORKTREES_SEGMENT = `${path.sep}worktrees${path.sep}`

const TREES: readonly string[] = [
  'sessions',
  'ideas',
  'superpowers',
  'archive',
  'infra',
  '.superpowers',
]
const ROOT_FILES: readonly string[] = ['ideas.md']
const DOC_EXT: ReadonlySet<string> = new Set(['.md', '.mdx', '.txt'])
const SKIP_DIR: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.code-review-graph',
])
const MAX_BYTES = 1_500_000
const BODY_CAP = 8_000
const MAX_DEPTH = 16

export interface PlanningIndexStatus {
  readonly present: boolean
  readonly notice: string | null
}

export interface PlanningLoad {
  readonly docs: readonly KnowledgeDoc[]
  readonly planning: PlanningIndexStatus
}

export function repositoryRoot(workspaceRoot: string): string {
  const gitPath = path.join(workspaceRoot, '.git')
  let text: string
  try {
    if (fs.statSync(gitPath).isDirectory()) return workspaceRoot
    text = fs.readFileSync(gitPath, 'utf8')
  } catch {
    return workspaceRoot
  }
  const match = GITDIR_LINE.exec(text)
  if (!match?.[1]) return workspaceRoot
  const gitDir = path.resolve(workspaceRoot, match[1].trim())
  const at = gitDir.lastIndexOf(WORKTREES_SEGMENT)
  if (at < 0) return workspaceRoot
  const commonGit = gitDir.slice(0, at)
  if (path.basename(commonGit) !== '.git') return workspaceRoot
  return path.dirname(commonGit)
}

export function planningCloneRoot(workspaceRoot: string): string {
  return path.resolve(repositoryRoot(workspaceRoot), '..', 'planning')
}

export function loadPlanningDocs(workspaceRoot: string): PlanningLoad {
  const root = planningCloneRoot(workspaceRoot)
  if (!isDir(root)) {
    return {
      docs: [],
      planning: {
        present: false,
        notice:
          `Planning clone not found at ${root} ` +
          '(sibling ../planning of the repository root); indexed nothing from it.',
      },
    }
  }
  const docs: KnowledgeDoc[] = []
  for (const name of ROOT_FILES) {
    const rel = name
    pushFile(docs, root, path.join(root, rel), rel)
  }
  for (const tree of TREES) {
    const dir = path.join(root, tree)
    if (!isDir(dir)) continue
    walk(dir, root, docs, 0)
  }
  return { docs, planning: { present: true, notice: null } }
}

function walk(dir: string, planningRoot: string, docs: KnowledgeDoc[], depth: number): void {
  if (depth > MAX_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry.name)) continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(abs, planningRoot, docs, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    const rel = path.relative(planningRoot, abs).split(path.sep).join('/')
    pushFile(docs, planningRoot, abs, rel)
  }
}

function pushFile(docs: KnowledgeDoc[], planningRoot: string, abs: string, rel: string): void {
  if (!DOC_EXT.has(path.extname(abs).toLowerCase())) return
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return
  }
  if (!st.isFile() || st.size > MAX_BYTES) return
  const text = readSafe(abs)
  if (text === null) return
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path.basename(abs)
  docs.push({
    id: `planning:${rel}`,
    kind: 'planning',
    path: abs,
    relativePath: rel,
    title,
    body: text.slice(0, BODY_CAP),
    source: 'planning',
    mtimeMs: st.mtimeMs,
    meta: { planningRoot },
  })
}

function isDir(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function readSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

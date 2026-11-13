/**
 * Cheap, bounded progress for an `npm install` staging directory.
 *
 * A full byte walk of a seeded closure (or of `process.cwd()` when a desktop
 * app's cwd is `/`) took 8–20s and ran on every npm invocation, including
 * `npm view`. Each poll therefore reads a few directory inodes first. The
 * recursive byte sum runs only when that signal is unchanged, and it stops
 * after {@link PROGRESS_WALK_ENTRY_BUDGET} entries or
 * {@link PROGRESS_WALK_TIME_BUDGET_MS}. A partial walk is not evidence of a
 * stall: the caller treats it as progress unknown.
 *
 * Symlinks are not followed. A path that disappears mid-walk is skipped.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Entries visited in one poll, cheap signal and byte sum together. */
export const PROGRESS_WALK_ENTRY_BUDGET: number = 20_000

/** Wall-clock cap for one poll's walk. Uses `Date.now`, not the install clock. */
export const PROGRESS_WALK_TIME_BUDGET_MS: number = 2_000

const NODE_MODULES_LEVELS = 2

const LOG_ENV_KEYS: readonly string[] = [
  'npm_config_logs_dir',
  'NPM_CONFIG_LOGS_DIR',
  'npm_config_tmp',
  'NPM_CONFIG_TMP',
]

const EMPTY_MARK: ProgressMarkParts = { newestMtimeMs: 0, size: 0, count: 0 }

interface ProgressMarkParts {
  readonly newestMtimeMs: number
  readonly size: number
  readonly count: number
}

interface WalkBudget {
  entries: number
  readonly startedMs: number
  exceeded: boolean
  aborted(): boolean
  readonly entryLimit: number
}

type WalkStop = 'budget' | 'aborted'

export interface ProgressMark {
  readonly kind: 'mark'
  /** `count:newestMtimeMs:size` of the cheap signal. Any difference is progress. */
  readonly cheap: string
  /** Byte sum of the staging tree. Null when the cheap signal already changed. */
  readonly bytes: number | null
}

export interface ProgressUnknown {
  readonly kind: 'unknown'
  readonly entries: number
  readonly elapsedMs: number
}

export interface ProgressAborted {
  readonly kind: 'aborted'
  readonly entries: number
}

export type ProgressSample = ProgressMark | ProgressUnknown | ProgressAborted

export interface MeasureProgressOptions {
  readonly stagingDir: string
  readonly progressDirs: readonly string[]
  readonly env: NodeJS.ProcessEnv
  /** Previous cheap token. A difference skips the byte walk. */
  readonly previousCheap: string | null
  readonly aborted: () => boolean
  /** Entries a walk may read before it gives up; defaults to {@link PROGRESS_WALK_ENTRY_BUDGET}. */
  readonly entryBudget?: number
}

/**
 * One poll. `unknown` means the walk hit its budget; `aborted` means the
 * child exited and the walk stopped. Neither is a stall.
 */
export async function measureInstallProgress(
  options: MeasureProgressOptions,
): Promise<ProgressSample> {
  const budget: WalkBudget = {
    entries: 0,
    startedMs: Date.now(),
    exceeded: false,
    aborted: options.aborted,
    entryLimit: options.entryBudget ?? PROGRESS_WALK_ENTRY_BUDGET,
  }
  const cheap = await collectCheap(options.stagingDir, options.progressDirs, options.env, budget)
  if (cheap === 'aborted') return { kind: 'aborted', entries: budget.entries }
  if (cheap === 'budget') return unknownSample(budget)
  const token = markToken(cheap)
  if (options.previousCheap !== null && token !== options.previousCheap) {
    return { kind: 'mark', cheap: token, bytes: null }
  }
  const sum = await sumTree(options.stagingDir, budget)
  if (sum === 'aborted') return { kind: 'aborted', entries: budget.entries }
  if (sum === 'budget') return unknownSample(budget)
  return { kind: 'mark', cheap: token, bytes: sum }
}

function unknownSample(budget: WalkBudget): ProgressUnknown {
  return {
    kind: 'unknown',
    entries: budget.entries,
    elapsedMs: Date.now() - budget.startedMs,
  }
}

function markToken(mark: ProgressMarkParts): string {
  return `${mark.count}:${mark.newestMtimeMs}:${mark.size}`
}

function withStat(mark: ProgressMarkParts, st: fs.Stats): ProgressMarkParts {
  return {
    newestMtimeMs: Math.max(mark.newestMtimeMs, st.mtimeMs),
    size: mark.size + st.size,
    count: mark.count + 1,
  }
}

function combineMarks(left: ProgressMarkParts, right: ProgressMarkParts): ProgressMarkParts {
  return {
    newestMtimeMs: Math.max(left.newestMtimeMs, right.newestMtimeMs),
    size: left.size + right.size,
    count: left.count + right.count,
  }
}

function consume(budget: WalkBudget): 'ok' | WalkStop {
  if (budget.aborted()) return 'aborted'
  const overEntries = budget.entries >= budget.entryLimit
  const overTime = Date.now() - budget.startedMs >= PROGRESS_WALK_TIME_BUDGET_MS
  if (overEntries || overTime) {
    budget.exceeded = true
    return 'budget'
  }
  budget.entries += 1
  return 'ok'
}

async function readLstat(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target)
  } catch {
    return null
  }
}

type InodeRead = ProgressMarkParts | WalkStop | 'miss'

async function inodeMark(target: string, budget: WalkBudget): Promise<InodeRead> {
  if (budget.aborted()) return 'aborted'
  const st = await readLstat(target)
  if (st === null) return 'miss'
  const gate = consume(budget)
  if (gate !== 'ok') return gate
  return withStat(EMPTY_MARK, st)
}

function applyMark(mark: ProgressMarkParts, value: InodeRead): ProgressMarkParts | WalkStop {
  if (value === 'miss') return mark
  if (value === 'budget' || value === 'aborted') return value
  return combineMarks(mark, value)
}

/**
 * `levels` is how many directory levels of entries to stat. Level 1 is the
 * directory's own children. Children that are directories are not opened
 * once `levels` is 1, so a cache bucket's files are never summed.
 */
async function levelMark(
  dir: string,
  budget: WalkBudget,
  levels: number,
): Promise<ProgressMarkParts | WalkStop> {
  let handle: fs.Dir
  try {
    handle = await fs.promises.opendir(dir)
  } catch {
    return EMPTY_MARK
  }
  let mark = EMPTY_MARK
  try {
    let entry: fs.Dirent | null
    while ((entry = await handle.read()) !== null) {
      const gate = consume(budget)
      if (gate !== 'ok') return gate
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      const st = await readLstat(full)
      if (st === null) continue
      mark = withStat(mark, st)
      if (levels <= 1 || !st.isDirectory()) continue
      const nested = await levelMark(full, budget, levels - 1)
      if (nested === 'budget' || nested === 'aborted') return nested
      mark = combineMarks(mark, nested)
    }
  } finally {
    await handle.close()
  }
  return mark
}

function logDirectories(
  progressDirs: readonly string[],
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const dirs: string[] = []
  for (const key of LOG_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.length > 0) dirs.push(value)
  }
  for (const cache of progressDirs) dirs.push(path.join(cache, '_logs'))
  return dirs
}

async function cacheInodes(
  mark: ProgressMarkParts,
  cacheDir: string,
  budget: WalkBudget,
): Promise<ProgressMarkParts | WalkStop> {
  const content = await inodeMark(path.join(cacheDir, '_cacache', 'content-v2'), budget)
  const withContent = applyMark(mark, content)
  if (withContent === 'budget' || withContent === 'aborted') return withContent
  const index = await inodeMark(path.join(cacheDir, '_cacache', 'index-v5'), budget)
  return applyMark(withContent, index)
}

async function collectCheap(
  stagingDir: string,
  progressDirs: readonly string[],
  env: NodeJS.ProcessEnv,
  budget: WalkBudget,
): Promise<ProgressMarkParts | WalkStop> {
  const root = await inodeMark(stagingDir, budget)
  const rooted = applyMark(EMPTY_MARK, root)
  if (rooted === 'budget' || rooted === 'aborted') return rooted
  const modules = await levelMark(
    path.join(stagingDir, 'node_modules'),
    budget,
    NODE_MODULES_LEVELS,
  )
  const withModules = applyMark(rooted, modules)
  if (withModules === 'budget' || withModules === 'aborted') return withModules
  let mark = withModules
  for (const cache of progressDirs) {
    const next = await cacheInodes(mark, cache, budget)
    if (next === 'budget' || next === 'aborted') return next
    mark = next
  }
  for (const logs of logDirectories(progressDirs, env)) {
    const listed = await levelMark(logs, budget, 1)
    const next = applyMark(mark, listed)
    if (next === 'budget' || next === 'aborted') return next
    mark = next
  }
  return mark
}

interface DirectoryBytes {
  readonly total: number
  readonly nested: readonly string[]
}

async function sumTree(root: string, budget: WalkBudget): Promise<number | WalkStop> {
  let total = 0
  let pending: readonly string[] = [root]
  while (pending.length > 0) {
    const dir = pending[pending.length - 1]
    if (dir === undefined) break
    pending = pending.slice(0, -1)
    const gate = consume(budget)
    if (gate !== 'ok') return gate
    const added = await sumDirectory(dir, budget)
    if (added === 'budget' || added === 'aborted') return added
    total += added.total
    pending = [...added.nested, ...pending]
  }
  return total
}

async function sumDirectory(dir: string, budget: WalkBudget): Promise<DirectoryBytes | WalkStop> {
  let handle: fs.Dir
  try {
    handle = await fs.promises.opendir(dir)
  } catch {
    const st = await readLstat(dir)
    return { total: st !== null && st.isFile() ? st.size : 0, nested: [] }
  }
  let total = 0
  const nested: string[] = []
  try {
    let entry: fs.Dirent | null
    while ((entry = await handle.read()) !== null) {
      const gate = consume(budget)
      if (gate !== 'ok') return gate
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        nested.push(full)
        continue
      }
      if (!entry.isFile()) continue
      const st = await readLstat(full)
      if (st !== null) total += st.size
    }
  } finally {
    await handle.close()
  }
  return { total, nested }
}

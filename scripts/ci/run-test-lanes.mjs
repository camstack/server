#!/usr/bin/env node
/**
 * Local verify:push test lanes. CI does not run this file.
 *
 * Heavy and light vitest processes run at the same time. Heavy projects start
 * longest-first, `VERIFY_HEAVY_PARALLEL` (default 2) at once. Worker counts
 * come from `lane-budget.mjs`, which refuses to schedule more workers than
 * the machine has cores.
 *
 * Collect time (measured 2026-11-10, summed across files so it can exceed the
 * wall clock): server-framework collect 609s against 325s of tests, 813 specs,
 * vitest 3 defaults `isolate: true` and `pool: 'forks'`, no setupFiles. That
 * re-evaluates the TypeScript graph per file. admin-ui adds four global
 * setupFiles, one of which imports both i18n catalogues (~0.5 MB each) into
 * every spec, and aliases `@camstack/ui-library` at the source barrel.
 * `isolate: false` or a threads pool would share that cost and would also
 * share module state (i18n language, the jest-dom `expect`, `better-sqlite3`
 * in the framework). Not changed: it needs a per-spec decision, not a flag.
 *
 * A failing project does not cancel the rest of the lane. One timing flake
 * used to hide the next one behind nx's bail; the timings file has to name
 * every project that ran.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { laneHeapMb, lanePlan, laneProcessCount, nodeOptionsWithHeap } from './lane-budget.mjs'
import { parseVitestSummary } from './verify-timing.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Nx project name → directory. `sdk` is the project.json name; the npm
 * workspace is `@camstack/sdk`, so `npm run test -w sdk` exits in under a
 * second and fails the lane. Roots come from the root `package.json`
 * workspaces (`packages/*`, `server/*`, and the `e2e` package, which is not
 * under either tree).
 *
 * @param {string} [root]
 * @returns {Map<string, string>}
 */
export function workspacePackageDirs(root = ROOT) {
  /** @type {Map<string, string>} */
  const dirs = new Map()
  for (const dir of workspaceDirs(root)) rememberPackage(dirs, root, dir)
  return dirs
}

/**
 * One directory per workspace entry. A `*` pattern expands one level, which
 * is every pattern this repo declares.
 *
 * @param {string} root
 * @returns {string[]}
 */
function workspaceDirs(root) {
  /** @type {string[]} */
  const dirs = []
  for (const pattern of workspacePatterns(root)) {
    if (!pattern.includes('*')) {
      dirs.push(pattern.replace(/\/$/, ''))
      continue
    }
    const base = pattern.slice(0, pattern.indexOf('*')).replace(/\/$/, '')
    const abs = path.join(root, base)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(path.join(base, entry.name))
    }
  }
  return dirs
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function workspacePatterns(root) {
  const pkgPath = path.join(root, 'package.json')
  if (!existsSync(pkgPath)) return ['packages/*', 'server/*']
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const raw = pkg.workspaces
  if (Array.isArray(raw)) return raw.filter((entry) => typeof entry === 'string')
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.packages)) {
    return raw.packages.filter((entry) => typeof entry === 'string')
  }
  return ['packages/*', 'server/*']
}

/**
 * @param {Map<string, string>} dirs
 * @param {string} root
 * @param {string} dir relative directory
 */
function rememberPackage(dirs, root, dir) {
  const pkgPath = path.join(root, dir, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (typeof pkg.name === 'string') dirs.set(pkg.name, dir)
  }
  const projectPath = path.join(root, dir, 'project.json')
  if (!existsSync(projectPath)) return
  const project = JSON.parse(readFileSync(projectPath, 'utf8'))
  if (typeof project.name === 'string') dirs.set(project.name, dir)
}

/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set()

/** @type {Map<string, string> | undefined} */
let packageDirs

/**
 * @param {string} project
 * @returns {string | undefined}
 */
function packageDir(project) {
  if (packageDirs === undefined) packageDirs = workspacePackageDirs()
  return packageDirs.get(project)
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let heavy = ''
  let light = ''
  let shard = ''
  let cpuText = ''
  let printPlan = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--print-plan') printPlan = true
    else if (arg === '--heavy') heavy = required(argv, (i += 1), arg)
    else if (arg === '--light') light = required(argv, (i += 1), arg)
    else if (arg === '--shard') shard = required(argv, (i += 1), arg)
    else if (arg === '--cpus') cpuText = required(argv, (i += 1), arg)
    else throw new Error(`run-test-lanes: unknown argument ${arg}`)
  }
  return { heavy, light, shard, cpuText, printPlan }
}

/**
 * @param {string[]} argv
 * @param {number} index
 * @param {string} flag
 * @returns {string}
 */
function required(argv, index, flag) {
  const value = argv[index]
  if (value === undefined) throw new Error(`run-test-lanes: missing value for ${flag}`)
  return value
}

/**
 * @param {string} value
 * @returns {string[]}
 */
function splitCsv(value) {
  return value.split(',').filter((name) => name !== '')
}

/**
 * @returns {Set<string>}
 */
function projectsWithTests() {
  const out = execFileSync('npx', ['nx', 'show', 'projects', '--with-target=test', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const parsed = JSON.parse(out)
  if (!Array.isArray(parsed))
    throw new Error('nx show projects --with-target=test did not return a list')
  return new Set(parsed.filter((name) => typeof name === 'string'))
}

/**
 * @param {readonly string[]} projects
 * @param {ReadonlySet<string>} known
 * @returns {string[]}
 */
function keepTestable(projects, known) {
  /** @type {string[]} */
  const kept = []
  for (const project of projects) {
    if (known.has(project)) kept.push(project)
    else process.stderr.write(`test-affected: ${project} has no test target — skipped\n`)
  }
  return kept
}

/**
 * @param {import('node:stream').Readable} stream
 * @param {(line: string) => void} onLine
 */
function linesOf(stream, onLine) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buf += chunk
    let nl = buf.indexOf('\n')
    while (nl !== -1) {
      onLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  })
  stream.on('end', () => {
    if (buf.length > 0) onLine(buf)
  })
}

/**
 * @param {string} project
 * @param {number} workers
 * @param {string} shard
 * @returns {Promise<{ exitCode: number, collectSeconds: number | null, testsSeconds: number | null, vitestSeconds: number | null }>}
 */
function runProject(project, workers, shard, heapMb) {
  const dir = packageDir(project)
  if (dir === undefined) {
    process.stderr.write(`${project} has no package directory — skipped\n`)
    return Promise.resolve({
      exitCode: 1,
      collectSeconds: null,
      testsSeconds: null,
      vitestSeconds: null,
    })
  }
  const args = ['run', 'test']
  if (shard !== '') args.push('--', `--shard=${shard}`)
  return new Promise((resolve) => {
    const child = spawn('npm', args, {
      cwd: path.join(ROOT, dir),
      env: {
        ...process.env,
        VITEST_MAX_WORKERS: String(workers),
        NODE_OPTIONS: nodeOptionsWithHeap(process.env.NODE_OPTIONS, heapMb),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)
    let collectSeconds = null
    let testsSeconds = null
    let vitestSeconds = null
    let settled = false
    const take = (line) => {
      process.stdout.write(`${project} ${line}\n`)
      const summary = parseVitestSummary(line)
      if (summary === null) return
      collectSeconds = summary.collectSeconds
      testsSeconds = summary.testsSeconds
      vitestSeconds = summary.durationSeconds
    }
    if (child.stdout !== null) linesOf(child.stdout, take)
    if (child.stderr !== null) linesOf(child.stderr, take)
    const finish = (exitCode) => {
      if (settled) return
      settled = true
      children.delete(child)
      resolve({ exitCode, collectSeconds, testsSeconds, vitestSeconds })
    }
    child.on('error', (error) => {
      process.stderr.write(`${project} failed to start: ${error.message}\n`)
      finish(1)
    })
    child.on('close', (code) => finish(code === null ? 1 : code))
  })
}

/**
 * @param {readonly string[]} projects
 * @param {string} lane
 * @param {number} parallel
 * @param {number} workers
 * @param {string} shard
 */
async function runLane(projects, lane, parallel, workers, shard, heapMb) {
  const pending = [...projects]
  /** @type {object[]} */
  const results = []
  const width = Math.min(parallel, projects.length)
  if (width === 0) return results
  const worker = async () => {
    for (;;) {
      const project = pending.shift()
      if (project === undefined) return
      const started = Date.now()
      const outcome = await runProject(project, workers, shard, heapMb)
      const seconds = (Date.now() - started) / 1000
      process.stdout.write(
        `lane ${lane} ${project} ${seconds.toFixed(1)}s exit ${outcome.exitCode}\n`,
      )
      results.push({ project, lane, seconds, ...outcome })
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

/**
 * Concurrent lanes start together. A serial plan (one core) finishes the heavy
 * lane before the light one starts — creating both promises up front would
 * overlap them anyway.
 *
 * @param {ReturnType<typeof lanePlan>} runnable
 * @param {string} shard
 * @returns {Promise<object[]>}
 */
async function runPlanned(runnable, shard, heapMb) {
  const heavy = () =>
    runLane(runnable.heavy, 'heavy', runnable.heavyParallel, runnable.heavyWorkers, shard, heapMb)
  const light = () =>
    runLane(runnable.light, 'light', runnable.lightParallel, runnable.lightWorkers, shard, heapMb)
  if (!runnable.concurrent) return [...(await heavy()), ...(await light())]
  const [heavyResults, lightResults] = await Promise.all([heavy(), light()])
  return [...heavyResults, ...lightResults]
}

/**
 * @param {readonly object[]} results
 */
function writeTimings(results) {
  const file = process.env.VERIFY_PROJECT_TIMING
  if (file === undefined || file === '') return
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(results))
  renameSync(tmp, file)
}

/**
 * @param {NodeJS.Signals} signal
 * @param {number} code
 */
function stop(signal, code) {
  for (const child of children) child.kill(signal)
  process.exit(code)
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const args = parseArgs(argv)
  const cpuCount = args.cpuText === '' ? cpus().length : Number(args.cpuText)
  const plan = lanePlan({
    cpus: cpuCount,
    heavy: splitCsv(args.heavy),
    light: splitCsv(args.light),
    env: process.env,
  })
  if (args.printPlan) {
    process.stdout.write(`${JSON.stringify(plan)}\n`)
    return 0
  }
  const known = projectsWithTests()
  const heavy = keepTestable(plan.heavy, known)
  const light = keepTestable(plan.light, known)
  const runnable = lanePlan({ cpus: cpuCount, heavy, light, env: process.env })
  const heapMb = laneHeapMb({ totalBytes: totalmem(), processCount: laneProcessCount(runnable) })
  process.stderr.write(
    `test-affected: local heavy ${runnable.heavyParallel}×${runnable.heavyWorkers} [${runnable.heavy.join(', ')}]; light ${runnable.lightParallel}×${runnable.lightWorkers} (${cpuCount} cores, heap ${heapMb}mb, ${runnable.concurrent ? 'together' : 'one lane then the other'})\n`,
  )
  const results = await runPlanned(runnable, args.shard, heapMb)
  writeTimings(results)
  const failed = results.find((row) => row.exitCode !== 0)
  return failed === undefined ? 0 : Number(failed.exitCode)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  process.on('SIGINT', () => stop('SIGINT', 130))
  process.on('SIGTERM', () => stop('SIGTERM', 143))
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${message}\n`)
      process.exitCode = 1
    })
}

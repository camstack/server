/**
 * npm invocation resolver — makes "is npm available?" a solved problem for
 * every installer code path that shells out to npm.
 *
 * Why this exists (Mac mini incident, silent for days until 2026-07-16): the
 * packaged Electron agent ships a BARE node binary — `Resources/node/bin/node`
 * with no npm — so every `execFileAsync('npm', ...)` died with ENOENT inside a
 * "non-fatal" catch. Addons with runtime deps installed WITHOUT their
 * node_modules, reported "running", and failed at first import
 * (`Cannot find module 'sharp'`): the detection group ran 1/3 members and the
 * node silently fell out of the balancer pool.
 *
 * Resolution order:
 *  1. system `npm` on PATH (probed once per process) — hub image, dev
 *     machines, Linux agent containers;
 *  2. a previously-bootstrapped copy under `cacheDir` — run its `npm-cli.js`
 *     with the CURRENT node binary (`process.execPath`), which always exists;
 *  3. BOOTSTRAP: fetch `<registry>/npm/latest` (the npm package is fully
 *     self-contained — its tarball bundles every dependency), download +
 *     extract into `cacheDir`, then use it as in (2).
 *
 * Failures THROW with an actionable message — a caller must never proceed as
 * if dependencies were installed when they were not.
 */
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import type { IScopedLogger } from '@camstack/types'

const execFileAsync = promisify(execFile)

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** How the caller must spawn npm: `execFile(command, [...argsPrefix, ...npmArgs])`. */
export interface NpmInvocation {
  readonly command: string
  readonly argsPrefix: readonly string[]
}

export interface ResolveNpmInvocationOptions {
  /** Directory that holds (or receives) the bootstrapped npm package. */
  readonly cacheDir: string
  /** npm registry base URL; defaults to the public registry. */
  readonly registry?: string | undefined
  readonly logger: IScopedLogger
  /** Test seams — production callers omit all of these. */
  readonly probeSystemNpm?: () => Promise<boolean>
  readonly fetchJson?: (url: string) => Promise<unknown>
  readonly downloadTarball?: (url: string, destTgz: string) => Promise<void>
  readonly extractTarball?: (tgzPath: string, destDir: string) => Promise<void>
}

/** Where the bootstrap lands inside `cacheDir` (npm tgz carries a `package/` prefix). */
function bootstrappedCliPath(cacheDir: string): string {
  return path.join(cacheDir, 'package', 'bin', 'npm-cli.js')
}

async function defaultProbeSystemNpm(): Promise<boolean> {
  try {
    await execFileAsync('npm', ['--version'], { timeout: 15_000 })
    return true
  } catch {
    return false
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  return res.json()
}

async function defaultDownloadTarball(url: string, destTgz: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} downloading ${url}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  await fs.promises.writeFile(destTgz, bytes)
}

async function defaultExtractTarball(tgzPath: string, destDir: string): Promise<void> {
  await execFileAsync('tar', ['-xzf', tgzPath, '-C', destDir], { timeout: 120_000 })
}

/** The `dist.tarball` URL out of a registry version-metadata document. */
function tarballUrlOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const dist = (metadata as Record<string, unknown>)['dist']
  if (typeof dist !== 'object' || dist === null) return null
  const tarball = (dist as Record<string, unknown>)['tarball']
  return typeof tarball === 'string' && tarball.length > 0 ? tarball : null
}

/**
 * Process-wide memo: resolution is stable for the process lifetime (npm does
 * not appear/disappear mid-run, and the bootstrap is idempotent on disk).
 */
let cachedInvocation: Promise<NpmInvocation> | null = null

/** Test-only: reset the process-wide memo. */
export function __clearNpmInvocationCacheForTests(): void {
  cachedInvocation = null
}

export async function resolveNpmInvocation(
  options: ResolveNpmInvocationOptions,
): Promise<NpmInvocation> {
  cachedInvocation ??= resolveUncached(options).catch((err: unknown) => {
    // A failed bootstrap must not poison the memo forever (transient network
    // failure) — clear it so the next install attempt retries.
    cachedInvocation = null
    throw err
  })
  return cachedInvocation
}

export interface RunNpmOptions {
  readonly cacheDir: string
  /** The environment to derive the child's from. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  readonly registry?: string | undefined
  readonly logger: IScopedLogger
  readonly cwd?: string
  readonly timeout?: number
}

/**
 * Resolve a working npm (system → bootstrapped → bootstrap) and run it with
 * `args`. The ONE entry point every installer code path uses instead of a raw
 * `execFile('npm', ...)` — so "npm missing on this host" is either solved
 * (bootstrap) or a LOUD, actionable error, never a swallowed ENOENT.
 */
/**
 * The environment the npm child gets: the caller's, plus the directory of the
 * Node we are running, FIRST on PATH.
 *
 * Why: on a packaged desktop there is no system npm and no system node — the
 * app ships one bundled Node and the process runs with a bare launchd PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`, measured on the Mac-mini agent). npm runs
 * every lifecycle script through `sh -c`, so a script spelled `node install.js`
 * — which is how `node-av`, `better-sqlite3`, `esbuild` and our own closure
 * postinstall are all spelled — dies with `sh: node: command not found`, and
 * the whole install fails at exit 127 with no native prebuilds and no patches.
 *
 * Prepending (not appending) is deliberate: the lifecycle scripts of THIS
 * closure must run on the Node that will load it, not on whatever older Node a
 * host happens to have earlier on PATH.
 *
 * Idempotent, because npm invocations nest: a directory already in front is
 * left alone rather than added again.
 */
export function buildNpmChildEnv(env: NodeJS.ProcessEnv, execPath: string): NodeJS.ProcessEnv {
  const nodeDir = path.dirname(execPath)
  const current = env['PATH']
  if (current === undefined || current.length === 0) {
    return { ...env, PATH: nodeDir }
  }
  if (current === nodeDir || current.startsWith(`${nodeDir}${path.delimiter}`)) {
    return { ...env }
  }
  return { ...env, PATH: `${nodeDir}${path.delimiter}${current}` }
}

export async function runNpm(
  args: readonly string[],
  options: RunNpmOptions,
): Promise<{ stdout: string; stderr: string }> {
  const invocation = await resolveNpmInvocation({
    cacheDir: options.cacheDir,
    registry: options.registry,
    logger: options.logger,
  })
  return execFileAsync(invocation.command, [...invocation.argsPrefix, ...args], {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    timeout: options.timeout ?? 300_000,
    // Lifecycle scripts run through `sh -c` and spell their interpreter `node`.
    // On a packaged host that name resolves to nothing unless we say so.
    env: buildNpmChildEnv(options.env ?? process.env, process.execPath),
  })
}

async function resolveUncached(options: ResolveNpmInvocationOptions): Promise<NpmInvocation> {
  const probe = options.probeSystemNpm ?? defaultProbeSystemNpm
  if (await probe()) {
    return { command: 'npm', argsPrefix: [] }
  }

  const cliPath = bootstrappedCliPath(options.cacheDir)
  if (fs.existsSync(cliPath)) {
    options.logger.info('system npm unavailable — using bootstrapped npm', {
      meta: { cliPath },
    })
    return { command: process.execPath, argsPrefix: [cliPath] }
  }

  options.logger.warn('system npm unavailable — bootstrapping npm from the registry', {
    meta: { cacheDir: options.cacheDir },
  })
  try {
    const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '')
    const fetchJson = options.fetchJson ?? defaultFetchJson
    const metadata = await fetchJson(`${registry}/npm/latest`)
    const tarballUrl = tarballUrlOf(metadata)
    if (!tarballUrl) {
      throw new Error(`registry metadata for 'npm' carries no dist.tarball (${registry})`)
    }
    await fs.promises.mkdir(options.cacheDir, { recursive: true })
    const tgzPath = path.join(options.cacheDir, 'npm-bootstrap.tgz')
    await (options.downloadTarball ?? defaultDownloadTarball)(tarballUrl, tgzPath)
    await (options.extractTarball ?? defaultExtractTarball)(tgzPath, options.cacheDir)
    await fs.promises.rm(tgzPath, { force: true })
    if (!fs.existsSync(cliPath)) {
      throw new Error(`extracted npm tarball is missing ${cliPath}`)
    }
    options.logger.info('npm bootstrapped', { meta: { cliPath } })
    return { command: process.execPath, argsPrefix: [cliPath] }
  } catch (err) {
    throw new Error(
      `no system npm on PATH and the npm bootstrap failed — cannot install addon ` +
        `dependencies on this node: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }
}

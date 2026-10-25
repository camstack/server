/**
 * Verdaccio fixture for the addon CLI-vs-npm e2e suite.
 *
 * Spawns a verdaccio process on a dedicated port with isolated YAML
 * config + storage tree under mktemp. Suites use it to publish
 * synthetic addon tarballs and exercise the hub's npm-install
 * codepath without contaminating the public registry.
 *
 * Two helpers exported:
 *
 *   - `spawnVerdaccio({port?})` → boots the daemon, waits for `/-/ping`,
 *     returns `{url, host, port, storageDir, configPath, stop()}`.
 *
 *   - `publishFixture(registry, pkgDir)` → tarballs `pkgDir` and publishes
 *     it to the registry via `npm publish` (writes a scratch `.npmrc`
 *     pointing at the registry with an anonymous auth token — verdaccio
 *     6 accepts any token under the open-policy config below).
 *
 * Why npx instead of a tracked dev-dep: verdaccio's npm tree is ~400MB,
 * bigger than the entire e2e harness. We only need it for the CLI-vs-npm
 * suite which is opt-in (`CAMSTACK_E2E_LIVE=1`), so the npx cold-install
 * cost is amortised across the suite's beforeAll instead of being paid
 * by every `npm install` on the repo.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface SpawnedVerdaccio {
  readonly proc: ChildProcess
  readonly host: string
  readonly port: number
  readonly url: string
  readonly storageDir: string
  readonly configPath: string
  /** Ring buffer of last 200 stdout/stderr lines for failure diagnostics. */
  readonly logBuf: readonly string[]
  stop(): Promise<void>
}

export interface SpawnVerdaccioOptions {
  /** TCP port to bind. Default: 4873 (verdaccio's default). */
  port?: number
  /** Boot timeout. Default: 60s — covers npx cold-install. */
  bootTimeoutMs?: number
}

const DEFAULT_PORT = 4873
const DEFAULT_BOOT_TIMEOUT_MS = 60_000
const HEALTH_POLL_INTERVAL_MS = 200
const LOG_BUF_LIMIT = 200

/**
 * Minimal verdaccio config: anonymous read+write+unpublish for all packages,
 * file-system storage under mktemp, stdout logging at warn level.
 *
 * Auth-less because every test that needs identity gets it via a per-test
 * `.npmrc` with `_authToken=anonymous`. Verdaccio 6 accepts any token under
 * an `auth: {}` block when packages declare `access: $all`.
 */
function buildConfigYaml(storageDir: string, port: number): string {
  return [
    `storage: ${storageDir}/storage`,
    `auth:`,
    `  htpasswd:`,
    `    file: ${storageDir}/htpasswd`,
    `    max_users: -1`,
    `uplinks: {}`,
    `packages:`,
    `  '**':`,
    `    access: $all`,
    `    publish: $all`,
    `    unpublish: $all`,
    `log: { type: stdout, format: pretty, level: warn }`,
    `listen: 127.0.0.1:${port}`,
    `web:`,
    `  enable: false`,
    ``,
  ].join('\n')
}

export async function spawnVerdaccio(
  options: SpawnVerdaccioOptions = {},
): Promise<SpawnedVerdaccio> {
  const port = options.port ?? DEFAULT_PORT
  const bootTimeout = options.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS

  const host = '127.0.0.1'
  const url = `http://${host}:${port}`
  const storageDir = mkdtempSync(join(tmpdir(), 'verdaccio-'))
  const configPath = join(storageDir, 'config.yaml')
  writeFileSync(configPath, buildConfigYaml(storageDir, port))
  // Verdaccio refuses to start if htpasswd file is missing on disk; the
  // file just needs to exist (max_users:-1 prevents new registrations).
  writeFileSync(join(storageDir, 'htpasswd'), '')

  // `--listen <port>` resolves to `localhost` which on macOS is IPv6 (::1);
  // we want the deterministic IPv4 bind from the YAML's `listen: 127.0.0.1:PORT`.
  // Pass the full host:port form on the CLI too to avoid drift if verdaccio
  // ever stops merging the two.
  const proc = spawn('npx', ['verdaccio', '--config', configPath, '--listen', `${host}:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  const logBuf: string[] = []
  const sink = (chunk: Buffer): void => {
    const text = chunk.toString('utf8')
    for (const line of text.split('\n')) {
      if (!line) continue
      logBuf.push(line)
      if (logBuf.length > LOG_BUF_LIMIT) logBuf.shift()
    }
  }
  proc.stdout?.on('data', sink)
  proc.stderr?.on('data', sink)

  // Race: child can die before /-/ping is ever served (e.g. EADDRINUSE).
  // Surface that as a fast failure with the captured log tail instead of
  // letting the caller time out at 60s.
  const exitPromise = new Promise<never>((_, reject) => {
    proc.once('exit', (code) => {
      reject(
        new Error(
          `verdaccio exited prematurely (code=${code}). last log lines:\n${logBuf.slice(-30).join('\n')}`,
        ),
      )
    })
  })

  const ready = await Promise.race([waitForPing(url, bootTimeout), exitPromise])
  if (!ready) {
    proc.kill('SIGTERM')
    throw new Error(
      `verdaccio did not become reachable at ${url}/-/ping within ${bootTimeout}ms. last log:\n${logBuf.slice(-30).join('\n')}`,
    )
  }

  // Detach the prematurely-exit listener — we only need it during boot.
  proc.removeAllListeners('exit')

  const stop = async (): Promise<void> => {
    if (!proc.killed) {
      proc.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, 2_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    }
    if (existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true })
    }
  }

  return { proc, host, port, url, storageDir, configPath, logBuf, stop }
}

async function waitForPing(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/-/ping`)
      if (res.status === 200) return true
    } catch {
      // not ready
    }
    await new Promise((res) => setTimeout(res, HEALTH_POLL_INTERVAL_MS))
  }
  return false
}

/**
 * Publish `pkgDir` (containing a package.json + sources) to the registry.
 *
 * Writes a scratch `.npmrc` next to the package so the publish doesn't
 * touch the developer's global config. Uses `--ignore-scripts` to avoid
 * accidentally triggering install hooks from fixture packages during
 * tarball assembly.
 */
export async function publishFixture(registry: SpawnedVerdaccio, pkgDir: string): Promise<void> {
  const npmrcPath = join(pkgDir, '.npmrc')
  writeFileSync(
    npmrcPath,
    [
      `registry=${registry.url}/`,
      `//${registry.host}:${registry.port}/:_authToken=anonymous`,
      `//${registry.host}:${registry.port}/:always-auth=true`,
    ].join('\n'),
  )

  try {
    execFileSync('npm', ['publish', '--registry', `${registry.url}/`, '--ignore-scripts'], {
      cwd: pkgDir,
      env: { ...process.env, npm_config_userconfig: npmrcPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    const stdout = err && typeof err === 'object' && 'stdout' in err ? String(err.stdout) : ''
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : ''
    throw new Error(`npm publish from ${pkgDir} failed.\nstdout:\n${stdout}\nstderr:\n${stderr}`, {
      cause: err,
    })
  }
}

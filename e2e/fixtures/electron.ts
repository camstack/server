/**
 * Electron / hub spawn fixture for E2E tests.
 *
 * Spawns the camstack hub as a child process with isolated CAMSTACK_DATA
 * so suites never collide with the operator's running cluster. Two modes:
 *
 *   - `spawnHub({ mode: 'server' })`   — runs `npm run serve -w server/backend`
 *     directly (faster boot, no Electron window). Default for headless suites.
 *
 *   - `spawnHub({ mode: 'electron' })` — runs the full Electron bundle. Use
 *     when you need to assert against the Electron-specific surface
 *     (auto-update, tray, packaged-addon paths).
 *
 * Boot is gated on the hub's `/health` endpoint — same probe surface
 * health.routes.ts ships. Self-signed cert is tolerated because the dev
 * cluster ships one in `assets/`; the fixture creates an HTTPS agent that
 * accepts unauthorized peers.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import * as https from 'node:https'
import * as fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestDataDir, type TestDataDir } from './test-data-dir.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const REPO_ROOT = path.resolve(__dirname, '..', '..')

export interface SpawnedHub {
  readonly proc: ChildProcess
  readonly dataDir: string
  readonly port: number
  readonly mode: HubSpawnMode
  /** Ring buffer of stdout lines (last 500). */
  readonly stdoutBuf: readonly string[]
  /** Ring buffer of stderr lines (last 500). */
  readonly stderrBuf: readonly string[]
  stop(): Promise<void>
}

export type HubSpawnMode = 'server' | 'electron'

export interface SpawnHubOptions {
  /** TCP port for the hub. Default: 4443. */
  port?: number
  /** Spawn mode. Default: 'server'. */
  mode?: HubSpawnMode
  /** Override the temp data dir. Default: mktemp. */
  dataDir?: string
  /** Boot timeout in ms. Default: 90_000. */
  bootTimeoutMs?: number
  /** Extra env vars layered on top of process.env. */
  env?: Record<string, string>
}

const DEFAULT_BOOT_TIMEOUT_MS = 90_000
const HEALTH_POLL_INTERVAL_MS = 500

const insecureHttpsAgent = new https.Agent({ rejectUnauthorized: false })

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await probeOnce(url)
      if (ok) return true
    } catch {
      // not ready yet
    }
    await new Promise((res) => setTimeout(res, HEALTH_POLL_INTERVAL_MS))
  }
  return false
}

function probeOnce(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = https.request(url, { agent: insecureHttpsAgent, method: 'GET' }, (res) => {
      // Drain to free the socket
      res.resume()
      resolve((res.statusCode ?? 500) < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

function pushBounded(buf: string[], line: string, limit = 500): void {
  buf.push(line)
  if (buf.length > limit) buf.splice(0, buf.length - limit)
}

export async function spawnHub(opts: SpawnHubOptions = {}): Promise<SpawnedHub> {
  const port = opts.port ?? 4443
  const mode: HubSpawnMode = opts.mode ?? 'server'
  const bootTimeout = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  const ownDataDir: TestDataDir | null = opts.dataDir ? null : createTestDataDir()
  const dataDir = opts.dataDir ?? ownDataDir!.path

  // Resolve repo paths up-front so failure messages point at the right file.
  if (!fs.existsSync(path.join(REPO_ROOT, 'package.json'))) {
    throw new Error(`[spawnHub] Repo root not found at ${REPO_ROOT}`)
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CAMSTACK_DATA: dataDir,
    NODE_ENV: 'test',
    // `CAMSTACK_PORT` is the boot-config-mapped env var the server
    // actually reads (boot-config.ts:43 maps it to `server.port`).
    // `PORT`/`HTTPS_PORT` are legacy fallbacks — kept so older suites
    // that set them keep working, but adding CAMSTACK_PORT is what
    // matters when a developer's dev:full hub holds the default 4443.
    CAMSTACK_PORT: String(port),
    PORT: String(port),
    HTTPS_PORT: String(port),
    // No admin credentials in env (D797): a fresh hub seeds admin / changeme.
    ...opts.env,
  }

  const cmd = 'npm'
  // Use `serve:once` (plain tsx, no watch) so the test hub doesn't
  // restart itself when an addon's dist files churn during install/
  // uninstall. The `serve` (watch) variant covers a developer's local
  // CAMSTACK_DATA via --ignore, but the e2e mktemp dir lives outside
  // that pattern → addon uninstall files trip a hub reboot mid-test.
  const args =
    mode === 'electron'
      ? ['run', 'dev', '-w', '@camstack/desktop']
      : ['run', 'serve:once', '-w', 'server/backend']

  const proc = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  })

  const stdoutBuf: string[] = []
  const stderrBuf: string[] = []

  proc.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (line) pushBounded(stdoutBuf, line)
    }
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf-8').split('\n')) {
      if (line) pushBounded(stderrBuf, line)
    }
  })

  let exited = false
  proc.on('exit', () => {
    exited = true
  })

  const healthUrl = `https://localhost:${port}/health`
  const ok = await waitForHealth(healthUrl, bootTimeout)
  if (!ok) {
    proc.kill('SIGTERM')
    if (ownDataDir) ownDataDir.cleanup()
    const stderrTail = stderrBuf.slice(-30).join('\n')
    const stdoutTail = stdoutBuf.slice(-60).join('\n')
    throw new Error(
      `[spawnHub] Hub did not respond at ${healthUrl} within ${bootTimeout}ms.\n` +
        `--- stderr tail ---\n${stderrTail}\n` +
        `--- stdout tail ---\n${stdoutTail}`,
    )
  }

  return {
    proc,
    dataDir,
    port,
    mode,
    stdoutBuf,
    stderrBuf,
    async stop() {
      if (exited) {
        if (ownDataDir) ownDataDir.cleanup()
        return
      }
      proc.kill('SIGTERM')
      // Give shutdown hooks ~3s; SIGKILL fallback otherwise.
      const killed = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 3000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve(true)
        })
      })
      if (!killed) {
        proc.kill('SIGKILL')
        await new Promise((res) => setTimeout(res, 1000))
      }
      if (ownDataDir) ownDataDir.cleanup()
    },
  }
}

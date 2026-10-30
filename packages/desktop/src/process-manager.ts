/**
 * Spawns the CamStack node (hub OR agent) as a child process and forwards
 * lifecycle (kill on app quit, restart on crash, log capture).
 *
 * Runtime-updatable node packages, phase 3: the shell spawns the shared
 * STARTER (`@camstack/server/dist/starter.js`), NOT `launcher.js` directly. The
 * starter resolves the active `@camstack/server` root from the user data dir
 * (`<userData>/data/server-root/...`) and falls back to the baked SEED closure
 * (Resources) on first boot / offline. The `CAMSTACK_ROLE` env the shell passes
 * selects hub vs agent inside the launcher. Node + framework updates then land
 * in the data dir and NEVER touch the signed .app bundle.
 *
 * Resolution (the starter lives INSIDE the baked closure so its `__dirname`
 * anchors the seed package dir):
 *   - Production (`app.isPackaged`):
 *       `${resourcesPath}/node_modules/@camstack/server/dist/starter.js`
 *   - Dev: `<workspace>/server/backend/dist/starter.js` (the starter detects
 *     the workspace checkout and defers to plain launcher resolution).
 */

import { KEYCHAIN_KEY_FD, KEYCHAIN_KEY_FD_ARG } from './keychain-platform-key'
import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ChildSpec {
  readonly entryPath: string
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly nodeArgs?: readonly string[]
  readonly scriptArgs?: readonly string[]
  /**
   * Absolute path to a bundled **real Node** binary to run the node under (and,
   * transitively, every addon runner it forks via `process.execPath`).
   *
   * When set + present, the child is spawned with THIS binary and WITHOUT
   * `ELECTRON_RUN_AS_NODE`. This is required on macOS: the packaged app's
   * Electron binary has the V8 pointer-compression sandbox enabled, under which
   * native external `Napi::Buffer` over mmap is rejected ("External buffers are
   * not allowed") — so shared-memory / native frame handling cannot run under
   * `ELECTRON_RUN_AS_NODE`. Plain Node has no such sandbox.
   *
   * `null`/absent (dev, or a build without a staged node) → fall back to
   * `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (the legacy behaviour).
   */
  readonly nodeExecPath?: string | null
  /**
   * The hub keychain's master key from the OS keychain (D788), handed to the
   * child on an inherited pipe — fd {@link KEYCHAIN_KEY_FD}, announced by
   * `--keychain-key-fd=3` — and the pipe closed. Never an env var.
   */
  readonly keychainKey?: Buffer | null
}

export interface SpawnedChild {
  readonly process: ChildProcess
  readonly startedAt: number
}

interface ResolveEntryOptions {
  readonly resourcesPath: string | null
  readonly devWorkspaceRoot: string | null
}

function existsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function existsDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the baked SEED server package dir (the immutable first-boot/offline
 * fallback closure) inside the packaged app's Resources:
 * `${resourcesPath}/node_modules/@camstack/server`. This dir holds the starter,
 * `dist/launcher.js`, its `package.json`, and — as npm siblings under
 * `${resourcesPath}/node_modules/@camstack/*` — the host-external framework
 * packages the seed launcher resolves. Passed to the starter as
 * `CAMSTACK_SEED_SERVER_DIR`. Returns null in dev (no packaged Resources).
 */
export function resolveSeedServerDir(resourcesPath: string | null): string | null {
  if (!resourcesPath) return null
  const seedDir = path.join(resourcesPath, 'node_modules', '@camstack', 'server')
  return existsDir(seedDir) ? seedDir : null
}

/**
 * Resolve the dir the packaged app seeds addons from: the `@camstack` SCOPE dir
 * of the baked closure, `${resourcesPath}/node_modules/@camstack`. Exported to
 * the node as `CAMSTACK_BUNDLED_ADDONS_DIR`. Returns null in dev / a build
 * without the closure — the launcher then falls back to npm.
 *
 * ── Why the closure scope dir and not a second `Resources/addons` tree ──────
 * The app used to ship BOTH: `extraResources` copied `.deps/node_modules` whole
 * into `Resources/node_modules`, then re-copied six addons + `@camstack/system`
 * one by one into `Resources/addons/<short-name>`. Measured 2026-08-25 on the
 * mac-arm64 bundle: 285 MB of `@camstack` packages plus 41 MB of seven of those
 * SAME packages again — a second copy of everything the seed reads (D45).
 *
 * An npm scope dir is laid out exactly the way the second tree was hand-built:
 * `AddonInstaller.findLocalPackage('@camstack/addon-pipeline')` strips the scope
 * and joins `<dir>/addon-pipeline`, which is `node_modules/@camstack/addon-pipeline`
 * verbatim. So the seed source is a rename, not a rewrite — and it fixes a live
 * defect: electron-builder DROPPED each package's own `node_modules` on the
 * per-addon `extraResources` entries, so the prebuilt natives `stage-deps.mjs`
 * plants (and loudly verifies) never reached `Resources/addons/*`. Measured on
 * the same bundle: zero `.node` files under `Resources/addons`, all of them
 * under `Resources/node_modules/@camstack`. `copyBundledNativeModules` and
 * `ensureAddonNativePrebuilds({ bundledSourceDir })` were both no-ops against
 * the shipped seed tree; against the closure they are not.
 */
export function resolveBundledAddonsDir(resourcesPath: string | null): string | null {
  if (!resourcesPath) return null
  const scopeDir = path.join(resourcesPath, 'node_modules', '@camstack')
  return existsDir(scopeDir) ? scopeDir : null
}

export function resolveNodeEntry(opts: ResolveEntryOptions): string | null {
  const candidates: string[] = []
  if (opts.resourcesPath) {
    // The starter lives INSIDE the full baked closure so its `__dirname`
    // (`.../@camstack/server/dist`) anchors the seed package dir + npm-sibling
    // framework resolution.
    candidates.push(
      path.join(opts.resourcesPath, 'node_modules', '@camstack', 'server', 'dist', 'starter.js'),
    )
  }
  if (opts.devWorkspaceRoot) {
    candidates.push(path.join(opts.devWorkspaceRoot, 'server', 'backend', 'dist', 'starter.js'))
  }
  for (const c of candidates) {
    if (existsFile(c)) return c
  }
  return null
}

/**
 * Resolve the bundled real-Node binary staged into the packaged app's
 * `Contents/Resources/node/bin/node` — `node/node.exe` on Windows (see `scripts/stage-deps.mjs` + the
 * `extraResources` mapping). Returns the path when present, else `null`
 * (dev builds, or a build without a staged node → caller falls back to
 * Electron-as-Node). See {@link ChildSpec.nodeExecPath} for why this matters.
 */
export function resolveBundledNode(
  resourcesPath: string | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!resourcesPath) return null
  const candidate = path.join(resourcesPath, 'node', ...bundledNodeSegments(platform))
  return existsFile(candidate) ? candidate : null
}

/**
 * Where the staged runtime keeps its executable: the layout of Node's own
 * archives — `bin/node` on POSIX, `node.exe` at the root on Windows (no
 * `bin/`). `scripts/node-bundle.mjs` stages to exactly this.
 */
export function bundledNodeSegments(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? ['node.exe'] : ['bin', 'node']
}

export class NodeProcessManager {
  private current: SpawnedChild | null = null
  private intentionalShutdown = false
  private readonly listeners = new Set<(line: string, stream: 'stdout' | 'stderr') => void>()
  private readonly exitListeners = new Set<
    (code: number | null, signal: NodeJS.Signals | null, wasIntentional: boolean) => void
  >()

  get isRunning(): boolean {
    return this.current !== null && this.current.process.exitCode === null
  }

  onLog(fn: (line: string, stream: 'stdout' | 'stderr') => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  onExit(
    fn: (code: number | null, signal: NodeJS.Signals | null, wasIntentional: boolean) => void,
  ): () => void {
    this.exitListeners.add(fn)
    return () => this.exitListeners.delete(fn)
  }

  start(spec: ChildSpec): SpawnedChild {
    if (this.current) void this.stop()
    if (!existsFile(spec.entryPath)) {
      throw new Error(`Node entry not found: ${spec.entryPath}`)
    }
    this.intentionalShutdown = false
    const keychainKey = spec.keychainKey ?? null
    const args = [
      ...(spec.nodeArgs ?? []),
      spec.entryPath,
      ...(spec.scriptArgs ?? []),
      ...(keychainKey !== null ? [KEYCHAIN_KEY_FD_ARG] : []),
    ]
    // Prefer a bundled REAL Node binary when one was staged (packaged macOS
    // builds). Running the node — and every addon runner it forks via
    // `process.execPath` — under plain Node avoids Electron's V8 sandbox, which
    // rejects native external mmap Buffers ("External buffers are not allowed")
    // and would break the native frame plane. See ChildSpec.nodeExecPath.
    const bundledNode =
      spec.nodeExecPath != null && existsFile(spec.nodeExecPath) ? spec.nodeExecPath : null
    const useBundledNode = bundledNode != null
    const execBin = bundledNode ?? process.execPath
    // Legacy fallback: with the Electron binary, ELECTRON_RUN_AS_NODE=1 makes it
    // run as Node instead of spawning a second BrowserWindow. Real Node needs no
    // such flag (and must NOT inherit it — it would be a stray env var).
    const runAsNodeEnv: Record<string, string> = useBundledNode ? {} : { ELECTRON_RUN_AS_NODE: '1' }
    const proc = spawn(execBin, args, {
      cwd: spec.cwd,
      env: { ...runAsNodeEnv, ...process.env, ...spec.env },
      stdio: keychainKey !== null ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    })
    if (keychainKey !== null) {
      const keyPipe = proc.stdio[KEYCHAIN_KEY_FD]
      if (keyPipe !== null && keyPipe !== undefined && 'end' in keyPipe) {
        keyPipe.end(`${keychainKey.toString('base64')}\n`)
      }
    }

    proc.stdout?.setEncoding('utf-8')
    proc.stderr?.setEncoding('utf-8')
    proc.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue
        for (const fn of this.listeners) fn(line, 'stdout')
      }
    })
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length === 0) continue
        for (const fn of this.listeners) fn(line, 'stderr')
      }
    })
    proc.on('exit', (code, signal) => {
      const wasIntentional = this.intentionalShutdown
      this.intentionalShutdown = false
      this.current = null
      for (const fn of this.exitListeners) fn(code, signal, wasIntentional)
      if (!wasIntentional) {
        for (const fn of this.listeners) {
          fn(
            `[child] node exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
            'stderr',
          )
        }
      }
    })

    this.current = { process: proc, startedAt: Date.now() }
    return this.current
  }

  /** SIGKILL a child that stopped serving; it exits unintentionally, so the exit handler relaunches it. */
  forceKill(): void {
    try {
      this.current?.process.kill('SIGKILL')
    } catch {
      /* may already be dead */
    }
  }

  private note(line: string): void {
    for (const fn of this.listeners) fn(line, 'stderr')
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    const child = this.current
    if (!child) return
    this.intentionalShutdown = true
    this.note(`[child] stop requested by the shell (SIGTERM, SIGKILL after ${timeoutMs}ms)`)
    if (child.process.exitCode !== null) {
      this.current = null
      return
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.note(`[child] did not exit within ${timeoutMs}ms of SIGTERM; SIGKILL`)
        try {
          child.process.kill('SIGKILL')
        } catch {
          /* may already be dead */
        }
        resolve()
      }, timeoutMs)
      child.process.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.process.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}

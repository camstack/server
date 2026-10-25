/**
 * Minimal pty abstraction. The manager depends on this interface, never on
 * `node-pty` directly, so its tests spawn no real process and the native
 * module is imported lazily (only when a real session opens on the host).
 *
 * `child_process.spawn` is deliberately NOT used: a plain pipe is NOT-A-TTY, so
 * a full-screen program (`btm`) gets no terminal and no runtime resize channel.
 * See docs/design/2026-07-26-terminal-session-design.md ("The pty").
 */
import { accessSync, chmodSync, existsSync, constants as fsConstants, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, delimiter as pathDelimiter, join as pathJoin } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Resolve `file` to an executable path the way a shell would: a path-qualified
 * name is checked directly, a bare name is searched on `PATH`. Returns the
 * resolved absolute path, or `null` when nothing executable matches — the
 * caller turns that into a clear "binary not found" error BEFORE spawning,
 * instead of a pty that dies at 127 and vanishes with no visible cause.
 */
export function resolveExecutable(file: string): string | null {
  if (file.includes('/')) return isExecutableFile(file) ? file : null
  const dirs = (process.env.PATH ?? '').split(pathDelimiter).filter((d) => d.length > 0)
  for (const dir of dirs) {
    const candidate = pathJoin(dir, file)
    if (isExecutableFile(candidate)) return candidate
  }
  return null
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export interface PtyProcess {
  readonly pid: number
  onData(cb: (data: string) => void): void
  onExit(cb: (event: PtyExit) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtyExit {
  readonly exitCode: number
  readonly signal?: number
}

export interface PtySpawnOptions {
  readonly file: string
  readonly args: readonly string[]
  readonly cols: number
  readonly rows: number
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
}

/** Injectable so the manager is testable without a real pty. */
export type PtySpawner = (options: PtySpawnOptions) => PtyProcess

interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name: string
      cols: number
      rows: number
      cwd?: string
      env?: Record<string, string>
    },
  ): NodePtyInstance
}

interface NodePtyInstance {
  readonly pid: number
  onData(cb: (data: string) => void): unknown
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

let cachedModule: NodePtyModule | null = null

function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return
  const packageRoot = dirname(require.resolve('node-pty/package.json'))
  const candidates = [
    pathJoin(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    pathJoin(packageRoot, 'build', 'Release', 'spawn-helper'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const mode = statSync(candidate).mode & 0o777
    if ((mode & 0o111) === 0) {
      chmodSync(candidate, mode | ((mode & 0o444) >> 2))
    }
  }
}

async function loadNodePty(): Promise<NodePtyModule> {
  if (cachedModule) return cachedModule
  ensureSpawnHelperExecutable()
  const mod = (await import('node-pty')) as NodePtyModule
  cachedModule = mod
  return mod
}

/**
 * The real spawner. Loads `node-pty` on first use and adapts its `IPty` to our
 * `PtyProcess`. Because `import()` is async and `PtySpawner` is sync, the module
 * is warmed once at addon boot via `warmNodePty()`; a session that opens before
 * that resolves is rejected upstream rather than blocking here.
 */
export function createNodePtySpawner(): PtySpawner {
  return (options: PtySpawnOptions): PtyProcess => {
    if (!cachedModule) {
      throw new Error('node-pty not loaded yet — call warmNodePty() at addon boot')
    }
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    const term = cachedModule.spawn(options.file, options.args, {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: { ...inheritedEnv, ...options.env },
    })
    return {
      pid: term.pid,
      onData: (cb) => {
        term.onData(cb)
      },
      onExit: (cb) => {
        term.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal }))
      },
      write: (data) => term.write(data),
      resize: (cols, rows) => term.resize(cols, rows),
      kill: () => term.kill(),
    }
  }
}

/** Pre-load `node-pty` so the sync spawner can run without blocking. */
export async function warmNodePty(): Promise<void> {
  await loadNodePty()
}

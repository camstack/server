/**
 * Files only their owner may read: the one place a secret-bearing file is
 * restricted, on every OS.
 *
 * `mode: 0o600` is a POSIX idea. On Windows Node maps it to the read-only
 * attribute and nothing else, and `chmod` is a no-op for permissions, so a
 * "0600" `agent.json` (the mesh private key) would have
 * been readable by every local user. Windows has its own tool for this:
 * `icacls`. This module removes the inherited ACL entries and grants access to
 * the current user and SYSTEM only — the Windows reading of "0600".
 *
 * ZERO imports beyond Node built-ins, on purpose: the Electron shell bundles
 * this single file (see `packages/desktop/tsup.config.ts`) instead of the
 * whole `@camstack/types` barrel.
 *
 * Failure is NOT swallowed. A secret file that could not be restricted is a
 * secret file the caller must know about, so `OwnerOnlyError` propagates; the
 * write order below makes sure nothing sensitive is in the file yet when that
 * happens (the temp file is empty until it has been restricted).
 *
 * Out of scope on purpose: files that are only tidy, not secret (the job
 * journal, the addon manifest) keep a plain `mode`, since one `icacls` per
 * write would be a process spawn on a hot path.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import { userInfo } from 'node:os'
import * as path from 'node:path'

/** `*S-1-5-18` is SYSTEM in every locale — a name like "SYSTEM" is not. */
const WINDOWS_SYSTEM_SID = '*S-1-5-18'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

export class OwnerOnlyError extends Error {
  constructor(
    readonly target: string,
    detail: string,
  ) {
    super(`could not restrict ${target} to its owner: ${detail}`)
    this.name = 'OwnerOnlyError'
  }
}

/** Everything the Windows branch touches, injectable so a Mac can test it. */
export interface OwnerOnlyDeps {
  readonly platform: NodeJS.Platform
  readonly exec: (file: string, args: readonly string[]) => void
  /** `DOMAIN\\user` or `user` — the principal that keeps access. */
  readonly principal: () => string
  readonly systemRoot: string | undefined
}

function currentPrincipal(): string {
  const user = process.env['USERNAME'] ?? userInfo().username
  const domain = process.env['USERDOMAIN']
  return domain !== undefined && domain.length > 0 ? `${domain}\\${user}` : user
}

/** Resolved per call, not at import: a platform stubbed by a test must be seen. */
function resolveDeps(overrides: Partial<OwnerOnlyDeps>): OwnerOnlyDeps {
  return {
    platform: process.platform,
    exec: (file, args) => {
      execFileSync(file, [...args], { stdio: 'pipe', windowsHide: true })
    },
    principal: currentPrincipal,
    systemRoot: process.env['SystemRoot'],
    ...overrides,
  }
}

/** The icacls argv for one path: no inheritance, owner + SYSTEM only. */
export function icaclsArgs(
  target: string,
  principal: string,
  isDirectory: boolean,
): readonly string[] {
  // (OI)(CI) makes a directory's grant flow to what is created inside it.
  const inherit = isDirectory ? '(OI)(CI)' : ''
  return [
    target,
    '/inheritance:r',
    '/grant:r',
    `${principal}:${inherit}F`,
    '/grant:r',
    `${WINDOWS_SYSTEM_SID}:${inherit}F`,
  ]
}

function restrictWindows(target: string, isDirectory: boolean, deps: OwnerOnlyDeps): void {
  const icacls = path.win32.join(deps.systemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe')
  try {
    deps.exec(icacls, icaclsArgs(target, deps.principal(), isDirectory))
  } catch (err) {
    throw new OwnerOnlyError(target, err instanceof Error ? err.message : String(err))
  }
}

/** Restrict an existing file to its owner (chmod 0600 / owner+SYSTEM ACL). */
export function restrictFileToOwnerSync(
  target: string,
  overrides: Partial<OwnerOnlyDeps> = {},
): void {
  const deps = resolveDeps(overrides)
  if (deps.platform === 'win32') {
    restrictWindows(target, false, deps)
    return
  }
  fs.chmodSync(target, FILE_MODE)
}

/** Restrict an existing directory to its owner (chmod 0700 / owner+SYSTEM, inherited). */
export function restrictDirToOwnerSync(
  target: string,
  overrides: Partial<OwnerOnlyDeps> = {},
): void {
  const deps = resolveDeps(overrides)
  if (deps.platform === 'win32') {
    restrictWindows(target, true, deps)
    return
  }
  fs.chmodSync(target, DIR_MODE)
}

/** Create `dir` (and parents) readable by its owner only. */
export function mkdirOwnerOnlySync(dir: string, overrides: Partial<OwnerOnlyDeps> = {}): void {
  const deps = resolveDeps(overrides)
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })
  if (deps.platform === 'win32') {
    restrictWindows(dir, true, deps)
    return
  }
  fs.chmodSync(dir, DIR_MODE)
}

/**
 * Atomically write a secret-bearing file that only its owner can read.
 *
 * Order matters: the temp file is created EMPTY, restricted, and only then
 * given its content, so there is no moment at which the secret exists under a
 * permissive ACL. The rename carries the (already restricted) ACL with it.
 */
export function writeOwnerOnlyFileSync(
  target: string,
  data: string | Uint8Array,
  overrides: Partial<OwnerOnlyDeps> = {},
): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp.${process.pid}`
  fs.writeFileSync(tmp, '', { mode: FILE_MODE })
  try {
    restrictFileToOwnerSync(tmp, overrides)
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, target)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}

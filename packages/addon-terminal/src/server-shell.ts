/**
 * The server shell: one login shell on a node, a new trust level past the
 * allowlisted monitor profiles. The opt-in is read only by {@link serverShellOptIn}.
 * The child environment is an allowlist — the process environment is never copied
 * (D783, D797).
 */
import { existsSync } from 'node:fs'

export const SERVER_SHELL_PROFILE_ID = 'server-shell'

export const SERVER_SHELL_DISABLED = 'server-shell-disabled' as const

/** Names copied into the child. Anything else in the process environment stays out. */
export const SERVER_SHELL_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TERM', 'USER'] as const

export const SERVER_SHELL_IDLE_DEFAULT_MINUTES = 30

const IDLE_MIN_MINUTES = 1
const IDLE_MAX_MINUTES = 24 * 60
const DEFAULT_TERM = 'xterm-256color'

export interface ServerShellSpawn {
  readonly file: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export interface ServerShellStatus {
  readonly nodeId: string
  readonly enabled: boolean
  readonly idleMinutes: number
  readonly refusal: ServerShellRefusal | null
}

export interface ServerShellRefusal {
  readonly code: typeof SERVER_SHELL_DISABLED
  readonly nodeId: string
  readonly message: string
}

export class ServerShellRefusedError extends Error {
  readonly code = SERVER_SHELL_DISABLED
  readonly nodeId: string

  constructor(nodeId: string) {
    super(serverShellRefusal(nodeId).message)
    this.name = 'ServerShellRefusedError'
    this.nodeId = nodeId
  }
}

/** The only interpretation of the per-node opt-in. Missing or non-true is off. */
export function serverShellOptIn(value: unknown): boolean {
  return value === true
}

export function serverShellIdleMs(minutes: unknown): number {
  const parsed =
    typeof minutes === 'number' && Number.isFinite(minutes)
      ? Math.floor(minutes)
      : SERVER_SHELL_IDLE_DEFAULT_MINUTES
  const clamped = Math.min(IDLE_MAX_MINUTES, Math.max(IDLE_MIN_MINUTES, parsed))
  return clamped * 60_000
}

export function serverShellRefusal(nodeId: string): ServerShellRefusal {
  return {
    code: SERVER_SHELL_DISABLED,
    nodeId,
    message: `Server shell is off on node ${nodeId}. Turn it on in that node's Terminal settings.`,
  }
}

export function loginShellBinary(input: {
  readonly platform: string
  readonly inContainer: boolean
  readonly shellFromEnv: string | undefined
}): string {
  if (input.inContainer) return '/bin/bash'
  const fromEnv = input.shellFromEnv?.trim() ?? ''
  if (input.platform === 'darwin') return fromEnv.length > 0 ? fromEnv : '/bin/zsh'
  return fromEnv.length > 0 ? fromEnv : '/bin/bash'
}

/** Allowlisted child environment. `TERM` falls back to a fixed value, never to another variable. */
export function allowlistedShellEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SERVER_SHELL_ENV_ALLOWLIST) {
    const value = processEnv[key]
    if (typeof value === 'string' && value.length > 0) env[key] = value
  }
  if (env['TERM'] === undefined) env['TERM'] = DEFAULT_TERM
  return env
}

export function resolveServerShell(input: {
  readonly platform: string
  readonly inContainer: boolean
  readonly shellFromEnv: string | undefined
  readonly dataDir: string
  readonly processEnv: Readonly<Record<string, string | undefined>>
}): ServerShellSpawn {
  return {
    file: loginShellBinary(input),
    args: ['-l'],
    cwd: input.dataDir,
    env: allowlistedShellEnv(input.processEnv),
  }
}

export function hostLooksLikeContainer(exists: (path: string) => boolean = existsSync): boolean {
  return exists('/.dockerenv') || exists('/run/.containerenv')
}

export function sessionIdleDue(lastIoAt: number, now: number, idleMs: number): boolean {
  return now - lastIoAt >= idleMs
}

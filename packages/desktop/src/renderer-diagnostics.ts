/**
 * Pure helpers for renderer diagnostics + child-respawn policy.
 *
 * Deliberately free of any `electron` import so the logic is unit-testable
 * under plain vitest — `main.ts` wires these into `webContents` events and
 * the agent-process exit handler.
 */

/** Subset of Electron's `Input` relevant to the DevTools shortcut. */
export interface DevToolsKeyInput {
  readonly type: string
  readonly key: string
  readonly alt: boolean
  readonly meta: boolean
  readonly control: boolean
}

/**
 * DevTools toggle shortcut: Cmd+Alt+I (macOS) / Ctrl+Alt+I (Win/Linux) / F12.
 * Needed because the production app has no application menu with the
 * "Toggle Developer Tools" role — without this the packaged agent UI cannot
 * be inspected at all when it renders blank.
 */
export function shouldToggleDevTools(input: DevToolsKeyInput): boolean {
  if (input.type !== 'keyDown') return false
  if (input.key === 'F12') return true
  return (input.meta || input.control) && input.alt && input.key.toLowerCase() === 'i'
}

/**
 * One renderer event → one log line: `[renderer:<kind>] k=v k=v`.
 * Newlines are flattened so multi-line messages (stack traces) cannot break
 * line-oriented log consumers.
 */
export function formatRendererEvent(
  kind: string,
  fields: Readonly<Record<string, unknown>>,
): string {
  const parts = Object.entries(fields).map(
    ([key, value]) => `${key}=${String(value).replaceAll('\n', '\\n')}`,
  )
  return `[renderer:${kind}] ${parts.join(' ')}`
}

/** Respawn backoff state — consecutive fast crashes of the node child. */
export interface RespawnState {
  readonly consecutiveCrashes: number
}

/** A child that stayed up at least this long resets the crash counter. */
const RESPAWN_STABLE_UPTIME_MS = 60_000
const RESPAWN_BASE_DELAY_MS = 1_000
const RESPAWN_MAX_DELAY_MS = 30_000

export interface RespawnDecision {
  readonly state: RespawnState
  readonly delayMs: number
}

/**
 * Exponential-backoff respawn policy for the agent child process.
 *
 * The previous behaviour respawned instantly and unconditionally — a child
 * that dies during boot (e.g. a native module the hardened bundled Node
 * refuses to dlopen) produced a tight crash-loop with the local HTTP UI
 * flapping up/down. Backoff keeps the node self-healing while making the
 * failure observable instead of a thrash.
 */
export function computeRespawn(prev: RespawnState, uptimeMs: number): RespawnDecision {
  const consecutiveCrashes = uptimeMs >= RESPAWN_STABLE_UPTIME_MS ? 1 : prev.consecutiveCrashes + 1
  const delayMs = Math.min(
    RESPAWN_MAX_DELAY_MS,
    RESPAWN_BASE_DELAY_MS * 2 ** (consecutiveCrashes - 1),
  )
  return { state: { consecutiveCrashes }, delayMs }
}

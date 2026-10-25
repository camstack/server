/**
 * Pure supervisor logic for the Electron shell — runtime-updatable node
 * packages, phase 3.
 *
 * The Electron main process is the node's always-relaunching SUPERVISOR (the
 * Mac equivalent of the docker restart policy). When the in-app update service
 * applies an update/rollback, the node child gracefully self-exits and this
 * shell must relaunch it — WITHOUT the crash-backoff penalty, because that exit
 * was intentional. A real crash must still back off.
 *
 * The child cannot signal the shell over IPC (business traffic never uses raw
 * process messages, and the update path is a hub↔node tRPC call the shell is
 * not part of). Instead the node drops a restart-intent MARKER file in its
 * data dir (`@camstack/node-root` owns the layout) moments before the exit;
 * the shell reads + consumes it here to classify the exit.
 *
 * The data-dir layout constants are imported DIRECTLY from `@camstack/node-root`
 * — it is bundled INTO this shell's dist at build time (a devDependency, tsc
 * inlines the values), so there is one source of truth and no anti-drift test
 * is needed. Deliberately free of any `electron`/`fs` import so the
 * classification and the status summary are unit-testable under plain vitest —
 * `main.ts` supplies the marker read + version lookups and wires the result
 * into the spawn loop and the tray.
 */
import type { NodeRole } from './types'

/**
 * A marker older than this is treated as STALE and ignored — it was most
 * likely orphaned by a hard app-quit between the marker write and the
 * relaunch, and must not mis-classify a much-later crash as an update restart.
 * Comfortably larger than the node's restart grace + relaunch latency.
 */
export const RESTART_INTENT_MAX_AGE_MS = 120_000

/** A restart-intent marker as written by the node's update service. */
export interface RestartIntentMarker {
  readonly requestedAtMs: number
  readonly reason: string
}

/** How this node-child exit is classified for the respawn policy. */
export type NodeExitClass =
  | { readonly kind: 'parent-intentional' }
  | { readonly kind: 'update-restart' }
  | { readonly kind: 'crash' }

export interface NodeExitInput {
  /** The shell itself asked the child to stop (app quit / config change). */
  readonly wasParentIntentional: boolean
  /** The restart-intent marker read from the data dir (null when absent). */
  readonly restartIntent: RestartIntentMarker | null
  readonly nowMs: number
}

/**
 * Classify a node-child exit:
 *   - `parent-intentional` — the shell called stop(); the caller decides
 *     whether/when to relaunch (never auto-respawns, never backs off).
 *   - `update-restart` — a FRESH restart-intent marker was present: the child
 *     self-exited to apply an update/rollback. Relaunch promptly, no backoff.
 *   - `crash` — anything else: relaunch with crash backoff.
 */
export function classifyNodeExit(input: NodeExitInput): NodeExitClass {
  if (input.wasParentIntentional) return { kind: 'parent-intentional' }
  const intent = input.restartIntent
  if (intent !== null) {
    const ageMs = input.nowMs - intent.requestedAtMs
    if (ageMs >= 0 && ageMs <= RESTART_INTENT_MAX_AGE_MS) {
      return { kind: 'update-restart' }
    }
  }
  return { kind: 'crash' }
}

// -- Root-package status summary (tray surface) ----------------------------

/**
 * The subset of `@camstack/node-root`'s `ServerRootState` the shell surfaces.
 * Read structurally from `<dataDir>/server-root/state.json`; only these fields
 * are needed for a concise status line, so the shell does not depend on the
 * full node-root type.
 */
export interface NodeRootStateView {
  readonly currentVersion: string | null
  readonly pendingVersion: string | null
  readonly rolledBack: boolean
}

/** Human label for a role, used in the tray status line. */
export function roleLabel(role: NodeRole): string {
  if (role === 'agent') return 'Agent'
  if (role === 'viewer') return 'Viewer'
  return 'Hub'
}

/**
 * A concise, honest one-line status of the node's ROOT package for the tray.
 * The shell does not run the starter (the child does), so it cannot know the
 * exact active version env marker — it reports what the durable state file
 * shows, which is enough to see "updating", "rolled back", or the confirmed
 * version. Falls back to the seed when nothing is installed in the data dir.
 */
export function summarizeNodeRootStatus(state: NodeRootStateView | null, role: NodeRole): string {
  const label = roleLabel(role)
  if (state === null) return `${label}: seed (no installed version)`
  if (state.pendingVersion !== null) return `${label}: applying update v${state.pendingVersion}…`
  if (state.rolledBack) {
    return state.currentVersion !== null
      ? `${label}: v${state.currentVersion} (rolled back — update failed)`
      : `${label}: seed (rolled back — update failed)`
  }
  if (state.currentVersion !== null) return `${label}: v${state.currentVersion}`
  return `${label}: seed`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Structural, dependency-free parse of a server-root `state.json` payload into
 * the tray view. Returns null when the payload is missing/corrupt (the shell
 * then shows the seed label). Kept pure so it is unit-testable; `main.ts`
 * supplies the already-parsed JSON.
 */
export function toNodeRootStateView(raw: unknown): NodeRootStateView | null {
  if (!isRecord(raw)) return null
  const currentVersion = typeof raw['currentVersion'] === 'string' ? raw['currentVersion'] : null
  const pending = raw['pendingBoot']
  let pendingVersion: string | null = null
  if (isRecord(pending) && typeof pending['version'] === 'string') {
    pendingVersion = pending['version']
  }
  const rolledBack = raw['rolledBack'] !== null && raw['rolledBack'] !== undefined
  return { currentVersion, pendingVersion, rolledBack }
}

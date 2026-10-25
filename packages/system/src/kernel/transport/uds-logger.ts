import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import { redactLogMeta, redactLogText } from '../../logging/log-redactor.js'
import type { ChildLogMessage } from './child-cap-protocol.js'

// ─── Buffering decision ──────────────────────────────────────────────────────
//
// `LocalChildClient.sendLog` ALREADY buffers log entries emitted before
// `start()` resolves (queued in `pendingEmits`) and flushes them in emission
// order when the UDS channel opens. Introducing a second 500-cap FIFO here
// would create two independent queues, potentially reordering or double-counting
// entries and adding unnecessary complexity. This file therefore delegates
// ALL pre-connect buffering to the client — `createUdsLogger` is a thin
// `IScopedLogger → sendLog` adapter that always calls `client.sendLog`
// unconditionally. The client is the single owner of the pre-connect queue.
//
// Ref: `LocalChildClient.pendingEmits` + `flushPending` in
//       packages/kernel/src/transport/local-child-client.ts

/**
 * Minimal interface this module requires from the transport client.
 *
 * `LocalChildClient` satisfies this structurally. Using a minimal named
 * interface keeps `uds-logger.ts` decoupled from the full `LocalChildClient`
 * class and allows tests to pass a plain fake object without casts.
 *
 * `isConnected` is intentionally omitted — the logger never reads it; all
 * pre-connect buffering is handled by the client implementation.
 */
export interface UdsLogSink {
  /**
   * Fire-and-forget: send a structured log entry to the parent.
   * Safe to call before `start()` — entries are buffered and flushed on connect.
   */
  readonly sendLog: (entry: Omit<ChildLogMessage, 'kind'>) => void
}

/**
 * Mutable log-level control shared across every `IScopedLogger` built by a
 * single `createUdsLogger` family (the root plus its `child`/`withTags`
 * descendants). Replaces the broker logger's per-appender level: the parent's
 * `$node-mgmt.setLogLevel` equivalent over UDS (`onSetLogLevel`) calls
 * `setLevel`, and entries below the threshold are dropped before `sendLog`
 * (the parent's LoggingService also filters at query time — this just trims
 * transport traffic, matching the broker `**: childLogLevel` appender gate).
 */
export interface UdsLogLevelControl {
  setLevel(level: string): void
}

/** debug < info < warn < error. Unknown strings map to `debug` (most permissive). */
const LEVEL_ORDER: Readonly<Record<string, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

function levelRank(level: string): number {
  return LEVEL_ORDER[level] ?? 0
}

/**
 * Create a UDS-backed `IScopedLogger` for a forked child process.
 *
 * Every log call builds an `Omit<ChildLogMessage,'kind'>` entry and forwards
 * it to `client.sendLog`. Pre-connect buffering is entirely delegated to the
 * client (see rationale above) — this function never holds its own FIFO.
 *
 * Scope composition mirrors `createRemoteLogger`:
 * - `child(x)` REPLACES the current scope (scope is a single flat label, not
 *   a hierarchy — identical to the broker-based remote logger convention).
 * - `withTags(extra)` merges tags into the baseline; per-call `extras.tags`
 *   are merged on top at emit time.
 *
 * baseTags parity with `createRemoteLogger`:
 * - `addonId`   — stable addon identifier.
 * - `nodeId`    — Moleculer node ID of the child process (e.g. `'hub/addon-x'`).
 * - `agentId`   — agent-slot prefix derived from nodeId (e.g. `'hub'`); used
 *                 by the admin-UI renderer for agent-slot grouping.
 * - `pid`       — OS pid of the child process; renders in the <pid> column.
 * - `...tags`   — caller-supplied baseline overrides (applied last).
 *
 * @param client   Transport sink (structurally matches `LocalChildClient`).
 * @param addonId  Stable addon identifier included in every log entry.
 * @param nodeId   Moleculer node ID of this child (e.g. `'hub/addon-stream-broker'`).
 * @param scope    Optional sub-component label (e.g. `'process-runner'`).
 * @param tags     Baseline tags merged into every entry.
 */
/**
 * Internal mutable level holder shared by a logger family. Default `'debug'`
 * (forward everything) preserves the prior behaviour for callers that don't
 * pass a control object.
 */
interface LevelState {
  current: string
}

function createUdsLoggerWithState(
  client: UdsLogSink,
  addonId: string,
  nodeId: string,
  levelState: LevelState,
  scope?: string,
  tags: LogTags = {},
): IScopedLogger {
  // Forked-worker nodeIds are `parent/worker-suffix`; the agent slot is the
  // top-level parent (`hub` for children of the backend, `dev-agent-0` for
  // full remote agents). Mirrors remote-logger agentId derivation exactly.
  const agentId = nodeId.includes('/') ? nodeId.split('/')[0]! : nodeId
  // pid — the forked worker's own OS pid, so log lines emitted by a subprocess
  // render with the subprocess pid (not the hub renderer pid).
  const baseTags: LogTags = { addonId, nodeId, agentId, pid: process.pid, ...tags }

  function log(level: ChildLogMessage['level'], message: string, extras?: LogExtras): void {
    // Drop entries below the configured threshold before sending — mirrors the
    // broker logger's `**: <level>` appender gate. The shared `levelState` lets
    // `onSetLogLevel` retune every descendant logger at once.
    if (levelRank(level) < levelRank(levelState.current)) return
    const mergedTags: LogTags = extras?.tags ? { ...baseTags, ...extras.tags } : baseTags
    // Redacted HERE, in the process that resolved its own secrets: the
    // parent's redactor cannot know a value only this runner holds (D787).
    const entry: Omit<ChildLogMessage, 'kind'> = {
      level,
      message: redactLogText(message),
      addonId,
      nodeId,
      ...(scope !== undefined ? { scope } : {}),
      tags: mergedTags,
      ...(extras?.meta !== undefined ? { meta: redactLogMeta(extras.meta) } : {}),
    }
    client.sendLog(entry)
  }

  const logger: IScopedLogger = {
    debug: (msg, extras) => log('debug', msg, extras),
    info: (msg, extras) => log('info', msg, extras),
    warn: (msg, extras) => log('warn', msg, extras),
    error: (msg, extras) => log('error', msg, extras),
    // `child(x)` REPLACES scope — not appended. Mirrors remote-logger convention.
    // Descendants share the SAME `levelState` so a single `setLevel` retunes all.
    child: (childScope) =>
      createUdsLoggerWithState(client, addonId, nodeId, levelState, childScope, baseTags),
    // `withTags` merges extra tags into the baseline; scope is preserved.
    withTags: (extra) =>
      createUdsLoggerWithState(client, addonId, nodeId, levelState, scope, {
        ...baseTags,
        ...extra,
      }),
  }
  return logger
}

function createUdsLogger(
  client: UdsLogSink,
  addonId: string,
  nodeId: string,
  scope?: string,
  tags: LogTags = {},
): IScopedLogger {
  // No external control — each call owns a private `'debug'` (forward-all)
  // level state, preserving the pre-F behaviour.
  return createUdsLoggerWithState(client, addonId, nodeId, { current: 'debug' }, scope, tags)
}

/**
 * Like {@link createUdsLogger} but also returns a {@link UdsLogLevelControl}.
 * The control's `setLevel` retunes the threshold for this logger AND every
 * `child`/`withTags` descendant (they share the level state). Used by the
 * `addon-runner` self-logger so the parent's UDS `set-log-level` message can
 * raise/lower the child's outbound log verbosity.
 */
function createUdsLoggerWithControl(
  client: UdsLogSink,
  addonId: string,
  nodeId: string,
  scope?: string,
  tags: LogTags = {},
): { logger: IScopedLogger; control: UdsLogLevelControl } {
  const levelState: LevelState = { current: 'debug' }
  const logger = createUdsLoggerWithState(client, addonId, nodeId, levelState, scope, tags)
  const control: UdsLogLevelControl = {
    setLevel(level: string): void {
      levelState.current = level
    },
  }
  return { logger, control }
}

export { createUdsLogger, createUdsLoggerWithControl }

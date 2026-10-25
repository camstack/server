import type {
  LogReadCapabilities,
  LogReadQuery,
  LogReadResult,
} from '../capabilities/log-destination.cap.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Severity ordering. Declared once here because it had already been re-declared
 * three times independently (`kernel/transport/uds-logger.ts`,
 * `builtins/loki-logging/loki-destination.ts`, and the log buffer) — four copies
 * of the same four numbers is four chances for one of them to disagree.
 *
 * `uds-logger` keeps its own copy on purpose: it ranks a plain `string` coming off
 * the wire and needs a tolerant fallback for an unknown value, which this typed
 * map deliberately does not offer.
 */
export const LOG_LEVEL_RANK: Readonly<Record<LogLevel, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

/** True when `level` is no more severe than `threshold` — i.e. prunable/filterable. */
export function logLevelAtMost(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_RANK[level] <= LOG_LEVEL_RANK[threshold]
}

/**
 * Structured tags for log entries.
 * Used to filter logs across addons for a specific device, integration, etc.
 */
export interface LogTags {
  /** Top-level cluster agent ID (e.g., 'hub', 'dev-agent-0'). Always the root node, never a child process. */
  readonly agentId?: string
  /** Moleculer node ID (e.g., 'hub', 'hub/decoder-nodeav', 'agent-1') */
  readonly nodeId?: string
  /**
   * OS process PID that actually emitted the entry. Hub services emit the
   * hub PID; forked Moleculer workers emit their own PID. The formatter
   * renders this in the `<pid>` column so operators can distinguish
   * hub-local addons from in-hub forked workers at a glance. Falls back
   * to the cached `process.pid` of the renderer when absent.
   */
  readonly pid?: number
  /**
   * Device ID (numeric progressive id, e.g. 2). Always `number` —
   * string deviceIds are a pre-migration artifact and should not be
   * logged: if you have a stableId (external-only identifier), use
   * `meta.stableId` instead. The post-migration rule is: deviceId
   * everywhere internal is the numeric id allocated by the hub's
   * device-manager.
   */
  readonly deviceId?: number
  /** Human-readable device name (e.g., 'Hall') */
  readonly deviceName?: string
  /** Integration ID (e.g., 'int_0001') */
  readonly integrationId?: string
  /** Addon ID (e.g., 'stream-broker', 'webrtc-adaptive') */
  readonly addonId?: string
  /** Stream ID (e.g., '2/main') */
  readonly streamId?: string
  /** Human-readable stream name — `main` / `mid` / `low` or a custom label. */
  readonly streamName?: string
  /**
   * Session identifier when a log entry belongs to a particular session —
   * decoder session id, webrtc session id, rtsp session id, etc. Useful
   * to cross-reference entries emitted from different addons for the
   * same session. Intentionally untyped as a free-form string so
   * emitting code can reuse whatever handle the addon already has.
   */
  readonly sessionId?: string
  /**
   * The per-component log CHANNEL this line was emitted on (e.g.
   * `stream-broker.webrtc`). Set by {@link LogChannelGate.log} and by nothing
   * else, so `| json | logChannel="stream-broker.webrtc"` selects exactly the
   * lines an armed channel produced — without matching on message text, which
   * is what makes a channel readable a day later.
   *
   * Deliberately NOT `channel`: that tag is already taken and means something
   * else entirely — the NVR sub-channel index a Reolink hub camera sits on
   * (`accessories/siren.ts`, `accessories/floodlight.ts`), and it is a NUMBER.
   * One tag key meaning both `2` and `stream-broker.rtp` would make every
   * LogQL selector over it ambiguous, which is the same "two things under one
   * name" defect this mechanism exists to remove.
   */
  readonly logChannel?: string
  /** Arbitrary extra tags */
  readonly [key: string]: string | number | undefined
}

export interface LogEntry {
  /**
   * `<bootId>.<seq>`, minted by the LogManager that FIRST accepted the line
   * on this process (D898). Identical in the in-memory tail, the live
   * subscription and the rotated file, so a page read from disk and a line
   * pushed live dedupe exactly. Absent only on an entry built by hand.
   */
  id?: string
  timestamp: Date
  level: LogLevel
  /** Single free-form label (e.g. 'EventPersistence', 'rtsp', 'AddonRegistry').
   *  The addon/agent identity lives in `tags.addonId` / `tags.agentId`; `scope`
   *  is only for the sub-component label that appears before the message. */
  scope?: string
  message: string
  meta?: Record<string, unknown>
  /** Structured tags for cross-cutting log filtering */
  tags?: LogTags
}

export interface LogFilter {
  level?: LogLevel
  since?: Date
  until?: Date
  limit?: number
  /** Filter by tags — all specified tags must match (AND logic) */
  tags?: Partial<LogTags>
}

export interface ILogDestination {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  write(entry: LogEntry): void
  /** Absent ⇒ this destination only ships lines (D898). */
  describeRead?(): Promise<LogReadCapabilities>
  read?(query: LogReadQuery): Promise<LogReadResult>
  cancelRead?(input: { readonly requestId: string }): Promise<{ readonly cancelled: boolean }>
}

/**
 * Inline, per-call extras passed to every `IScopedLogger` method.
 *
 * - `tags`: cross-cutting structured identifiers — device, integration,
 *   stream — merged with any baseline tags already bound on the logger
 *   via `withTags()`. Renderable in fixed columns; queryable.
 * - `meta`: free-form operational context — error objects, counts,
 *   urls. Shown inline at the end of the log line as `{k=v}`.
 *
 * Pattern:
 *   logger.info('Probe failed', { tags: { deviceId: 7 }, meta: { err } })
 *   logger.warn('Retry scheduled', { meta: { attempt: 2 } })
 *   logger.info('Addon initialized')  // no extras
 *
 * `withTags()` survives only for binding a long-lived child logger
 * (e.g. `this.deviceLogger = ctx.logger.withTags({ deviceId })` in a
 * device constructor). Per-call tags always go in `extras.tags`.
 */
export interface LogExtras {
  readonly tags?: LogTags
  readonly meta?: Record<string, unknown>
}

export interface IScopedLogger {
  debug(message: string, extras?: LogExtras): void
  info(message: string, extras?: LogExtras): void
  warn(message: string, extras?: LogExtras): void
  error(message: string, extras?: LogExtras): void
  /** Create a new logger whose entries carry `scope = childScope`.
   *  Replaces (does not append to) any existing scope — scope is a
   *  single label, hierarchy is not modelled. Addon/agent identity
   *  lives in `tags.addonId`/`tags.agentId`, not in scope. */
  child(childScope: string): IScopedLogger
  /** Create a new logger with additional tags (merged with existing tags) */
  withTags(tags: LogTags): IScopedLogger
}

/** Factory that creates scoped loggers */
export type LoggerFactory = {
  createLogger(scope?: string): IScopedLogger
}

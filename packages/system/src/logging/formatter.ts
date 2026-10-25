/**
 * Canonical single-line formatter for every `LogEntry` that reaches a
 * console transport — hub-side `WinstonDestination` +
 * `ConsoleDestination`, agent-side `HubForwarderDestination`. One
 * definition so the three paths can't drift.
 *
 * Layout mirrors NestJS `ConsoleLogger` output:
 *
 *   [Nest] 54994  - 04/20/2026, 12:45:53 AM     LOG [InstanceLoader] TrpcModule dependencies initialized +0ms
 *
 * Mapping for camstack — cluster-aware:
 *   - `[Nest]` (brand bracket)   → `[<agent>/<addonId>]` so operators see
 *                                   at a glance which node emitted the line
 *                                   (matches the cluster topology)
 *   - `54994` (pid)              → `process.pid`
 *   - `<timestamp>`              → `M/D/YYYY, H:MM:SS AM`
 *   - `LOG` / `WARN` / `ERROR`   → `entry.level` upper-cased, colour per level
 *   - `[InstanceLoader]` (ctx)   → `[<device>]` — shown only when a device
 *                                   tag is present; omitted otherwise
 *   - `<message>`                → `entry.message`
 *   - trailing `+Nms`            → we don't compute timing yet; omitted
 *
 * Rendered examples:
 *   [hub/winston-logging]        71184  - 04/20/2026, 12:45:53 AM     INFO  Winston logging initialized
 *   [hub/provider-rtsp]          71184  - 04/20/2026, 12:46:01 AM     WARN  [hall] probe failed {err="timeout"}
 *   [dev-agent-0/detection]      12345  - 04/20/2026, 12:47:15 AM     ERROR [cortile] no detector {codec=av1}
 */
import type { LogEntry, LogTags } from '@camstack/types'

// Emit ANSI colour codes when the runtime supports them. Heuristic
// follows npm ecosystem convention so log-consumers can override:
//   - `NO_COLOR` env present → OFF (https://no-color.org/)
//   - `FORCE_COLOR=0` → OFF
//   - `FORCE_COLOR` truthy (1/2/3/true) → ON  (forces even when piped)
//   - stdout.isTTY → ON
//   - else → OFF
// Rationale: running via `concurrently` / `npm run dev` often pipes
// stdout and strips `isTTY`, making colours disappear. Dev sets
// `FORCE_COLOR=1` in the shell to opt back in; CI / file-piping
// pipelines set `NO_COLOR=1` to strip.
//
// Destinations that always render for console (ConsoleDestination,
// HubForwarderDestination) pass `colorize: true` explicitly — still
// gated by NO_COLOR. File sinks (Winston JSON) pass `colorize: false`
// so log files stay plain text regardless of the shell environment.
const USE_COLOR = (() => {
  try {
    if (typeof process === 'undefined') return false
    const env = process.env ?? {}
    if (env['NO_COLOR']) return false
    const force = env['FORCE_COLOR']
    if (force !== undefined) return force !== '' && force !== '0' && force !== 'false'
    return Boolean((process.stdout as { isTTY?: boolean })?.isTTY)
  } catch {
    return false
  }
})()

/** True when `NO_COLOR` is set — destinations that force colour on still honour this. */
const NO_COLOR = (() => {
  try {
    return Boolean(process?.env?.['NO_COLOR'])
  } catch {
    return false
  }
})()

const RESET = '\x1b[0m'
const ANSI = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const

const COLOR_BY_LEVEL: Readonly<Record<string, string>> = {
  debug: ANSI.gray,
  info: ANSI.green,
  warn: ANSI.yellow,
  error: ANSI.red,
}

function paint(color: string, text: string, enabled: boolean): string {
  return enabled ? `${color}${text}${RESET}` : text
}

function colorizeLevel(level: string, text: string, enabled: boolean): string {
  if (!enabled) return text
  const code = COLOR_BY_LEVEL[level]
  return code ? `${code}${text}${RESET}` : text
}

/** Right-pad `value` to exactly `width` characters. */
function padRight(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width)
  return value + ' '.repeat(width - value.length)
}

/** Derive the agent — the top-level cluster node, never the forked-worker suffix. */
function resolveAgent(tags: LogTags | undefined): string | null {
  const agentId = tags?.agentId
  if (typeof agentId === 'string' && agentId.length > 0) return agentId
  const nodeId = tags?.nodeId
  if (typeof nodeId === 'string' && nodeId.length > 0) {
    return nodeId.includes('/') ? nodeId.split('/')[0]! : nodeId
  }
  return null
}

/** Derive the addon — `tags.addonId` first; `system` when the tag is missing
 *  (scope is no longer a fallback — it's a sub-component label, not identity). */
function resolveAddon(entry: Pick<LogEntry, 'tags'>): string {
  const addonId = entry.tags?.addonId
  if (typeof addonId === 'string' && addonId.length > 0) return addonId
  return 'system'
}

/** Device name (or `#id` fallback) — used inside the context bracket when present. */
function resolveDevice(tags: LogTags | undefined): string | null {
  const name = tags?.deviceName
  if (typeof name === 'string' && name.length > 0) return name
  const id = tags?.deviceId
  if (typeof id === 'number' && Number.isFinite(id)) return `#${id}`
  return null
}

/**
 * Build the brand bracket content — `<agent>/<addonId>`. Agent is
 * always shown (even `hub`) so operators never have to guess which
 * node emitted a line. Falls back to `?/<addon>` when tags don't
 * carry an agent id (pre-boot logs, test harnesses).
 */
function buildBrand(entry: Pick<LogEntry, 'tags'>): string {
  const agent = resolveAgent(entry.tags) ?? '?'
  const addon = resolveAddon(entry)
  return `${agent}/${addon}`
}

/**
 * Build the optional device-context bracket. Returns `null` when the
 * line doesn't carry a device tag — renders as just the brand + message
 * without the second bracket. With a device tag: `hall` / `#42`.
 */
function buildDeviceContext(entry: Pick<LogEntry, 'tags'>): string | null {
  return resolveDevice(entry.tags)
}

/**
 * NestJS-style locale timestamp: `M/D/YYYY, H:MM:SS AM`. Built with
 * `toLocaleString('en-US')` to match the default NestJS format that
 * operators are used to from Nest boot output.
 */
function formatTimestamp(value: unknown): string {
  const date =
    value instanceof Date ? value : new Date(typeof value === 'string' ? value : Date.now())
  return date.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
}

/** Compact `{key=value key="with space"}` rendering of an arbitrary object. Empty → ''. */
function formatMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) return ''
  const keys = Object.keys(meta)
  if (keys.length === 0) return ''
  const parts: string[] = []
  for (const key of keys) {
    const value = meta[key]
    parts.push(`${key}=${formatMetaValue(value)}`)
  }
  return `{${parts.join(' ')}}`
}

function formatMetaValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') {
    return /\s|"/.test(value) ? JSON.stringify(value) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Error) return JSON.stringify(value.message)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Cached renderer PID — fallback when the entry doesn't carry its own `tags.pid`. */
const PID =
  typeof process !== 'undefined' && typeof process.pid === 'number' ? String(process.pid) : '?'

/** Options for `formatLogLine`. */
export interface FormatLogLineOptions {
  /**
   * Emit ANSI colour codes. When omitted, falls back to the shell-env
   * heuristic (`NO_COLOR`/`FORCE_COLOR`/`isTTY`). Destinations that
   * always target a console (ConsoleDestination, HubForwarderDestination)
   * pass `true`; file sinks (Winston JSON) pass `false` so logs on disk
   * stay plain text regardless of the shell env.
   *
   * `NO_COLOR=1` in the environment still wins — consumer opt-in beats
   * producer opt-in, matching the https://no-color.org/ convention.
   */
  readonly colorize?: boolean
}

/**
 * Render a `LogEntry` as one complete console line — no trailing newline.
 * Caller appends `\n` (file sinks) or relies on `console.log` (stdout sink).
 *
 * PID column prefers `entry.tags.pid` when set (so forked-worker entries
 * carry the worker's OS pid even when the hub renders them), falling back
 * to the renderer's own `process.pid`.
 *
 * Colours (when enabled) follow the NestJS convention: the level token
 * AND the message body share the level colour (green/yellow/red/gray for
 * info/warn/error/debug). Brand, device context, scope and meta keep
 * their fixed hues so the structural fields stay visually distinct from
 * the message content.
 */
export function formatLogLine(entry: LogEntry, options?: FormatLogLineOptions): string {
  const wantsColor = options?.colorize ?? USE_COLOR
  const colorize = wantsColor && !NO_COLOR
  const levelColor = COLOR_BY_LEVEL[entry.level]

  const brand = paint(ANSI.green, `[${buildBrand(entry)}]`, colorize)
  const entryPid = entry.tags?.pid
  const pid = typeof entryPid === 'number' ? String(entryPid) : PID
  const timestamp = formatTimestamp(entry.timestamp)
  // Right-pad level to 5 chars (matches NestJS) so the context/message
  // column aligns across different levels without fixed-width hacks
  // on the surrounding fields.
  const level = colorizeLevel(entry.level, padRight(entry.level.toUpperCase(), 5), colorize)
  const device = buildDeviceContext(entry)
  const ctxPart = device ? ' ' + paint(ANSI.yellow, `[${device}]`, colorize) : ''
  const scope = typeof entry.scope === 'string' && entry.scope.length > 0 ? entry.scope : null
  const scopePart = scope ? ' ' + paint(ANSI.cyan, `(${scope})`, colorize) : ''
  const metaText = formatMeta(entry.meta)
  const metaPart = metaText ? ' ' + paint(ANSI.gray, metaText, colorize) : ''
  // NestJS layout: `[<agent>/<addon>] <pid>  - <timestamp>     <LEVEL> [<device>] (<scope>) <message>`
  // Message body is tinted by level colour so `error`/`warn` stand out at a glance.
  const message = colorize && levelColor ? `${levelColor}${entry.message}${RESET}` : entry.message
  return `${brand} ${pid}  - ${timestamp}     ${level}${ctxPart}${scopePart} ${message}${metaPart}`
}

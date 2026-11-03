/**
 * `client_logs`: the viewer app's own log lines, as the hub ingested them
 * (`/addon/stream-broker/clientlog/`). Hubs from this release tag every line
 * `source: viewer` plus `user`, `platform`, `appVersion`, `clientSessionId`
 * (user from the hub's auth, the rest from the app's batch), so the read is a
 * tag filter. An older hub tagged nothing: when the tag filter finds nothing
 * and no identity filter was asked for, the same window is read through the
 * old way (stream-broker lines whose text starts `[app:`) and `match` says so.
 *
 * The viewer level and scope live in the message (`[app:<level>:<scope>] …`):
 * the hub logs viewer `debug` at `info`, so level and scope are filtered here.
 * A read that failed is `lines: null` with a reason, never an empty list.
 */
import type { HubClient } from '@camstack/develop'
import type { McpContext } from './context.js'
import { parseSince } from './debug-logs.js'
import { withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'
import { FETCH_LIMIT, makeTierQuery, type LogEntry } from './ops-logs.js'
import { adminRefusal } from './setup-assist-common.js'

export const VIEWER_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type ViewerLevel = (typeof VIEWER_LEVELS)[number]

export const CLIENT_LOG_DEFAULT_MINUTES = 30
export const CLIENT_LOG_MAX_MINUTES = 24 * 60
export const CLIENT_LOG_LINE_LIMIT = 200

export interface ClientLogsArgs {
  readonly since?: string
  readonly deviceId?: number
  /** The viewer's scope (`live`, `playback`, `scrub`…), exact. */
  readonly scope?: string
  /** The viewer's level floor. */
  readonly level?: ViewerLevel
  readonly user?: string
  readonly platform?: string
  readonly appVersion?: string
  readonly sessionId?: string
  readonly limit?: number
}

export interface ClientLogLine {
  readonly at: string
  readonly level: ViewerLevel | null
  readonly scope: string | null
  readonly message: string
  readonly deviceId: string | null
  readonly user: string | null
  readonly platform: string | null
  readonly appVersion: string | null
  readonly sessionId: string | null
}

export interface ClientLogsResult {
  readonly status: 'ok'
  readonly window: { readonly sinceMs: number; readonly untilMs: number }
  /** `tag`: the hub tags viewer lines. `text-legacy`: an older hub, found by the `[app:` prefix. */
  readonly match: 'tag' | 'text-legacy' | 'none'
  readonly tier: string | null
  /** `null` with `unavailable`: the read failed — not "the viewer logged nothing". */
  readonly lines: readonly ClientLogLine[] | null
  readonly total: number | null
  readonly truncated: number
  readonly byLevel: { readonly [level: string]: number }
  readonly bySession: { readonly [sessionId: string]: number }
  readonly unavailable: { readonly [part: string]: string }
}

const VIEWER_PREFIX = /^\[app:(debug|info|warn|error):([^\]]*)\]\s?/

const rank = (l: ViewerLevel): number => VIEWER_LEVELS.indexOf(l)

export function parseViewerLine(entry: LogEntry): ClientLogLine {
  const m = VIEWER_PREFIX.exec(entry.message)
  const lvl = m?.[1]
  const level = VIEWER_LEVELS.find((l) => l === lvl) ?? null
  const tags = entry.tags ?? {}
  return {
    at: entry.timestamp,
    level,
    scope: m?.[2] ?? null,
    message: m ? entry.message.slice(m[0].length) : entry.message,
    deviceId: tags['deviceId'] ?? null,
    user: tags['user'] ?? null,
    platform: tags['platform'] ?? null,
    appVersion: tags['appVersion'] ?? null,
    sessionId: tags['clientSessionId'] ?? null,
  }
}

const identityTags = (args: ClientLogsArgs): { [tag: string]: string } => ({
  ...(args.user ? { user: args.user } : {}),
  ...(args.platform ? { platform: args.platform } : {}),
  ...(args.appVersion ? { appVersion: args.appVersion } : {}),
  ...(args.sessionId ? { clientSessionId: args.sessionId } : {}),
})

export function filterViewerLines(
  lines: readonly ClientLogLine[],
  args: Pick<ClientLogsArgs, 'scope' | 'level'>,
): ClientLogLine[] {
  return lines
    .filter((l) => (args.scope ? l.scope === args.scope : true))
    .filter((l) => (args.level ? l.level !== null && rank(l.level) >= rank(args.level) : true))
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** The viewer's lines in a window, newest cut at the line cap. Never throws. */
export async function readViewerLines(
  client: HubClient,
  args: ClientLogsArgs,
  window: { readonly sinceMs: number; readonly untilMs: number },
): Promise<Omit<ClientLogsResult, 'status' | 'window'>> {
  const tried: string[] = []
  const unavailable: { [part: string]: string } = {}
  const query = makeTierQuery(client, tried, unavailable)
  const device: { [tag: string]: string } =
    args.deviceId !== undefined ? { deviceId: String(args.deviceId) } : {}
  const base = {
    since: window.sinceMs,
    until: window.untilMs,
    args: args.deviceId !== undefined ? { deviceId: args.deviceId } : {},
    limit: FETCH_LIMIT,
  }
  let match: ClientLogsResult['match'] = 'tag'
  let answered = await query({
    ...base,
    tags: { source: 'viewer', ...device, ...identityTags(args) },
  })
  const wantsIdentity = Object.keys(identityTags(args)).length > 0
  if (answered !== null && answered.page.entries.length === 0 && !wantsIdentity) {
    const legacy = await query({
      ...base,
      tags: { addonId: 'stream-broker', ...device },
      text: '[app:',
    })
    if (legacy !== null && legacy.page.entries.length > 0) {
      answered = legacy
      match = 'text-legacy'
    }
  }
  if (answered === null) {
    return {
      match: 'none',
      tier: null,
      lines: null,
      total: null,
      truncated: 0,
      byLevel: {},
      bySession: {},
      unavailable,
    }
  }
  // A hub that ignores an unknown tag filter answers with untagged lines: the
  // match is `tag` only when the lines really carry the viewer tag.
  if (match === 'tag' && !answered.page.entries.some((e) => e.tags?.['source'] === 'viewer')) {
    match = 'text-legacy'
  }
  const parsed = answered.page.entries
    .filter((e) => VIEWER_PREFIX.test(e.message))
    .map(parseViewerLine)
  const kept = filterViewerLines(parsed, args)
  const limit = Math.min(args.limit ?? CLIENT_LOG_LINE_LIMIT, CLIENT_LOG_LINE_LIMIT)
  const shown = kept.slice(-limit)
  const byLevel: { [level: string]: number } = {}
  const bySession: { [id: string]: number } = {}
  for (const l of kept) {
    byLevel[l.level ?? 'unknown'] = (byLevel[l.level ?? 'unknown'] ?? 0) + 1
    if (l.sessionId) bySession[l.sessionId] = (bySession[l.sessionId] ?? 0) + 1
  }
  return {
    match,
    tier: answered.tier,
    lines: shown,
    total: kept.length,
    truncated: kept.length - shown.length,
    byLevel,
    bySession,
    unavailable,
  }
}

export async function clientLogs(
  ctx: McpContext,
  args: ClientLogsArgs,
  now: number = Date.now(),
): Promise<ClientLogsResult | NoSessionResult | RefusedResult> {
  return withHub(ctx, async (connection): Promise<ClientLogsResult | RefusedResult> => {
    const refused = adminRefusal(connection, 'client_logs (logs.query)')
    if (refused) return refused
    const sinceMs = parseSince(args.since, now, CLIENT_LOG_DEFAULT_MINUTES)
    if (sinceMs === null) {
      return {
        status: 'refused',
        reason: `since "${String(args.since)}" is not 30m, 2h, 1d or an ISO time`,
      }
    }
    const window = {
      sinceMs: Math.max(sinceMs, now - CLIENT_LOG_MAX_MINUTES * 60_000),
      untilMs: now,
    }
    return { status: 'ok', window, ...(await readViewerLines(connection.client, args, window)) }
  })
}

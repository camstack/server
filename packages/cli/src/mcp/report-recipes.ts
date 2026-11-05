/**
 * The log recipe of `report_issue`, per kind of issue: which sources are read
 * (the hub's own lines of named addons, the viewer app's lines of a scope, the
 * `debug_report` bundle of a device) and with which filters. A recipe is data,
 * so a spec can assert it selects the right sources; `collectLogs` runs it.
 *
 * Every section is bounded: `LINES_PER_SECTION` lines, each cut at
 * `LINE_MAX_CHARS`, the hub's repeats folded into one line with a count. A read
 * that fails is a section that says so, never an empty one (D393).
 */
import type { HubClient } from '@camstack/develop'
import type { McpContext } from './context.js'
import { readViewerLines, VIEWER_LEVELS } from './client-logs.js'
import { debugReport, type DebugIssue } from './debug-report.js'
import { groupEntries } from './ops-logs.js'
import { toolLines, type ReportTool } from './report-tool-sections.js'
import { makeTierQuery, FETCH_LIMIT, type LogEntry, type LogLevel } from './ops-logs.js'

export const REPORT_KINDS = [
  'streams',
  'media-thumbnails',
  'ui',
  'notifications',
  'remote-access',
  'pipeline-detection',
  'recording-storage',
  'integration',
  'other',
] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export const LINES_PER_SECTION = 20
export const LINE_MAX_CHARS = 240

export type ViewerLevel = (typeof VIEWER_LEVELS)[number]

export interface HubLogSource {
  readonly type: 'hub'
  readonly title: string
  /** The `addonId` tag of each source read; the lines are merged. */
  readonly addonIds: readonly string[]
  readonly level: LogLevel
  /** A substring the hub filters on (the grep). */
  readonly text?: string
  /** Narrow to the device when one was named. */
  readonly perDevice: boolean
}

export interface ViewerLogSource {
  readonly type: 'viewer'
  readonly title: string
  /** The viewer's scope, exact; absent reads every scope. */
  readonly scope?: string
  readonly level: ViewerLevel
}

export interface DebugReportSource {
  readonly type: 'debug-report'
  readonly title: string
  readonly issue: DebugIssue
}

/** A support read tool rendered as report lines (migration ledger, media vs storage). */
export interface ToolSource {
  readonly type: 'tool'
  readonly title: string
  readonly tool: ReportTool
}

export type LogSource = HubLogSource | ViewerLogSource | DebugReportSource | ToolSource

const MIGRATIONS: ToolSource = {
  type: 'tool',
  title: 'Migrations (migrations_status)',
  tool: 'migrations-status',
}
const MEDIA_STORAGE: ToolSource = {
  type: 'tool',
  title: 'Stored media vs storage locations (media_storage_check)',
  tool: 'media-storage',
}

export const RECIPES: { readonly [K in ReportKind]: readonly LogSource[] } = {
  streams: [
    { type: 'debug-report', title: 'Stream state (debug_report)', issue: 'stream' },
    {
      type: 'hub',
      title: 'Stream broker',
      addonIds: ['stream-broker'],
      level: 'warn',
      perDevice: true,
    },
    { type: 'viewer', title: 'Viewer, live scope', scope: 'live', level: 'warn' },
  ],
  'media-thumbnails': [
    { type: 'viewer', title: 'Viewer, events:media scope', scope: 'events:media', level: 'info' },
    {
      type: 'hub',
      title: 'Pipeline analytics',
      addonIds: ['pipeline-analytics'],
      level: 'warn',
      perDevice: true,
    },
    { type: 'debug-report', title: 'Track media (debug_report media)', issue: 'media' },
    MEDIA_STORAGE,
    MIGRATIONS,
  ],
  ui: [
    { type: 'viewer', title: 'Viewer, all scopes', level: 'warn' },
    {
      type: 'hub',
      title: 'Admin UI and auth',
      addonIds: ['admin-ui', 'local-auth'],
      level: 'warn',
      perDevice: false,
    },
    { type: 'debug-report', title: 'Device view (debug_report)', issue: 'ui' },
  ],
  notifications: [
    {
      type: 'hub',
      title: 'Notifiers',
      addonIds: ['notifiers', 'smtp-nodemailer'],
      level: 'warn',
      perDevice: false,
    },
    {
      type: 'hub',
      title: 'Rule evaluation',
      addonIds: ['notifiers'],
      level: 'info',
      text: 'matched NO rule',
      perDevice: true,
    },
  ],
  'remote-access': [
    {
      type: 'hub',
      title: 'Tunnel, TURN and WebRTC',
      addonIds: [
        'cloudflare-tunnel',
        'cloudflare-turn',
        'static-turn',
        'tailscale-ingress',
        'remote-access-orchestrator',
        'webrtc-native',
      ],
      level: 'warn',
      perDevice: false,
    },
    { type: 'viewer', title: 'Viewer, live scope', scope: 'live', level: 'warn' },
  ],
  'pipeline-detection': [
    { type: 'debug-report', title: 'Detections (debug_report)', issue: 'detections' },
    {
      type: 'hub',
      title: 'Pipeline',
      addonIds: ['pipeline-orchestrator', 'detection-pipeline', 'pipeline-runner'],
      level: 'warn',
      perDevice: true,
    },
  ],
  'recording-storage': [
    {
      type: 'hub',
      title: 'Recorder and storage',
      addonIds: [
        'recorder',
        'storage-orchestrator',
        'filesystem-storage',
        'sftp-storage',
        's3-storage',
        'webdav-storage',
        'smb-storage',
      ],
      level: 'warn',
      perDevice: false,
    },
    MEDIA_STORAGE,
    MIGRATIONS,
  ],
  integration: [
    {
      type: 'hub',
      title: 'Exporters and integrations',
      addonIds: [
        'export-hap',
        'export-alexa',
        'export-google',
        'matter-broker',
        'homeassistant-export',
        'provider-homeassistant',
      ],
      level: 'warn',
      perDevice: false,
    },
    MIGRATIONS,
  ],
  other: [
    { type: 'hub', title: 'Hub errors', addonIds: [], level: 'error', perDevice: true },
    { type: 'viewer', title: 'Viewer, all scopes', level: 'error' },
    MIGRATIONS,
    MEDIA_STORAGE,
  ],
}

export interface LogSection {
  readonly title: string
  /** What was asked, in words: addon ids, filters. */
  readonly source: string
  /** `null`: the read failed (see `note`) — unknown, not "no lines". */
  readonly lines: readonly string[] | null
  readonly truncated: number
  readonly note: string | null
}

export interface LogCollection {
  readonly sections: readonly LogSection[]
  /** The newest viewer app version the viewer lines carried. */
  readonly viewerAppVersion: string | null
}

export interface CollectArgs {
  readonly kind: ReportKind
  readonly deviceId?: number
  readonly since?: string
}

const cut = (text: string): string =>
  text.length > LINE_MAX_CHARS ? `${text.slice(0, LINE_MAX_CHARS)}…` : text

function section(
  title: string,
  source: string,
  lines: readonly string[] | null,
  note: string | null = null,
): LogSection {
  const shown = lines === null ? null : lines.slice(0, LINES_PER_SECTION).map(cut)
  return {
    title,
    source,
    lines: shown,
    truncated: lines === null ? 0 : Math.max(0, lines.length - LINES_PER_SECTION),
    note,
  }
}

async function hubSection(
  client: HubClient,
  src: HubLogSource,
  args: CollectArgs,
  window: { readonly sinceMs: number; readonly untilMs: number },
): Promise<LogSection> {
  const unavailable: { [part: string]: string } = {}
  const query = makeTierQuery(client, [], unavailable)
  const device: { [tag: string]: string } =
    src.perDevice && args.deviceId !== undefined ? { deviceId: String(args.deviceId) } : {}
  const ids: readonly (string | null)[] = src.addonIds.length === 0 ? [null] : src.addonIds
  const entries: LogEntry[] = []
  let answered = false
  for (const addonId of ids) {
    const page = await query({
      since: window.sinceMs,
      until: window.untilMs,
      args: { level: src.level },
      limit: FETCH_LIMIT,
      tags: { ...(addonId !== null ? { addonId } : {}), ...device },
      ...(src.text !== undefined ? { text: src.text } : {}),
    })
    if (page !== null) {
      answered = true
      entries.push(...page.page.entries.filter((e) => levelRank(e.level) >= levelRank(src.level)))
    }
  }
  const source = `addons ${src.addonIds.join(', ') || 'any'}; level >= ${src.level}${src.text !== undefined ? `; grep "${src.text}"` : ''}${Object.keys(device).length > 0 ? '; this device' : ''}`
  if (!answered) {
    return section(
      src.title,
      source,
      null,
      `not read: ${Object.values(unavailable)[0] ?? 'no log tier answered'}`,
    )
  }
  const lines = groupEntries(entries).map(
    (g) =>
      `${g.count > 1 ? `${String(g.count)}x ` : ''}[${g.level}${g.scope ? ` ${g.scope}` : ''}] ${g.message} (last ${g.lastAt})`,
  )
  return section(src.title, source, lines)
}

const LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error']
const levelRank = (level: string): number => LEVELS.indexOf(level)

async function viewerSection(
  client: HubClient,
  src: ViewerLogSource,
  args: CollectArgs,
  window: { readonly sinceMs: number; readonly untilMs: number },
): Promise<{ section: LogSection; appVersion: string | null }> {
  const read = await readViewerLines(
    client,
    {
      level: src.level,
      limit: 200,
      ...(src.scope !== undefined ? { scope: src.scope } : {}),
      ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
    },
    window,
  )
  const source = `viewer app lines${src.scope !== undefined ? `, scope ${src.scope}` : ''}; level >= ${src.level}${args.deviceId !== undefined ? '; this device' : ''}`
  if (read.lines === null) {
    return {
      section: section(
        src.title,
        source,
        null,
        `not read: ${Object.values(read.unavailable)[0] ?? 'unknown'}`,
      ),
      appVersion: null,
    }
  }
  const newest = read.lines.toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const appVersion = newest.find((l) => l.appVersion !== null)?.appVersion ?? null
  const lines = newest.map((l) => `[${l.level ?? '?'} ${l.scope ?? '-'}] ${l.message} (${l.at})`)
  return { section: section(src.title, source, lines), appVersion }
}

async function debugSection(
  ctx: McpContext,
  src: DebugReportSource,
  args: CollectArgs,
): Promise<LogSection> {
  const source = `debug_report issue=${src.issue}`
  if (args.deviceId === undefined) {
    return section(src.title, source, [], 'skipped: no deviceId given')
  }
  const report = await debugReport(ctx, {
    deviceId: args.deviceId,
    issue: src.issue,
    ...(args.since !== undefined ? { since: args.since } : {}),
  })
  if (report.status !== 'ok') {
    return section(
      src.title,
      source,
      null,
      `not read: ${report.status === 'refused' ? report.reason : report.message}`,
    )
  }
  const cam = report.camera
  const lines: string[] = []
  for (const p of cam?.broker?.profiles ?? []) {
    lines.push(
      `profile ${p.profile}: ${p.status}, ${String(p.subscribers)} subscribers, in ${p.inFps === null ? 'unknown' : String(p.inFps)} fps`,
    )
  }
  const tracks = cam?.tracks
  if (tracks) {
    lines.push(
      `tracks: ${String(tracks.checked)} checked, ${String(tracks.withThumbnail)} with thumbnail, ${String(tracks.withKeyFrame)} with keyFrame, ${String(tracks.withoutThumbnailOrKeyFrame)} closed without either, ${String(tracks.noMediaAtAll)} with no media, ${String(tracks.unreadMedia)} unread`,
    )
  }
  const analysis = cam?.logs?.analysis
  if (analysis) {
    for (const e of analysis.events) {
      lines.push(
        `churn ${e.id}: ${String(e.count)} (${e.perHour === null ? 'n/a' : String(Math.round(e.perHour))}/h)`,
      )
    }
    for (const n of analysis.notable)
      lines.push(`[${n.level}${n.scope ? ` ${n.scope}` : ''}] ${n.message}`)
  }
  for (const note of report.notes) lines.push(`note: ${note}`)
  return section(src.title, source, lines)
}

export async function collectLogs(
  ctx: McpContext,
  client: HubClient,
  args: CollectArgs,
  window: { readonly sinceMs: number; readonly untilMs: number },
): Promise<LogCollection> {
  const sections: LogSection[] = []
  let viewerAppVersion: string | null = null
  for (const src of RECIPES[args.kind]) {
    if (src.type === 'hub') sections.push(await hubSection(client, src, args, window))
    else if (src.type === 'debug-report') sections.push(await debugSection(ctx, src, args))
    else if (src.type === 'tool') {
      const t = await toolLines(ctx, src.tool)
      sections.push(section(src.title, `support tool ${src.tool}`, t.lines, t.note))
    } else {
      const v = await viewerSection(client, src, args, window)
      sections.push(v.section)
      viewerAppVersion ??= v.appVersion
    }
  }
  return { sections, viewerAppVersion }
}

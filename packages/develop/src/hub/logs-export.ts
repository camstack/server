/**
 * The Logs page's export (#570): URL builder, args and the NDJSON summary, shared by
 * the operator MCP (`hub_logs_export`) and the public `camstack mcp` (`ops_logs_export`).
 *
 * It downloads the hub's `GET /api/logs/export` — the same route, the same
 * filters and the same default (everything over the last six hours, applied
 * by the hub when no `since` is sent) — into a file, then answers with a
 * bounded summary of the file: how many lines, the time span, the devices and
 * components seen, and whether the hub capped it. Read-only on the cluster;
 * admin credential required (the route is admin-only).
 */
import * as fs from 'node:fs'
import * as readline from 'node:readline'
import type { Readable } from 'node:stream'
import * as zlib from 'node:zlib'
import { z } from 'zod'
import type { HubDownloader } from './hub-download.js'

export const LOGS_EXPORT_URL_PATH = '/api/logs/export'
export const DEFAULT_LOGS_EXPORT_MAX_MB = 512
export const HARD_LOGS_EXPORT_MAX_MB = 4096
/** How many distinct devices / components the summary names. */
const SUMMARY_TOP = 20

export const LogsExportArgsSchema = z.object({
  /** addonIds (OR). Omit for every component. */
  components: z.array(z.string().min(1).max(200)).max(100).optional(),
  /** Numeric device ids (OR). Omit for every device. */
  deviceIds: z.array(z.number().int().nonnegative()).max(200).optional(),
  /** Minutes back from `until` (or now). Omit for the hub's default: six hours. */
  sinceMinutes: z.number().positive().max(43_200).optional(),
  /** Epoch ms; overrides sinceMinutes. */
  since: z.number().int().nonnegative().optional(),
  /** Epoch ms; default now. */
  until: z.number().int().nonnegative().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  /** A read-capable log-destination addonId, or `ring`. Default the hub's files. */
  provider: z.string().min(1).max(200).optional(),
  /** File name stem under scratchpad/logs-export/; defaults to a timestamp. */
  name: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,80}$/)
    .optional(),
  maxMegabytes: z.number().int().positive().max(HARD_LOGS_EXPORT_MAX_MB).optional(),
  /** Ask the hub for the export as one .zip (the file is then `<name>.zip`). Filtered or not. */
  zip: z.boolean().optional(),
})

export type LogsExportArgs = z.infer<typeof LogsExportArgsSchema>

/** The query string the hub route reads (`core/logging/log-export.ts`). */
export function logsExportUrl(args: LogsExportArgs, now: number): string {
  const params = new URLSearchParams()
  if (args.components && args.components.length > 0)
    params.set('components', args.components.join(','))
  if (args.deviceIds && args.deviceIds.length > 0) params.set('deviceIds', args.deviceIds.join(','))
  const until = args.until
  const since =
    args.since ??
    (args.sinceMinutes !== undefined ? (until ?? now) - args.sinceMinutes * 60_000 : undefined)
  if (since !== undefined) params.set('since', String(Math.floor(since)))
  if (until !== undefined) params.set('until', String(until))
  if (args.level) params.set('level', args.level)
  if (args.provider) params.set('source', args.provider)
  if (args.zip === true) params.set('zip', '1')
  const query = params.toString()
  return query.length > 0 ? `${LOGS_EXPORT_URL_PATH}?${query}` : LOGS_EXPORT_URL_PATH
}

const ExportedLineSchema = z.looseObject({
  timestamp: z.string().optional(),
  level: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  truncated: z.boolean().optional(),
})

export interface LogsExportSummary {
  readonly path: string
  readonly bytes: number
  readonly lines: number
  readonly newest: string | null
  readonly oldest: string | null
  readonly levels: Record<string, number>
  /** The busiest devices, `deviceId → lines`, at most 20. */
  readonly devices: Record<string, number>
  /** The busiest components, `addonId → lines`, at most 20. */
  readonly components: Record<string, number>
  /** The hub stopped at its line cap; narrow the filter or the range. */
  readonly truncated: boolean
  readonly next: string
}

function top(counts: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, SUMMARY_TOP),
  )
}

function bump(counts: Map<string, number>, key: string | undefined): void {
  if (key === undefined) return
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

const ZIP_END_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_END_MAX_BYTES = 22 + 0xffff

/**
 * The inflated bytes of the single entry of the .zip the hub wrote, streamed
 * from the file: the end record and the central directory say where the entry
 * sits, so nothing is held in memory.
 */
export function zipEntryStream(file: string): Readable {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const tail = Buffer.alloc(Math.min(size, ZIP_END_MAX_BYTES))
    fs.readSync(fd, tail, 0, tail.length, size - tail.length)
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (end < 0 || tail.readUInt32LE(end) !== ZIP_END_SIGNATURE) throw new Error('not a ZIP file')
    const directory = tail.readUInt32LE(end + 16)
    const central = Buffer.alloc(46)
    fs.readSync(fd, central, 0, central.length, directory)
    if (central.readUInt32LE(0) !== ZIP_CENTRAL_SIGNATURE)
      throw new Error('ZIP directory is damaged')
    const compressed = central.readUInt32LE(20)
    const local = central.readUInt32LE(42)
    const header = Buffer.alloc(30)
    fs.readSync(fd, header, 0, header.length, local)
    const start = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    const raw = fs.createReadStream(file, { start, end: start + compressed - 1 })
    return compressed === 0 ? raw : raw.pipe(zlib.createInflateRaw())
  } finally {
    fs.closeSync(fd)
  }
}

/** Read the downloaded NDJSON (or the NDJSON inside its .zip) once, line by line, into a bounded summary. */
export async function summarizeLogsExport(
  file: string,
  options: { readonly zip?: boolean } = {},
): Promise<Omit<LogsExportSummary, 'path' | 'bytes' | 'next'>> {
  const levels = new Map<string, number>()
  const devices = new Map<string, number>()
  const components = new Map<string, number>()
  let lines = 0
  let newest: string | null = null
  let oldest: string | null = null
  let truncated = false
  const input = options.zip === true ? zipEntryStream(file) : fs.createReadStream(file)
  const reader = readline.createInterface({ input, crlfDelay: Infinity })
  for await (const text of reader) {
    if (text.trim().length === 0) continue
    const parsed = ExportedLineSchema.safeParse(JSON.parse(text))
    if (!parsed.success) continue
    if (parsed.data.truncated === true) {
      truncated = true
      continue
    }
    lines += 1
    const ts = parsed.data.timestamp ?? null
    if (ts !== null) {
      newest ??= ts
      oldest = ts
    }
    bump(levels, parsed.data.level)
    bump(devices, parsed.data.tags?.['deviceId'])
    bump(components, parsed.data.tags?.['addonId'])
  }
  return {
    lines,
    newest,
    oldest,
    levels: Object.fromEntries(levels),
    devices: top(devices),
    components: top(components),
    truncated,
  }
}

export interface LogsExportDownload extends Omit<LogsExportSummary, 'path' | 'next'> {
  readonly bytes: number
}

/** Download the export to `dest` and summarise it. The caller picks the file and words `path`/`next`. */
export async function downloadLogsExport(
  download: HubDownloader,
  dest: string,
  args: LogsExportArgs,
  at: Date,
): Promise<LogsExportDownload> {
  const maxBytes = (args.maxMegabytes ?? DEFAULT_LOGS_EXPORT_MAX_MB) * 1024 * 1024
  const { bytes } = await download(logsExportUrl(args, at.getTime()), dest, maxBytes)
  return { bytes, ...(await summarizeLogsExport(dest, { zip: args.zip === true })) }
}

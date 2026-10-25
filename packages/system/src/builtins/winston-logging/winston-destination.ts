import * as winston from 'winston'
import DailyRotateFile from 'winston-daily-rotate-file'
import * as path from 'node:path'
import type {
  ILogDestination,
  LogEntry,
  LogReadCapabilities,
  LogReadQuery,
  LogReadResult,
} from '@camstack/types'
import { formatLogLine } from '../../logging/formatter.js'
import { LogFileReadClient, type LogFileReadClientOptions } from './log-file-read-client.js'

interface WinstonConfig {
  readonly level: string
  readonly retentionDays: number
  /** Resolved absolute path to the logs directory (replaces the old dataPath field). */
  readonly logsDir: string
}

/**
 * Rotated-file log destination. Console output goes through the shared
 * `formatLogLine` so every console sink (Winston, ConsoleDestination,
 * HubForwarderDestination) emits identical lines. File output keeps a
 * structured JSON shape so log tooling can query tags/meta.
 */
export class WinstonDestination implements ILogDestination {
  private logger: winston.Logger | null = null
  private reader: LogFileReadClient | null = null
  private retentionDays = 30

  /**
   * `readerOptions` reaches the history reader (D898) — a spec runs it in
   * process or points the thread at the TypeScript source.
   */
  constructor(private readonly readerOptions: Omit<LogFileReadClientOptions, 'logsDir'> = {}) {}

  async initialize(config?: WinstonConfig): Promise<void> {
    const {
      level = 'info',
      retentionDays = 30,
      logsDir = path.join('camstack-data', 'logs'),
    } = config ?? {}
    this.retentionDays = retentionDays
    this.reader = new LogFileReadClient({ ...this.readerOptions, logsDir })

    // Console: canonical single-line formatter — `_rendered` already
    // carries level-based ANSI colour codes (see `formatLogLine` in
    // `@camstack/system/logging/formatter.ts`). Using Winston's colorize
    // here would just decorate unused `info.level` and leave the
    // rendered line uncoloured.
    const consoleFormat = winston.format.printf((info) => {
      const rendered = (info as { _rendered?: string })._rendered
      return typeof rendered === 'string' ? rendered : String(info.message)
    })

    // File: structured JSON. Strip `_rendered` first — it carries ANSI
    // escape codes intended for the terminal and has no place in a
    // rotated-file store used for ops queries.
    const stripRendered = winston.format((info) => {
      delete (info as Record<string, unknown>)['_rendered']
      return info
    })
    const fileFormat = winston.format.combine(
      winston.format.timestamp(),
      stripRendered(),
      winston.format.json(),
    )

    // File-only winston. Stdout is owned by `ConsoleDestination`
    // (the `console-logging` builtin addon) — adding a Winston console
    // transport here would re-render every log line a second time on
    // the hub terminal, which is the historic cause of the duplicate
    // output operators have been seeing. The `consoleFormat` printf
    // above stays wired in so a future opt-in transport can use it
    // without re-deriving the layout.
    void consoleFormat
    this.logger = winston.createLogger({
      level,
      transports: [
        new DailyRotateFile({
          dirname: logsDir,
          filename: 'camstack-%DATE%.log',
          datePattern: 'YYYY-MM-DD',
          maxFiles: `${retentionDays}d`,
          format: fileFormat,
        }),
      ],
    })
  }

  write(entry: LogEntry): void {
    if (!this.logger) return

    // Moleculer JSON serialization converts Date → string; normalize back
    const ts =
      entry.timestamp instanceof Date ? entry.timestamp.toISOString() : String(entry.timestamp)
    // Render once with colours for the console transport; file transport
    // strips `_rendered` via the format chain above so disk stays plain.
    const rendered = formatLogLine(entry, { colorize: true })

    this.logger.log({
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      level: entry.level,
      message: entry.message,
      _rendered: rendered,
      timestamp: ts,
      scope: entry.scope,
      ...(entry.tags ? { tags: entry.tags } : {}),
      ...(entry.meta ? { meta: entry.meta } : {}),
    })
  }

  /** The rotated files ARE the hub's history (D898): every filter is applied here. */
  async describeRead(): Promise<LogReadCapabilities> {
    return {
      readable: this.reader !== null,
      reason: this.reader !== null ? null : 'Not initialized',
      filters: {
        deviceId: true,
        addonId: true,
        nodeId: true,
        tags: true,
        level: true,
        text: true,
        timeRange: true,
      },
      retentionDays: this.retentionDays,
    }
  }

  /** Index the existing files in the background now (the hub's history). */
  startBackgroundIndexing(): void {
    this.reader?.warm()
  }

  async read(query: LogReadQuery): Promise<LogReadResult> {
    if (this.reader === null) throw new Error('winston-logging: not initialized')
    return this.reader.read(query)
  }

  async cancelRead(input: {
    readonly requestId: string
  }): Promise<{ readonly cancelled: boolean }> {
    return { cancelled: this.reader?.cancel(input.requestId) ?? false }
  }

  async shutdown(): Promise<void> {
    this.reader?.stop()
    this.reader = null
    if (!this.logger) return

    await new Promise<void>((resolve) => {
      this.logger!.on('finish', resolve)
      this.logger!.end()
    })
    this.logger = null
  }
}

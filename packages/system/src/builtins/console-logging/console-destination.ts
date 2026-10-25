/**
 * Zero-dependency log destination that writes every entry to stdout /
 * stderr via the shared `formatLogLine` formatter. Same surface as
 * `WinstonDestination` (full `ILogDestination` contract) but without
 * the rotating-file transport — ideal fallback when the Winston addon
 * is disabled or unavailable (e.g. bare-bones agents, tests).
 */
import type { ILogDestination, LogEntry } from '@camstack/types'
import { formatLogLine } from '../../logging/formatter.js'

interface ConsoleConfig {
  /** Minimum log level to emit. Entries below this level are dropped. */
  readonly level?: 'debug' | 'info' | 'warn' | 'error'
}

const LEVEL_RANK: Readonly<Record<string, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export class ConsoleDestination implements ILogDestination {
  private minLevel = 0

  async initialize(config?: ConsoleConfig): Promise<void> {
    this.minLevel = LEVEL_RANK[config?.level ?? 'info'] ?? 1
  }

  write(entry: LogEntry): void {
    const rank = LEVEL_RANK[entry.level] ?? 1
    if (rank < this.minLevel) return
    // Always request ANSI colours for the console sink. The formatter still
    // respects `NO_COLOR` so operators can opt out globally.
    const line = formatLogLine(entry, { colorize: true })
    if (entry.level === 'error') console.error(line)
    else if (entry.level === 'warn') console.warn(line)
    else console.log(line)
  }

  async shutdown(): Promise<void> {
    // Nothing to flush — stdout/stderr are process-owned.
  }
}

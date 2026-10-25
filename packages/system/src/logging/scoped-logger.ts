import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'
import type { LogEntry, LogLevel } from './log-ring-buffer.js'

export type { IScopedLogger }

export class ScopedLogger implements IScopedLogger {
  constructor(
    private readonly scope: string | undefined,
    private readonly writeFn: (entry: LogEntry) => void,
    private readonly tags?: LogTags,
  ) {}

  debug(message: string, extras?: LogExtras): void {
    this.write('debug', message, extras)
  }

  info(message: string, extras?: LogExtras): void {
    this.write('info', message, extras)
  }

  warn(message: string, extras?: LogExtras): void {
    this.write('warn', message, extras)
  }

  error(message: string, extras?: LogExtras): void {
    this.write('error', message, extras)
  }

  child(childScope: string): IScopedLogger {
    return new ScopedLogger(childScope, this.writeFn, this.tags)
  }

  withTags(tags: LogTags): IScopedLogger {
    const merged = this.tags ? { ...this.tags, ...tags } : tags
    return new ScopedLogger(this.scope, this.writeFn, merged)
  }

  private write(level: LogLevel, message: string, extras?: LogExtras): void {
    const mergedTags = this.mergeTags(extras?.tags)
    const entry: LogEntry = {
      timestamp: new Date(),
      level,
      message,
      ...(this.scope !== undefined ? { scope: this.scope } : {}),
      ...(extras?.meta !== undefined ? { meta: extras.meta } : {}),
      ...(mergedTags ? { tags: mergedTags } : {}),
    }
    this.writeFn(entry)
  }

  private mergeTags(extraTags?: LogTags): LogTags | undefined {
    if (!this.tags && !extraTags) return undefined
    if (!this.tags) return extraTags
    if (!extraTags) return this.tags
    return { ...this.tags, ...extraTags }
  }
}

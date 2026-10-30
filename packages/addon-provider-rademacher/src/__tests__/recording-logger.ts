import type { IScopedLogger, LogExtras, LogTags } from '@camstack/types'

/** One captured log line. */
export interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly extras: LogExtras | undefined
  readonly tags: LogTags
}

/** A logger that records every line, with the tags bound through `withTags` folded in. */
export class RecordingLogger implements IScopedLogger {
  readonly lines: LoggedLine[]
  readonly #tags: LogTags

  constructor(lines: LoggedLine[] = [], tags: LogTags = {}) {
    this.lines = lines
    this.#tags = tags
  }

  #record(level: LoggedLine['level'], message: string, extras?: LogExtras): void {
    this.lines.push({
      level,
      message,
      extras,
      tags: { ...this.#tags, ...extras?.tags },
    })
  }

  debug(message: string, extras?: LogExtras): void {
    this.#record('debug', message, extras)
  }
  info(message: string, extras?: LogExtras): void {
    this.#record('info', message, extras)
  }
  warn(message: string, extras?: LogExtras): void {
    this.#record('warn', message, extras)
  }
  error(message: string, extras?: LogExtras): void {
    this.#record('error', message, extras)
  }
  child(): IScopedLogger {
    return new RecordingLogger(this.lines, this.#tags)
  }
  withTags(tags: LogTags): IScopedLogger {
    return new RecordingLogger(this.lines, { ...this.#tags, ...tags })
  }
}

import type { IScopedLogger, LogExtras, LogLevel } from '@camstack/types'

/** No-op scoped logger for unit tests. */
export function makeTestLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

export interface RecordedLogEntry {
  readonly level: LogLevel
  readonly message: string
  readonly extras?: LogExtras
}

/**
 * A logger that REMEMBERS, so a test can assert on the line itself.
 *
 * Returns a PAIR rather than a widened `IScopedLogger`: the repo's lint plugin
 * forbids custom logger interfaces, and it is right to — the recording is a
 * property of the test harness, not of the logger contract the code under test
 * depends on. Injection sites take `.logger`; assertions read `.entries`.
 *
 * This exists because "a branch that drops work logs it" is a rule with a price
 * attached here — a 3-hour media blackout produced not one line — and a rule
 * nothing checks has already been broken somewhere. Tags are recorded verbatim
 * so a `tags.deviceId` assertion actually proves the per-camera grouping the
 * operator needs.
 */
export interface TestLoggerHandle {
  readonly logger: IScopedLogger
  readonly entries: readonly RecordedLogEntry[]
}

export function createTestLogger(): TestLoggerHandle {
  const entries: RecordedLogEntry[] = []
  const push =
    (level: LogLevel) =>
    (message: string, extras?: LogExtras): void => {
      entries.push(extras === undefined ? { level, message } : { level, message, extras })
    }
  const logger: IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, entries }
}

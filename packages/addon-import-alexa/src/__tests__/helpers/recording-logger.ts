import type { IScopedLogger } from '@camstack/types'

export interface LoggedLine {
  readonly level: string
  readonly message: string
  readonly meta: unknown
}

export interface LogRecorder {
  readonly logger: IScopedLogger
  readonly lines: LoggedLine[]
  /** Everything logged, as one string, for a "no secret in the log" assertion. */
  readonly dump: () => string
}

export function recordingLogger(): LogRecorder {
  const lines: LoggedLine[] = []
  const at =
    (level: string) =>
    (message: string, opts?: { readonly meta?: unknown }): void => {
      lines.push({ level, message, meta: opts?.meta })
    }
  const logger: IScopedLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines, dump: () => JSON.stringify(lines) }
}

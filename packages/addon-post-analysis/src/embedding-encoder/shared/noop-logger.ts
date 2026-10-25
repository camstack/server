import type { IScopedLogger, LogTags } from '@camstack/types'

const noop = (): void => {
  /* intentional no-op */
}

export function createNoopLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: (_tags: LogTags) => logger,
  }
  return logger
}

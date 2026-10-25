import type { IScopedLogger, LogExtras } from '@camstack/types'
import { type Mock, vi } from 'vitest'

type LogFn = (message: string, extras?: LogExtras) => void

/** The four levels of an `IScopedLogger`, as inspectable mocks. */
interface LogMocks {
  readonly debug: Mock<LogFn>
  readonly info: Mock<LogFn>
  readonly warn: Mock<LogFn>
  readonly error: Mock<LogFn>
}

export type FakeLogger = IScopedLogger & LogMocks

export function fakeLogger(): FakeLogger {
  const logger: FakeLogger = {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

/** Every call on every level, flattened — for "each line carries the tag" checks. */
export function allLogCalls(logger: FakeLogger): ReadonlyArray<readonly [string, LogExtras?]> {
  return [
    ...logger.debug.mock.calls,
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.error.mock.calls,
  ]
}

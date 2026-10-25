/**
 * A discard-everything `IScopedLogger` for tracking-bench code that has no
 * `ctx.logger` of its own (D681 fix round 1, L1) — `case-fixture.ts`'s
 * `caseFromBundle` is a pure function per its contract and `loadCaseFixture`
 * takes only a `dir`, yet both call `deriveTruth`/`readTapeFile`, which now
 * require a logger. Kept local to `tracking-bench/` rather than imported from
 * `embedding-encoder/shared/` (a different addon's source tree) so this
 * module stays inside its own subsystem.
 */
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

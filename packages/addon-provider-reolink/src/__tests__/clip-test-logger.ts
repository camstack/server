/**
 * A recording `IScopedLogger` for the clip specs.
 *
 * Real, not a stub: the clip surface's whole discipline is that every line
 * about a camera carries `tags: { deviceId }` and every branch that drops work
 * says so, and a fake that swallowed `extras` would make both untestable.
 */
import type { IScopedLogger, LogExtras } from '@camstack/types'

export interface RecordedLine {
  readonly message: string
  readonly extras: LogExtras
}

/** The lines a spec reads back. Intersected with the real logger interface
 *  rather than redeclaring one — the repo's guard is right that a second
 *  logger shape is how `tags` quietly stops being asserted. */
export interface RecordedLines {
  readonly infos: RecordedLine[]
  readonly warns: RecordedLine[]
}

export type RecordingSink = IScopedLogger & RecordedLines

export function createRecordingLogger(): RecordingSink {
  const infos: RecordedLine[] = []
  const warns: RecordedLine[] = []
  const logger: RecordingSink = {
    infos,
    warns,
    info: (message, extras) => {
      infos.push({ message, extras: extras ?? {} })
    },
    warn: (message, extras) => {
      warns.push({ message, extras: extras ?? {} })
    },
    debug: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

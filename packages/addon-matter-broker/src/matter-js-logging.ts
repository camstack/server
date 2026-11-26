/**
 * Route matter.js's own log output (session, CASE, subscription retries) into
 * the addon's scoped logger. matter.js writes to `console` by default; here a
 * single destination replaces it: warn goes to `warn`, error and fatal to
 * `error`, everything below warn to `debug`.
 *
 * matter.js's logger is process-global, so the attach is reference-counted:
 * the first attach installs the destination, the last detach restores the
 * original default one.
 */

import { LogDestination, Logger, LogLevel } from '@matter/main'
import type { IScopedLogger } from '@camstack/types'

const DESTINATION_NAME = 'camstack-matter-broker'
const DEFAULT_DESTINATION = 'default'

let attachCount = 0
let original: LogDestination | undefined

/** Attach the scoped logger as matter.js's only destination; returns the detach. */
export function attachMatterJsLogger(logger: IScopedLogger): () => void {
  attachCount += 1
  if (attachCount === 1) {
    original =
      DEFAULT_DESTINATION in Logger.destinations
        ? Logger.destinations[DEFAULT_DESTINATION]
        : undefined
    const destination = LogDestination({
      name: DESTINATION_NAME,
      level: LogLevel.DEBUG,
      write: (text, message) => {
        const meta = { facility: message.facility }
        if (message.level >= LogLevel.ERROR) logger.error(text, { meta })
        else if (message.level >= LogLevel.WARN) logger.warn(text, { meta })
        else logger.debug(text, { meta })
      },
    })
    delete Logger.destinations[DEFAULT_DESTINATION]
    Logger.destinations[DESTINATION_NAME] = destination
  }
  let detached = false
  return () => {
    if (detached) return
    detached = true
    attachCount -= 1
    if (attachCount > 0) return
    delete Logger.destinations[DESTINATION_NAME]
    if (original !== undefined) Logger.destinations[DEFAULT_DESTINATION] = original
    original = undefined
  }
}

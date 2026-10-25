/**
 * The boot log must be READABLE, from the first line, in the order it happened.
 *
 * Before this: `LogManager` buffered every line until a `log-destination`
 * provider registered, and the only stdout destination (`console-logging`) is a
 * core builtin that boots in pass 3 — AFTER the whole runner plan. A measured
 * hub boot therefore produced no stdout at all for ~40 s and then flushed the
 * entire backlog at once, NEWEST-FIRST, because the replay iterates
 * `PartitionedLogBuffer.query({})` and that sorts descending for the log
 * viewer. Every boot investigation had to be run through a parser
 * (docs/design/boot-to-usable-camera.md, item F).
 *
 * Two gates, both of which fail when their fix is removed:
 *  - a replay reaches a destination oldest-first (a sink is a stream, the
 *    viewer's newest-first sort is a READ concern and stays);
 *  - a bootstrap console attached before any addon exists prints live, and the
 *    real stdout owner supersedes it WITHOUT reprinting the backlog.
 */
import { describe, expect, it } from 'vitest'
import { type ILogDestination, LogManager, STDOUT_DESTINATION_ADDON_ID } from '../log-manager.js'
import type { LogEntry } from '../log-ring-buffer.js'

/** A destination that records exactly what it was handed, in order. */
function recorder(): { dest: ILogDestination; lines: string[] } {
  const lines: string[] = []
  const dest: ILogDestination = {
    initialize: async () => {},
    shutdown: async () => {},
    write: (entry: LogEntry) => {
      lines.push(entry.message)
    },
  }
  return { dest, lines }
}

describe('LogManager — the boot log is readable from the first line', () => {
  it('replays a destination oldest-first, not newest-first', () => {
    const manager = new LogManager()
    const logger = manager.createLogger('boot')
    logger.info('one')
    logger.info('two')
    logger.info('three')

    const file = recorder()
    manager.addDestination(file.dest, { addonId: 'winston-logging' })

    expect(file.lines).toEqual(['one', 'two', 'three'])
  })

  it('a bootstrap console sees every line live, from before any addon exists', () => {
    const manager = new LogManager()
    const boot = recorder()
    manager.attachBootstrapConsole(boot.dest)

    const logger = manager.createLogger('boot')
    logger.info('first line of the boot')
    logger.warn('a runner failed')

    expect(boot.lines).toEqual(['first line of the boot', 'a runner failed'])
  })

  it('the stdout owner supersedes the bootstrap console without reprinting the backlog', () => {
    const manager = new LogManager()
    const boot = recorder()
    manager.attachBootstrapConsole(boot.dest)

    const logger = manager.createLogger('boot')
    logger.info('one')
    logger.info('two')

    const consoleAddon = recorder()
    manager.addDestination(consoleAddon.dest, { addonId: STDOUT_DESTINATION_ADDON_ID })

    // No replay: the operator already read those two lines on stdout.
    expect(consoleAddon.lines).toEqual([])

    logger.info('three')
    // The bootstrap sink is detached — exactly one copy of every line reaches
    // stdout, and no line is printed twice at the handover.
    expect(boot.lines).toEqual(['one', 'two'])
    expect(consoleAddon.lines).toEqual(['three'])
  })

  it('a NON-stdout destination neither detaches the bootstrap console nor loses its replay', () => {
    const manager = new LogManager()
    const boot = recorder()
    manager.attachBootstrapConsole(boot.dest)

    const logger = manager.createLogger('boot')
    logger.info('one')

    // winston is file-only; it must still receive the backlog it missed, and
    // stdout must keep working until `console-logging` itself boots.
    const file = recorder()
    manager.addDestination(file.dest, { addonId: 'winston-logging' })
    logger.info('two')

    expect(file.lines).toEqual(['one', 'two'])
    expect(boot.lines).toEqual(['one', 'two'])
  })

  it('the bootstrap console is never silenced by the per-destination toggle', () => {
    const manager = new LogManager()
    manager.setDestinationEnabledCheck(() => false)
    const boot = recorder()
    manager.attachBootstrapConsole(boot.dest)

    manager.createLogger('boot').error('the hub failed to start')

    // An operator toggle that could hide the boot log would hide the one
    // failure nobody can debug any other way.
    expect(boot.lines).toEqual(['the hub failed to start'])
  })
})

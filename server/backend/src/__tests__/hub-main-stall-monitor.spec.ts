import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN = path.resolve(__dirname, '..', 'main.ts')

/**
 * hub-main names its own freezes.
 *
 * Every runner's UDS request waits on THIS event loop, so a hub-main freeze is
 * indistinguishable — from any addon's point of view — from that addon being
 * slow. `pipeline-analytics` goes silent for 10+ s about three times an hour
 * (2026-09-09) and the two candidate mechanisms are "the events arrived late"
 * and "this process was busy"; the frame-lag line answers that for analytics,
 * and this monitor is what says whether the late delivery was hub-main's own
 * stall. Without it, "starved" has no next question.
 *
 * A source assertion rather than a boot test, for the same reason
 * `startup-listen-order.spec.ts` is one: `bootstrap()` cannot be run in a unit
 * test, and the failure this guards against is a WIRING one — the monitor
 * silently not being armed, which is invisible until an investigation needs it
 * and finds nothing.
 */
describe('hub-main arms the event-loop stall monitor', () => {
  const source = fs.readFileSync(MAIN, 'utf-8')

  it('imports it from @camstack/system rather than re-implementing it', () => {
    expect(source).toMatch(/startEventLoopStallMonitor/)
    expect(source).toMatch(/from '@camstack\/system'/)
  })

  it('arms it only once the logging service exists, so the lines reach Loki', () => {
    // Started before `loggingService`, the monitor could only ever reach
    // `console.log` — which is not a log destination. That is exactly how the
    // heap heartbeat spent 42 hours invisible for the largest process in the
    // cluster.
    const loggingService = source.indexOf('const loggingService = app.get(LoggingService)')
    const armed = source.indexOf('startEventLoopStallMonitor(')
    expect(loggingService).toBeGreaterThan(-1)
    expect(armed).toBeGreaterThan(loggingService)
  })
})

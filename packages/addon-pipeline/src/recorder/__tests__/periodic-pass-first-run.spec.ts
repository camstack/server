/**
 * A daily pass on a process that restarts more often than daily never runs.
 *
 * `startPeriodicPass` armed a `setInterval` and nothing else, so the first run
 * happened one full interval after boot. For the 5-minute passes that is
 * invisible; for hour adoption — the repair D521 added for sealed-but-short
 * hours, at a 24 h interval — it means the repair fires only on a hub that has
 * been up for a day. This hub was restarted five times in one morning while its
 * own recording hole sat unrepaired.
 *
 * `firstRunDelayMs` is opt-in: passes that want a run shortly after boot ask
 * for one. Nothing changes for the passes that do not.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { startPeriodicPass } from '../addon/periodic-pass.js'

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof startPeriodicPass>[0]['logger']

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('startPeriodicPass first run', () => {
  it('waits a full interval when no first-run delay is asked for', async () => {
    const run = vi.fn(async () => undefined)
    const handle = startPeriodicPass({
      name: 'unchanged',
      intervalMs: 60_000,
      slowAfterMs: 10_000,
      run,
      logger: silentLogger,
    })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run).toHaveBeenCalledTimes(1)
    handle.stop()
  })

  it('runs once shortly after boot when asked, THEN keeps the interval', async () => {
    const run = vi.fn(async () => undefined)
    const handle = startPeriodicPass({
      name: 'hour-adoption',
      intervalMs: 24 * 60 * 60_000,
      slowAfterMs: 60_000,
      firstRunDelayMs: 90_000,
      run,
      logger: silentLogger,
    })
    await vi.advanceTimersByTimeAsync(89_000)
    expect(run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run).toHaveBeenCalledTimes(1)

    // And the daily cadence still holds afterwards.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
    handle.stop()
  })

  it('a stop before the first run cancels it — a shut-down addon starts nothing', async () => {
    const run = vi.fn(async () => undefined)
    const handle = startPeriodicPass({
      name: 'hour-adoption',
      intervalMs: 24 * 60 * 60_000,
      slowAfterMs: 60_000,
      firstRunDelayMs: 90_000,
      run,
      logger: silentLogger,
    })
    handle.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).not.toHaveBeenCalled()
  })
})

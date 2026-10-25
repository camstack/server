/**
 * Event-loop occupancy probe — the instrument for "does this work stall
 * hub-main?".
 *
 * A `setImmediate` ping chain records timestamps on the isolate's JS thread.
 * Synchronous native work (`better-sqlite3` `Statement.run`) does not yield,
 * so no ping fires until it returns and the longest pause equals the burst.
 * Work that actually awaits (a timer, a UDS round-trip to another process)
 * lets pings through, so the longest pause is a scheduling quantum, not the
 * burst.
 *
 * Isolating sqlite-settings is a win only if a caller-side `await` of the
 * same writes looks like the yielding control, not like the sqlite burst.
 */

export interface EventLoopBurst {
  /** Wall time of `work`, milliseconds. */
  readonly burstMs: number
  /** Longest gap between consecutive pings that overlap the burst. */
  readonly longestPauseMs: number
  /** Pings that landed strictly inside `(start, end)`. Zero means the loop never ran. */
  readonly pingCount: number
}

export type EventLoopWork = () => void | Promise<void>

export async function measureEventLoopDuring(work: EventLoopWork): Promise<EventLoopBurst> {
  const stamps: number[] = []
  let armed = true
  const ping = (): void => {
    stamps.push(performance.now())
    if (armed) setImmediate(ping)
  }
  setImmediate(ping)
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

  const start = performance.now()
  await work()
  const end = performance.now()

  armed = false
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

  const inWindow = [start]
  for (const t of stamps) {
    if (t >= start && t <= end) inWindow.push(t)
  }
  inWindow.push(end)

  let longestPauseMs = 0
  for (let i = 1; i < inWindow.length; i++) {
    const prev = inWindow[i - 1]
    const next = inWindow[i]
    if (prev === undefined || next === undefined) continue
    const gap = next - prev
    if (gap > longestPauseMs) longestPauseMs = gap
  }

  let pingCount = 0
  for (const t of stamps) {
    if (t > start && t < end) pingCount += 1
  }

  return { burstMs: end - start, longestPauseMs, pingCount }
}

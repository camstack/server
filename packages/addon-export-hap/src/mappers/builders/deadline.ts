/**
 * Bound a piece of optional work in time.
 *
 * HomeKit answers `Selected RTP Stream Configuration` inside a write handler
 * hap-nodejs expects back quickly, and the start path behind it makes six
 * sequential cross-process cap calls into a stream-broker that regularly
 * freezes for two to three seconds at a time. Measured on the live hub: the
 * controller negotiated at :11, gave up at 9.1 s, and the bitrate fit resolved
 * at :32 — twenty-one seconds — with the start then failing on `Not running`
 * because the session it was preparing no longer existed.
 *
 * The evidence those calls gather is genuinely optional: an absent reading
 * classifies as `unknown`, and the tolerated branch still picks a slot. So the
 * right trade under load is to answer with less evidence rather than late, and
 * this makes that trade explicit at each call site instead of leaving it to
 * whatever the broker's latency happens to be.
 *
 * A late failure from work we stopped waiting on is swallowed on purpose: the
 * probe keeps running after the deadline fires, and an unhandled rejection
 * from an abandoned probe would take the process down over a reading nobody is
 * using any more.
 */
const TIMED_OUT = Symbol('deadline:timed-out')
const FAILED = Symbol('deadline:failed')

export async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const guard = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })

  try {
    // A rejection INSIDE the budget is missing evidence, not a timeout — it
    // gets the same fallback but must not be reported as slowness, or the log
    // sends the next reader after a latency problem that is not there.
    const settled = await Promise.race<T | typeof TIMED_OUT | typeof FAILED>([
      work.catch((): typeof FAILED => FAILED),
      guard,
    ])
    if (settled === TIMED_OUT) {
      onTimeout()
      return fallback
    }
    return settled === FAILED ? fallback : settled
  } finally {
    // Without this the handler stays open for the whole budget on EVERY call,
    // which is the opposite of the point.
    if (timer !== undefined) clearTimeout(timer)
    void work.catch(() => undefined)
  }
}

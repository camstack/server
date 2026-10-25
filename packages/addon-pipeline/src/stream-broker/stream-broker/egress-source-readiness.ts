/**
 * Wait for the SOURCE to be carrying media before an egress child is spawned
 * against it.
 *
 * The failure this exists for, measured on the hub on 2026-09-13: a lazy
 * camera's publisher took 5.5 s to materialise (`rfc4571: publisher
 * materialized {materializeMs=5486}`) while the egress child had already been
 * spawned three seconds earlier. ffmpeg opened a loopback nothing was serving,
 * died on the input, and the death was charged to `-hwaccel vaapi` — a
 * process-wide thirty-minute quarantine for every other camera, over a race
 * that had nothing to do with the GPU. `isDecodeBackendFailure` stops the
 * mis-attribution; this stops the death.
 *
 * Two rules it keeps:
 *
 *  - **A wait is never a refusal.** A source that has produced no packet by the
 *    deadline is still spawned against: a push broker that has yet to receive
 *    its first frame, and one that is genuinely broken, look identical from
 *    here, and refusing the second would also refuse the first. The caller
 *    reports what it waited and carries on.
 *  - **An UNKNOWN source is not a cold one.** `hasMedia` returning `null` means
 *    nobody could answer (no broker under that id, a lookup that threw) — that
 *    is not evidence the source is empty, so the wait ends at once rather than
 *    spending the whole deadline on a question with no answer. (D393.)
 */

export interface SourceWaitStateInput {
  /** Has the source broker carried a packet? */
  readonly hasMedia: boolean
  /** Is a lazy publisher being BUILT right now? */
  readonly materializing: boolean
}

/**
 * Whether waiting on this source can achieve anything — the three-way answer
 * `waitForSourceMedia` consumes.
 *
 * The subtlety that cost a measured 15 s per cold Alexa open on 2026-09-13: a
 * lazy publisher materialises because someone DIALS it. The source broker's own
 * `redial` / `kickReconnect` both refuse without demand, by design — a broker
 * with no consumer must not wake a camera. So for a cold, idle source the
 * ffmpeg child IS the demand, and withholding it waits for media that only
 * starts because of the thing being withheld. The live log of that mistake:
 *
 *   19:04:27  waited for the SOURCE  {outcome=timeout waitedMs=15005 ready=false}
 *   19:04:30  the child died before the decoder — retrying in SOFTWARE
 *   19:04:32  rfc4571: publisher materialized {materializeMs=5798}
 *
 * Fifteen seconds of nothing, then the spawn, then the wake it had triggered.
 *
 * So: wait only when a materialize is ALREADY in flight — a second consumer
 * arriving while the first is waking the camera, which is the case the wait was
 * really for. A cold idle source answers `null`: not "no media", but "waiting
 * here cannot help", and the caller spawns at once.
 */
export function sourceWaitState(input: SourceWaitStateInput): boolean | null {
  if (input.hasMedia) return true
  if (input.materializing) return false
  return null
}

export interface SourceMediaWait {
  /** Whether the source was carrying media when the wait ended. */
  readonly ready: boolean
  /** Ms actually spent waiting — `0` when the source was already live. */
  readonly waitedMs: number
  /** Why the wait ended. Goes straight into the log meta. */
  readonly outcome: 'live' | 'materialized' | 'unknown' | 'timeout'
}

export interface SourceMediaWaitInput {
  /** `true` carrying media, `false` not yet, `null` nobody could answer. */
  readonly hasMedia: () => boolean | null
  readonly timeoutMs: number
  readonly pollMs: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

export async function waitForSourceMedia(input: SourceMediaWaitInput): Promise<SourceMediaWait> {
  const started = input.now()
  const first = input.hasMedia()
  if (first === null) return { ready: false, waitedMs: 0, outcome: 'unknown' }
  if (first) return { ready: true, waitedMs: 0, outcome: 'live' }

  for (;;) {
    const elapsed = input.now() - started
    if (elapsed >= input.timeoutMs) return { ready: false, waitedMs: elapsed, outcome: 'timeout' }
    await input.sleep(input.pollMs)
    const state = input.hasMedia()
    const waitedMs = input.now() - started
    if (state === null) return { ready: false, waitedMs, outcome: 'unknown' }
    if (state) return { ready: true, waitedMs, outcome: 'materialized' }
  }
}

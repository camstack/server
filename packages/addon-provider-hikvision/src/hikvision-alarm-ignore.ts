/**
 * The alarm events this provider deliberately never acts on — and, for each,
 * the reason it is safe not to.
 *
 * This is a POLICY file, not a filter of convenience. An `eventType` we do not
 * model is information: it means the camera is telling us something we cannot
 * read. Discarding it silently is exactly what CLAUDE.md forbids. So an entry
 * here has to justify itself in prose, and everything NOT listed here still
 * reaches `HikvisionCamera.handleAlarmEvent`, which reports it.
 *
 * Why the policy is keyed on `(type, state)` and not on `type` alone: for
 * `videoloss` the two states mean opposite things, and collapsing them is how
 * the interesting one got buried. See the entry below.
 *
 * This is the ONE place the decision lives. `subscribeAlarms` consults it
 * before building a `HikvisionAlarmEvent` at all, so an ignored event costs two
 * regex probes instead of a seven-field parse, an object that retains the whole
 * XML payload in `raw`, a channel-id resolution, and a structured log line. To
 * start handling something listed here, delete its entry — nothing else gates
 * it.
 */

/** A `(type, states)` pair the provider never acts on, with its justification. */
interface IgnoredAlarmPolicy {
  /**
   * `eventState` values covered, lowercased. `null` matches an event whose XML
   * carried no `<eventState>` at all. States NOT listed here are NOT ignored.
   */
  readonly states: readonly (string | null)[]
  /** Why dropping this is correct. Surfaced in the periodic count. */
  readonly reason: string
}

const IGNORED_ALARMS: ReadonlyMap<string, IgnoredAlarmPolicy> = new Map([
  [
    'videoloss',
    {
      // `inactive` ONLY. `videoloss`/`active` is the camera reporting that it
      // has actually lost its video signal — a real fault, and the single most
      // useful thing this stream can tell us. It stays out of this list and is
      // surfaced by the camera at `warn`.
      states: ['inactive'],
      reason:
        'alertStream keep-alive: "no video loss" repeated every ~5s by firmware whether or not anything happened. It carries no edge and no state we do not already hold — the stream being alive is already tracked by the idle watchdog, and camera liveness by markOnline(). Measured at 83 200 events / 12 h (116/min) across the fleet, all byte-identical.',
    },
  ],
])

/**
 * The reason this `(type, state)` is deliberately not acted on, or `null` when
 * the event must be delivered.
 *
 * Both arguments are expected lowercased, matching `eventType` / `eventState`
 * as normalised by the alert parser.
 */
export function hikvisionIgnoredAlarmReason(type: string, state: string | null): string | null {
  const policy = IGNORED_ALARMS.get(type)
  if (!policy) return null
  return policy.states.includes(state) ? policy.reason : null
}

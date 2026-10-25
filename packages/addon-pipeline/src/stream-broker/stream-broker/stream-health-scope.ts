/**
 * WHICH streams a health transition is worth telling the operator about.
 *
 * `stream.online` / `stream.offline` are operator-facing: they reach the
 * notification rules and land on a phone. So they must be facts about a
 * CAMERA, and an egress stream is not one — it is the private pipe an exporter
 * asks the broker to build for one consumer session and drops when that session
 * ends. Its whole life is an implementation detail of somebody watching.
 *
 * Measured on this hub 2026-09-13: every Alexa session on the baby monitor
 * produced a `stream.online` and a `stream.offline` pair against
 * `106/egress:8e96e97a…`, and the operator read them as the battery camera
 * flapping during its wake. Nothing was flapping — that is just what an egress
 * pipe does, once per session, by design.
 *
 * The doctrine already existed one layer down: an egress is published with
 * `autoEligible: false` so "a private egress can never become a camera's
 * published stream". It simply had not reached the event path.
 *
 * A DERIVED stream stays in scope (the operator configured it) but its idle
 * state is NOT an outage: the feeder only runs on demand, so the broker starts
 * `_suspended` and health flips land as `suspended`/`resumed` — discarded by
 * NC the same way lazy-dial pulls are. A demanded derived that has never
 * received a packet is also not an outage — the health sweep seeds unhealthy
 * without emitting, so the first packet is `first-packet` (discarded) rather
 * than a `stale-timeout`/`recovered` pair. A true `stale-timeout` after the
 * stream has been healthy while demanded is still news.
 */

/** Private, per-session egress pipes. See {@link healthEventIsOperatorFacing}. */
const PRIVATE_STREAM_PREFIXES = ['egress:'] as const

export function healthEventIsOperatorFacing(camStreamId: string): boolean {
  return !PRIVATE_STREAM_PREFIXES.some((prefix) => camStreamId.startsWith(prefix))
}

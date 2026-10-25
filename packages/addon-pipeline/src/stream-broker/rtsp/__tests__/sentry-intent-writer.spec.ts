/**
 * `withSentryIntent` — the WRITER the sentry path never had.
 *
 * The operator asked for "lo stream sentryMuted": a composite camera whose
 * source is a battery camera must take the SENTRY counterpart of that source's
 * stream instead of the live one, so the composition never becomes the reason
 * a camera wakes up.
 *
 * "sentryMuted" turned out not to be a new intent. `SENTRY_PATH_SUFFIX` already
 * exists. It was ALSO `muted: true` when this spec was first written, and that
 * turned out to be the defect D525 fixed: the mute belonged to the sleeping
 * PLACEHOLDER, not to the path, so a sentry consumer could never receive the
 * camera's audio even once it woke. A sentry now carries audio and is
 * `liveEdgeOnly` instead — which is the property the mute had been standing in
 * for, since every re-clocking consumer happened to be video-only.
 *
 * What this writer had to add is the counterpart of {@link withDetectionIntent} /
 * {@link withRecordingIntent}: a way to turn an ACQUIRED restream url into that
 * dial. Without it a caller had to hand-concatenate, and a hand-concatenated
 * `<token>/muted/sentry` parses back to the token `<token>/muted` — a lookup
 * that finds nothing, silently.
 *
 * The rule these specs exist to hold: whatever goes in, what comes out must
 * parse as `intent: 'sentry'`. That is the ONLY declaration the listen server
 * refuses to warm the broker for (`sentry-never-wakes.spec.ts`), so a url that
 * comes out declaring anything else is a url that wakes a battery camera.
 */
import { describe, expect, it } from 'vitest'
import {
  DETECTION_MUTED_PATH_SUFFIX,
  MUTED_PATH_SUFFIX,
  PRE_ROLL_REQUEST_PREFIX,
  RECORDING_PATH_SUFFIX,
  SENTRY_PATH_SUFFIX,
  parseRestreamPath,
  withSentryIntent,
} from '../restream-intent.js'

const TOKEN = 'c1609d0c9ec63e76852da48e3be1593e'
const BASE = `rtsp://127.0.0.1:8554/${TOKEN}`

/** What the listen server will read off the wire, given a dial url. */
function declarationOf(url: string): ReturnType<typeof parseRestreamPath> {
  return parseRestreamPath(url.slice('rtsp://127.0.0.1:8554/'.length))
}

describe('withSentryIntent', () => {
  it('turns the MUTED variant into the sentry dial — not "/muted/sentry"', () => {
    // The whole point. `<token>/muted/sentry` parses to the token
    // `<token>/muted`, which the registry has never heard of.
    const url = withSentryIntent(`${BASE}${MUTED_PATH_SUFFIX}`)
    expect(url).toBe(`${BASE}${SENTRY_PATH_SUFFIX}`)
    expect(declarationOf(url).lookupPath).toBe(TOKEN)
  })

  it('turns a PLAIN url into the sentry dial', () => {
    expect(withSentryIntent(BASE)).toBe(`${BASE}${SENTRY_PATH_SUFFIX}`)
  })

  it('is idempotent', () => {
    const once = withSentryIntent(`${BASE}${MUTED_PATH_SUFFIX}`)
    expect(withSentryIntent(once)).toBe(once)
  })

  it('replaces a detection dial rather than stacking on it', () => {
    const url = withSentryIntent(`${BASE}${DETECTION_MUTED_PATH_SUFFIX}`)
    expect(url).toBe(`${BASE}${SENTRY_PATH_SUFFIX}`)
    expect(declarationOf(url).declaration.intent).toBe('sentry')
  })

  it('replaces a recording dial rather than stacking on it', () => {
    const url = withSentryIntent(`${BASE}${RECORDING_PATH_SUFFIX}`)
    expect(url).toBe(`${BASE}${SENTRY_PATH_SUFFIX}`)
    expect(declarationOf(url).declaration.intent).toBe('sentry')
  })

  it('DROPS a pre-roll request — there is no history in a still picture', () => {
    // D382: the ask is explicit and absent is zero. Carrying a detection's
    // `PREBUFFER_MAX_MS` over would ask a photograph for four seconds of past.
    const url = withSentryIntent(
      `${BASE}${DETECTION_MUTED_PATH_SUFFIX}${PRE_ROLL_REQUEST_PREFIX}4000`,
    )
    expect(url).not.toContain(PRE_ROLL_REQUEST_PREFIX)
    expect(declarationOf(url).declaration.preRollRequestMs).toBe(0)
  })

  // ── the property that keeps a camera asleep ───────────────────────────
  //
  // `rtsp-listen-server` warms the broker — which DIALS, which on a battery
  // camera is a wake — for every declaration except `sentry`. So the safety of
  // this writer is exactly one claim: everything it emits declares sentry.
  it.each([
    ['plain', BASE],
    ['muted', `${BASE}${MUTED_PATH_SUFFIX}`],
    ['detection', `${BASE}${DETECTION_MUTED_PATH_SUFFIX}`],
    ['detection + preroll', `${BASE}${DETECTION_MUTED_PATH_SUFFIX}${PRE_ROLL_REQUEST_PREFIX}4000`],
    ['recording', `${BASE}${RECORDING_PATH_SUFFIX}`],
    ['recording + preroll', `${BASE}${RECORDING_PATH_SUFFIX}${PRE_ROLL_REQUEST_PREFIX}4000`],
    ['already sentry', `${BASE}${SENTRY_PATH_SUFFIX}`],
  ])('whatever goes in (%s), what comes out declares sentry', (_name, input) => {
    const parsed = declarationOf(withSentryIntent(input))
    expect(parsed.declaration.intent).toBe('sentry')
    // NOT muted: D525 moved the mute onto the placeholder. What must hold is
    // that the declaration is `sentry` — that is what keeps the dial from
    // becoming demand, and demand is what wakes a camera.
    expect(parsed.muted).toBe(false)
    expect(parsed.lookupPath).toBe(TOKEN)
    expect(parsed.declaration.preRollRequestMs).toBe(0)
  })
})

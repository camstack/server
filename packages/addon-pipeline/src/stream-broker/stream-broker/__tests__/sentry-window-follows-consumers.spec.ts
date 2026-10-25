/**
 * The sentry window follows CONSUMERS, not the dial.
 *
 * `checkDemand` has said so in a comment since the feature shipped — "the
 * sentry pump follows CONSUMERS, not intent … it runs whether the camera is
 * up or asleep" — but nothing enforced it: `SentryPump.start` was only ever
 * reached from inside the lazy branch of `start()`, which is a DIAL, and a dial
 * needs live intent. A sentry session has none by construction. So the pump
 * ran only when something ELSE had already woken the camera.
 *
 * Two consequences, both measured on device 106 (Baby monitor) on 2026-09-15:
 *
 *  - `suspend()` stops the pump (`'broker suspended'`) and nothing restarts it.
 *    After the camera went back to sleep at 14:22:40 the still-attached VLC got
 *    neither video nor picture — a dead stream, for ever.
 *  - Once the DESCRIBE warm-up stops dialling for a sentry (which is what
 *    D173 requires, see `sentry-never-wakes.spec.ts`), the dial no longer
 *    happens at all — so if the pump still waited for one, a sentry consumer
 *    would get nothing from the very first frame. The two fixes are one fix.
 *
 * The rule pinned here: while a sentry session is attached and nothing holds
 * live intent, the window is OPEN — asleep, suspended, or freshly attached —
 * and it closes on live intent or on the first real packet.
 */
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'

import { StreamBroker } from '../stream-broker.js'
import { RtspSession } from '../../rtsp/rtsp-session.js'
import type { SentryFrame } from '../sentry-pump.js'
import { planPrestream } from '../sentry-plan.js'

const BROKER_ID = '106/native:main'

/** A complete Annex-B IDR, as the real provider returns. Content is irrelevant
 *  here — what is under test is WHEN it is asked for. */
const FRAME: SentryFrame = {
  annexB: Buffer.from([0, 0, 0, 1, 0x26, 0x01, 0x02, 0x03]),
  codec: 'h265',
}

/** The lazy sentinel the real catalog publishes for a battery camera. */
const LAZY_URL = 'lazy:rfc4571:native%3Amain'

/** The url the publisher hands back once it has MATERIALIZED the socket. */
const REAL_URL = 'tcp://127.0.0.1:39305'

interface Harness {
  readonly broker: StreamBroker
  readonly prepare: ReturnType<typeof vi.fn>
  /** What each `prepare` call decided — a plan, or the named refusal. This is
   *  the outcome the pump acts on, and the only thing that distinguishes "the
   *  window re-opened" from "the window was asked for and refused". */
  readonly outcomes: string[]
  /** Model the publisher: the url the broker resolves RIGHT NOW. */
  setPublishedUrl(url: string): void
}

function makeBroker(): Harness {
  const broker = new StreamBroker(BROKER_ID)
  // The publisher's answer CHANGES over the episode, and that is the whole
  // point. A constant sentinel — which this fake used to return — is the one
  // value production does not have at the moment that matters: after a
  // suspend, the catalog still carries the real socket for ~16 s, until the
  // sleep poll republishes the sentinel. Measured on device 106, 2026-09-16.
  let publishedUrl = LAZY_URL
  const outcomes: string[] = []
  // Through the REAL gate. Returning a frame unconditionally, as this fake used
  // to, skipped `planPrestream` entirely — so the suite could not see a refusal
  // even while the hub was logging one.
  const prepare = vi.fn(async ({ sourceUrl }: { sourceUrl: string }) => {
    const planned = planPrestream({
      sourceUrl,
      // Known geometry and codec: this camera has been probed, so `not-lazy` is
      // the only refusal this fake can produce, which is what keeps the test
      // about the URL and nothing else.
      width: 2304,
      height: 1296,
      codec: 'h265',
    })
    if ('refusal' in planned) {
      outcomes.push(planned.refusal)
      return null
    }
    outcomes.push('plan')
    return FRAME
  })
  broker.setPrestreamProvider({ prepare })
  // The broker knows its source without having dialled it — which is exactly
  // the state a sleeping battery camera is in, and the state in which the
  // window has to be servable.
  broker.setSourceProvider(() => ({
    type: 'rfc4571',
    url: publishedUrl,
    videoCodec: 'h265',
  }))
  return {
    broker,
    prepare,
    outcomes,
    setPublishedUrl: (url) => {
      publishedUrl = url
    },
  }
}

/** Attach a session that declared `sentry` — fed, never intent. */
function attachPrestreamSession(broker: StreamBroker): RtspSession {
  const session = new RtspSession(new Socket(), '', undefined, true, {
    intent: 'sentry',
    preRollRequestMs: 0,
  })
  broker.getRtspRestreamer().addSession(session)
  return session
}

/** The pump prepares asynchronously; let the microtask that starts the timer run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the sentry window follows consumers', () => {
  it('opens when a sentry session attaches to a broker that never dialled', async () => {
    const { broker, prepare } = makeBroker()
    attachPrestreamSession(broker)
    await settle()
    // This is the whole point: no dial happened, and the consumer is still fed.
    expect(prepare).toHaveBeenCalledTimes(1)
    broker.stop()
  })

  it('does NOT open for a session that holds live intent — it would paint over real media', async () => {
    const { broker, prepare } = makeBroker()
    const session = new RtspSession(new Socket(), '', undefined, false, {
      intent: null,
      preRollRequestMs: 0,
    })
    broker.getRtspRestreamer().addSession(session)
    await settle()
    expect(prepare).not.toHaveBeenCalled()
    broker.stop()
  })

  it('closes when the last sentry session leaves', async () => {
    const { broker } = makeBroker()
    const session = attachPrestreamSession(broker)
    await settle()
    broker.getRtspRestreamer().removeSession(session.getSessionId())
    await settle()
    expect(broker.wantsPrestream()).toBe(false)
    broker.stop()
  })

  // THE REGRESSION, on the real path: the camera woke on a configured signal,
  // served real media, and went back to sleep under a consumer that never
  // left. Before this, `suspend()` stopped the pump and only a dial could
  // restart one — and a sentry session never dials, so that consumer saw
  // black for ever.
  it('re-opens after the camera goes back to sleep, for a consumer that stayed', async () => {
    vi.useFakeTimers()
    try {
      const { broker, prepare, outcomes, setPublishedUrl } = makeBroker()
      attachPrestreamSession(broker)
      await vi.advanceTimersByTimeAsync(1)
      expect(prepare).toHaveBeenCalledTimes(1)

      // A configured signal woke the camera: something with LIVE intent joins.
      // The window closes — a still picture must never cover real media.
      const live = new RtspSession(new Socket(), '', undefined, false, {
        intent: null,
        preRollRequestMs: 0,
      })
      broker.getRtspRestreamer().addSession(live)
      await vi.advanceTimersByTimeAsync(1)
      expect(broker.wantsPrestream()).toBe(false)

      // …and the publisher MATERIALIZED the socket, so the catalog now carries
      // a real tcp url instead of the sentinel. This is the state the broker is
      // in for the whole of the rest of this test.
      setPublishedUrl(REAL_URL)

      // The hold expires and the live consumer goes: the broker suspends after
      // its grace period, and the camera is asleep again.
      broker.getRtspRestreamer().removeSession(live.getSessionId())
      await vi.advanceTimersByTimeAsync(6_000)

      // The sentry session never went anywhere, so it is owed a picture.
      expect(broker.wantsPrestream()).toBe(true)
      expect(prepare.mock.calls.length).toBeGreaterThanOrEqual(2)
      // AND the picture has to be BUILDABLE. Asking is not feeding: the url the
      // window is re-opened with must still describe a lazy source, or the plan
      // refuses `not-lazy` and the consumer gets a call that produces nothing.
      // Measured on device 106 at 18:13:10 — `sentry: refused — the window
      // goes unfilled`, with the operator's client attached and dark until it
      // gave up ten seconds later.
      expect(outcomes.at(-1)).toBe('plan')
      broker.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

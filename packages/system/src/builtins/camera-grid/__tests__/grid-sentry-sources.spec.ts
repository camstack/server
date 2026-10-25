/**
 * A grid never wakes a battery camera.
 *
 * The operator: *"Per le camere a batteria utilizza direttamente lo stream
 * sentryMuted"*. The broker answers whether a camera is offered a sentry dial
 * (`sentryEligible` — a BATTERY camera that DECLARES the signals cap), and it
 * answers it ON the acquisition, as `sentryUrl`. So this module has exactly one
 * rule, and the rule is: an offered sentry is TAKEN.
 *
 * The temptation it exists to refuse is the fallback. "Use the sentry if the
 * camera is asleep, otherwise the live stream" reads reasonable and is the
 * wake: whether a battery camera is asleep RIGHT NOW is a fact that changes
 * between the read and the dial, and the dial is what wakes it.
 */
import { describe, expect, it } from 'vitest'
import { gridSourceDial } from '../grid-sentry-sources.js'

const LIVE = 'rtsp://127.0.0.1:8554/tok/muted'
const SENTRY = 'rtsp://127.0.0.1:8554/tok/sentry'

describe('gridSourceDial', () => {
  it('takes the SENTRY dial whenever the broker offers one', () => {
    expect(gridSourceDial({ url: LIVE, sentryUrl: SENTRY, pipelineKey: 'pk' })).toEqual({
      url: SENTRY,
      pipelineKey: 'pk',
      mode: 'sentry',
    })
  })

  it('takes the LIVE dial when the broker offers no sentry', () => {
    expect(gridSourceDial({ url: LIVE, sentryUrl: null, pipelineKey: 'pk' })).toEqual({
      url: LIVE,
      pipelineKey: 'pk',
      mode: 'live',
    })
  })

  it('treats an ABSENT answer as no sentry — a broker that never answered offers nothing', () => {
    expect(gridSourceDial({ url: LIVE, pipelineKey: 'pk' }).mode).toBe('live')
  })

  it('treats an EMPTY sentry url as no sentry rather than dialling ""', () => {
    expect(gridSourceDial({ url: LIVE, sentryUrl: '', pipelineKey: 'pk' }).mode).toBe('live')
  })

  it('never returns the live url once a sentry was offered — no sleep check, no fallback', () => {
    // Whether the camera is asleep right now is not asked, anywhere. It is a
    // fact that changes between the read and the dial, and the dial is the wake.
    const dial = gridSourceDial({ url: LIVE, sentryUrl: SENTRY, pipelineKey: 'pk' })
    expect(dial.url).not.toBe(LIVE)
  })

  it('keeps the pipeline key of the ACQUISITION — that is what releases the refcount', () => {
    // The sentry is a different PATH on the same acquired stream. Releasing a
    // key the broker never issued leaks a source dialled with nobody watching.
    expect(
      gridSourceDial({ url: LIVE, sentryUrl: SENTRY, pipelineKey: 'pk-611' }).pipelineKey,
    ).toBe('pk-611')
  })
})

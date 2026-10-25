/**
 * The SENTRY dial — one per profile, alongside `/muted`.
 *
 * A consumer dials `<token>/sentry` to ask for the STREAM without asking for
 * the CAMERA. It is what lets a continuous-pull client hold a session open for
 * ever against a battery camera without keeping it awake: the session is fed,
 * it is not intent, and only a signal the camera itself reports wakes anything.
 */
import { describe, expect, it } from 'vitest'
import { MUTED_PATH_SUFFIX, SENTRY_PATH_SUFFIX, parseRestreamPath } from '../restream-intent.js'

const TOKEN = 'c1609d0c9ec63e76852da48e3be1593e'

describe('parseRestreamPath — the sentry counterpart', () => {
  it('resolves to the profile’s own token, with the intent declared', () => {
    const parsed = parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`)
    expect(parsed.lookupPath).toBe(TOKEN)
    expect(parsed.declaration.intent).toBe('sentry')
  })

  it('is NOT muted — the mute belonged to the placeholder, not to the path', () => {
    // This spec used to pin the opposite, on the reasoning that "an m=audio
    // nobody fills stalls the consumer, and for the hours a camera may sit in
    // sentry nobody fills it". Right about the hazard, wrong about the remedy:
    // the track is FILLED — silence while the picture is served, the camera's
    // own audio the instant media flows (D525). Deciding it here decided it
    // once, from a string, and RTSP cannot renegotiate — so `true` meant a
    // sentry consumer could never receive audio, awake or asleep.
    expect(parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`).muted).toBe(false)
  })

  it('asks for NO history — there is none in a still picture', () => {
    expect(parseRestreamPath(`${TOKEN}${SENTRY_PATH_SUFFIX}`).declaration.preRollRequestMs).toBe(0)
  })

  it('an ordinary dial is UNCHANGED — an unstated ask is zero (D382)', () => {
    // The whole safety of this feature: a consumer that was given the plain URL
    // keeps live intent and behaves exactly as it always has.
    const plain = parseRestreamPath(TOKEN)
    expect(plain.lookupPath).toBe(TOKEN)
    // `null` and not absent: the parser states that nothing was declared,
    // which is a different fact from a field nobody filled in.
    expect(plain.declaration.intent).toBeNull()
    expect(plain.muted).toBe(false)
  })

  it('does not collide with /muted', () => {
    const muted = parseRestreamPath(`${TOKEN}${MUTED_PATH_SUFFIX}`)
    expect(muted.declaration.intent).toBeNull()
    expect(muted.muted).toBe(true)
  })
})

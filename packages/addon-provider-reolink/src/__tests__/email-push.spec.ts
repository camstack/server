import { describe, it, expect } from 'vitest'
import {
  mapInferredTypeToSimpleEvents,
  DEFAULT_EMAIL_PUSH_PORT,
  DEFAULT_EMAIL_PUSH_DOMAIN,
} from '../email-push-shared'

/**
 * Email-push classifier → ReolinkSimpleEvent type mapping.
 *
 * The lib classifies an inbound motion email into one of
 * motion|people|vehicle|animal|face|package|doorbell|other. The provider
 * must turn each into `ReolinkSimpleEvent.type`s that the camera's unified
 * `handleSimpleEvent` understands — and CRUCIALLY must never drop a wake.
 *
 * "Never drop a wake" is not a slogan here, it is the whole point of the
 * SMTP path: an email is the ONLY signal a sleeping battery camera can
 * send, and every mapped type must therefore reach the motion bus.
 * `handleSimpleEvent` emits `ProviderMotion` for `motion` and for
 * every AI class — but for `doorbell` it emits ONLY `DoorbellOnPressed`.
 * So a doorbell-classified email mapped to `doorbell` ALONE would ring the
 * doorbell and leave motion, recording and notification rules blind.
 */
describe('mapInferredTypeToSimpleEvents', () => {
  it('passes AI subtypes through verbatim', () => {
    expect(mapInferredTypeToSimpleEvents('people')).toEqual(['people'])
    expect(mapInferredTypeToSimpleEvents('vehicle')).toEqual(['vehicle'])
    expect(mapInferredTypeToSimpleEvents('animal')).toEqual(['animal'])
    expect(mapInferredTypeToSimpleEvents('face')).toEqual(['face'])
    expect(mapInferredTypeToSimpleEvents('package')).toEqual(['package'])
  })

  it('passes motion through verbatim', () => {
    expect(mapInferredTypeToSimpleEvents('motion')).toEqual(['motion'])
  })

  it('pairs doorbell with motion, because the doorbell branch emits no motion', () => {
    expect(mapInferredTypeToSimpleEvents('doorbell')).toEqual(['doorbell', 'motion'])
  })

  it('collapses unknown/other to motion so no wake is dropped', () => {
    expect(mapInferredTypeToSimpleEvents('other')).toEqual(['motion'])
  })

  it('always yields at least one event that reaches the motion bus', () => {
    const all = [
      'motion',
      'people',
      'vehicle',
      'animal',
      'face',
      'package',
      'doorbell',
      'other',
    ] as const
    for (const inferred of all) {
      const types = mapInferredTypeToSimpleEvents(inferred)
      expect(types.length).toBeGreaterThan(0)
      // `doorbell` is the ONLY type `handleSimpleEvent` handles without
      // emitting motion — so it must never be the whole answer.
      expect(types.some((t) => t !== 'doorbell')).toBe(true)
    }
  })
})

/**
 * Email-push shared defaults. These constants are the contract between
 * the settings schema, the SMTP server config, and the per-camera
 * Auto-configure flow — they must stay aligned with the camera's email
 * config so RCPT routing matches.
 */
describe('email-push defaults', () => {
  it('uses a non-privileged default SMTP port', () => {
    expect(DEFAULT_EMAIL_PUSH_PORT).toBeGreaterThan(1024)
  })

  it('uses a non-resolvable virtual domain', () => {
    // `.local` keeps the domain off public DNS — it's only ever parsed
    // out of the recipient, never resolved.
    expect(DEFAULT_EMAIL_PUSH_DOMAIN.endsWith('.local')).toBe(true)
  })
})

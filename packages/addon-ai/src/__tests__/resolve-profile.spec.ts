import type { LlmDefault, LlmProfile } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { nextFallbackProfile, resolveProfile } from '../resolve-profile.js'
import { makeProfile } from './support/profile.js'

function profile(id: string, overrides: Record<string, unknown> = {}): LlmProfile {
  return makeProfile({ id, name: id, model: 'm', baseUrl: 'http://x/v1', ...overrides })
}

describe('resolveProfile', () => {
  it('explicit profileId wins over any default', () => {
    const out = resolveProfile(
      [profile('a'), profile('b')],
      [{ selector: { purpose: 'text' }, profileId: 'b' }],
      {
        profileId: 'a',
        consumer: 'c',
        purpose: 'text',
      },
    )
    expect(out.ok && out.profile.id).toBe('a')
  })

  it('unknown explicit id → no-profile naming the id', () => {
    const out = resolveProfile([profile('a')], [], {
      profileId: 'zzz',
      consumer: 'c',
      purpose: 'text',
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.err.code).toBe('no-profile')
      expect(out.err.message).toContain('zzz')
    }
  })

  it('disabled explicit id → no-profile', () => {
    const out = resolveProfile([profile('a', { enabled: false })], [], {
      profileId: 'a',
      consumer: 'c',
      purpose: 'text',
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.err.code).toBe('no-profile')
  })

  it('explicit non-vision profile for a vision purpose → bad-request', () => {
    const out = resolveProfile([profile('a', { supportsVision: false })], [], {
      profileId: 'a',
      consumer: 'c',
      purpose: 'vision',
    })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.err.code).toBe('bad-request')
  })

  it('consumer default beats purpose default', () => {
    const out = resolveProfile(
      [profile('a'), profile('b')],
      [
        { selector: { consumer: 'c' }, profileId: 'a' },
        { selector: { purpose: 'text' }, profileId: 'b' },
      ],
      { consumer: 'c', purpose: 'text' },
    )
    expect(out.ok && out.profile.id).toBe('a')
  })

  it('purpose default used when no consumer default', () => {
    const out = resolveProfile(
      [profile('a'), profile('b')],
      [{ selector: { purpose: 'text' }, profileId: 'b' }],
      {
        consumer: 'c',
        purpose: 'text',
      },
    )
    expect(out.ok && out.profile.id).toBe('b')
  })

  it('chain skips disabled / non-vision profiles and falls through', () => {
    const defaults: LlmDefault[] = [
      { selector: { consumer: 'c' }, profileId: 'a' },
      { selector: { purpose: 'vision' }, profileId: 'v' },
    ]
    const out = resolveProfile(
      [profile('a', { supportsVision: false }), profile('v', { supportsVision: true })],
      defaults,
      { consumer: 'c', purpose: 'vision' },
    )
    expect(out.ok && out.profile.id).toBe('v')
  })

  it('nothing matches → no-profile mentioning the consumer', () => {
    const out = resolveProfile([], [], { consumer: 'lonely', purpose: 'text' })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.err.code).toBe('no-profile')
      expect(out.err.message).toContain('lonely')
    }
  })

  it('a default row pointing at a deleted profile is skipped', () => {
    const out = resolveProfile(
      [profile('b')],
      [
        { selector: { consumer: 'c' }, profileId: 'gone' },
        { selector: { purpose: 'text' }, profileId: 'b' },
      ],
      { consumer: 'c', purpose: 'text' },
    )
    expect(out.ok && out.profile.id).toBe('b')
  })
})

describe('nextFallbackProfile', () => {
  const defaults: LlmDefault[] = [
    { selector: { consumer: 'c' }, profileId: 'consumer' },
    { selector: { purpose: 'text' }, profileId: 'purpose' },
  ]
  const all = [profile('explicit'), profile('consumer'), profile('purpose')]

  it('after the consumer default, the purpose default, then nothing', () => {
    const input = { consumer: 'c', purpose: 'text' } as const
    expect(nextFallbackProfile(all, defaults, input, new Set())?.id).toBe('consumer')
    expect(nextFallbackProfile(all, defaults, input, new Set(['consumer']))?.id).toBe('purpose')
    expect(nextFallbackProfile(all, defaults, input, new Set(['consumer', 'purpose']))).toBeNull()
  })

  it('skips a disabled or vision-incapable candidate rather than returning it', () => {
    const profiles = [
      profile('consumer', { enabled: false }),
      profile('purpose', { supportsVision: false }),
    ]
    const visionDefaults: LlmDefault[] = [
      { selector: { consumer: 'c' }, profileId: 'consumer' },
      { selector: { purpose: 'vision' }, profileId: 'purpose' },
    ]
    expect(
      nextFallbackProfile(
        profiles,
        visionDefaults,
        { consumer: 'c', purpose: 'vision' },
        new Set(),
      ),
    ).toBeNull()
  })
})

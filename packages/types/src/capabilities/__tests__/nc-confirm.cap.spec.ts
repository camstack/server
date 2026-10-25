/**
 * The AI CONFIRM gate's rule schema.
 *
 * A gate that decides whether a notification is delivered has exactly one
 * dangerous default: closed. Every absent field here must therefore read as
 * "behave as before" — off, and fail-OPEN when it cannot answer.
 */
import { describe, expect, it } from 'vitest'
import {
  NC_CONFIRM_DEFAULT_MAX_IMAGE_PX,
  NC_CONFIRM_DEFAULT_TIMEOUT_MS,
  NC_CONFIRM_MAX_TIMEOUT_MS,
  NC_CONFIRM_MIN_TIMEOUT_MS,
  NcConfirmSchema,
  NcRuleInputSchema,
  NcRulePatchSchema,
} from '../notification-rules.cap.js'

function rule(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'parking',
    delivery: 'immediate',
    targets: [{ targetId: 't1' }],
    ...over,
  }
}

describe('NcConfirmSchema', () => {
  it('is absent by default — an existing rule is untouched', () => {
    expect(NcRuleInputSchema.parse(rule()).confirm).toBeUndefined()
  })

  it('defaults to OFF, fail-open, 8 s and 448 px', () => {
    const parsed = NcConfirmSchema.parse({})
    expect(parsed.enabled).toBe(false)
    expect(parsed.onTimeout).toBe('fire')
    expect(parsed.timeoutMs).toBe(NC_CONFIRM_DEFAULT_TIMEOUT_MS)
    expect(parsed.maxImagePx).toBe(NC_CONFIRM_DEFAULT_MAX_IMAGE_PX)
  })

  it('carries an expectation over a counted class', () => {
    const parsed = NcRuleInputSchema.parse(
      rule({ confirm: { enabled: true, expect: { op: '>=', count: 1 } } }),
    )
    expect(parsed.confirm).toMatchObject({ enabled: true, expect: { op: '>=', count: 1 } })
  })

  it('refuses a timeout outside the clamp — an unbounded gate holds the alarm', () => {
    expect(NcConfirmSchema.safeParse({ timeoutMs: NC_CONFIRM_MIN_TIMEOUT_MS - 1 }).success).toBe(
      false,
    )
    expect(NcConfirmSchema.safeParse({ timeoutMs: NC_CONFIRM_MAX_TIMEOUT_MS + 1 }).success).toBe(
      false,
    )
    expect(NcConfirmSchema.safeParse({ timeoutMs: NC_CONFIRM_MAX_TIMEOUT_MS }).success).toBe(true)
  })

  it('accepts an explicit profile and operator prompt', () => {
    const parsed = NcConfirmSchema.parse({
      enabled: true,
      profileId: 'mac-lmstudio-qwen3vl',
      prompt: 'Is a car parked in the marked bay?',
    })
    expect(parsed.profileId).toBe('mac-lmstudio-qwen3vl')
    expect(parsed.prompt).toBe('Is a car parked in the marked bay?')
  })

  it('rides through the patch schema so a rule can be edited into (and out of) the gate', () => {
    expect(NcRulePatchSchema.parse({ confirm: { enabled: true } }).confirm?.enabled).toBe(true)
    expect(NcRulePatchSchema.parse({}).confirm).toBeUndefined()
  })
})

/**
 * A PATCH says only what changed. `NcRuleStore.update` merges it over the
 * stored rule with `{ ...existing, ...patch }`, so any key the patch
 * materialises OVERWRITES — and Zod's `.partial()` does NOT remove a field's
 * `.default()`: an absent key still comes out of the parse carrying it.
 *
 * That made every partial edit destructive. Toggling a rule's enabled flag,
 * flipping one target's opt-out, or changing a cooldown reset `conditions` to
 * `{}` — a rule scoped to one camera and one zone silently became a rule that
 * matches EVERYTHING — and reset `media` (losing zoneCrop/gif/clip) and
 * `priority`. Found live: a rule scoped to device 102 fired on 104 and 101
 * within a minute of a two-field patch.
 */
describe('NcRulePatchSchema — a patch materialises nothing it was not given', () => {
  it('emits ONLY the keys the caller sent', () => {
    const patch = NcRulePatchSchema.parse({ throttle: { cooldownSec: 60, scope: 'rule-device' } })
    expect(Object.keys(patch)).toEqual(['throttle'])
  })

  it.each(['enabled', 'conditions', 'media', 'priority'] as const)('never invents %s', (field) => {
    expect(NcRulePatchSchema.parse({ name: 'x' })).not.toHaveProperty(field)
  })

  it('still applies INNER defaults to a field the caller did send', () => {
    // `{}` for conditions is a real instruction ("clear the conditions") and
    // must keep working; only the ABSENT key is left absent.
    const patch = NcRulePatchSchema.parse({ media: { attach: 'best' }, conditions: {} })
    expect(patch.conditions).toEqual({})
    expect(patch.media?.attach).toBe('best')
    const throttled = NcRulePatchSchema.parse({ throttle: { cooldownSec: 5 } })
    expect(throttled.throttle).toEqual({ cooldownSec: 5, scope: 'rule-device' })
  })

  it('leaves a full-object patch untouched (the viewer editor still saves)', () => {
    const full = NcRulePatchSchema.parse({
      name: 'r',
      enabled: false,
      delivery: 'immediate',
      conditions: { devices: [102] },
      targets: [{ targetId: 't1' }],
      media: { attach: 'keyFrame', zoneCrop: true },
      throttle: { cooldownSec: 30, scope: 'rule' },
      priority: 5,
    })
    expect(full.conditions?.devices).toEqual([102])
    expect(full.media?.zoneCrop).toBe(true)
    expect(full.priority).toBe(5)
    expect(full.enabled).toBe(false)
  })
})

/**
 * #459: whether an HA lock / alarm panel needs a PIN is the slice's
 * `codeRequired`, never a device feature. Unknown is `null` (D393), never false.
 */
import { describe, expect, it } from 'vitest'
import { haAlarmCodeRequired, haLockCodeRequired } from '../ha-code-required.js'
import { mapHaEntityToCamStack } from '../ha-domain-mapping.js'

describe('haLockCodeRequired', () => {
  it('a code_format pattern means a PIN is required', () => {
    expect(haLockCodeRequired({ code_format: '^\\d{4}$' })).toBe(true)
  })
  it('HA omits code_format on a lock that takes no code, so absent is false', () => {
    expect(haLockCodeRequired({})).toBe(false)
    expect(haLockCodeRequired({ code_format: null })).toBe(false)
  })
})

describe('haAlarmCodeRequired', () => {
  it('a code_format pattern means a PIN is required', () => {
    expect(haAlarmCodeRequired({ code_format: 'number' })).toBe(true)
  })
  it('an explicit null code_format means no PIN', () => {
    expect(haAlarmCodeRequired({ code_format: null })).toBe(false)
  })
  it('HA always sends code_format for a panel: absent means unknown, null — never false', () => {
    expect(haAlarmCodeRequired({})).toBeNull()
  })
})

describe('the mapping no longer hand-sets PIN features', () => {
  it('a PIN lock maps with no lock-pin-required feature', () => {
    const m = mapHaEntityToCamStack({
      domain: 'lock',
      deviceClass: null,
      attributes: { code_format: '^\\d{4}$' },
    })
    expect(m?.features).not.toContain('lock-pin-required')
  })
  it('a PIN alarm panel maps with no alarm-pin-required feature', () => {
    const m = mapHaEntityToCamStack({
      domain: 'alarm_control_panel',
      deviceClass: null,
      attributes: { code_format: 'number' },
    })
    expect(m?.features).not.toContain('alarm-pin-required')
  })
})

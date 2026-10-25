import { describe, it, expect } from 'vitest'
import { bareAddonId, isSameAddonId } from '../addon-id.js'

describe('bareAddonId — the two context factories do not agree on ctx.id', () => {
  it('strips the hub-main `addon:` prefix', () => {
    expect(bareAddonId('addon:composer')).toBe('composer')
  })

  it('leaves a forked addon id untouched', () => {
    expect(bareAddonId('composer')).toBe('composer')
  })

  it('strips only a LEADING prefix — an id containing the token is not mangled', () => {
    expect(bareAddonId('provider-addon:x')).toBe('provider-addon:x')
  })

  it('is idempotent', () => {
    expect(bareAddonId(bareAddonId('addon:device-manager'))).toBe('device-manager')
  })

  it('isSameAddonId equates the prefixed and the bare spelling, in both directions', () => {
    expect(isSameAddonId('addon:composer', 'composer')).toBe(true)
    expect(isSameAddonId('composer', 'addon:composer')).toBe(true)
    expect(isSameAddonId('addon:composer', 'addon:composer')).toBe(true)
    expect(isSameAddonId('composer', 'composer')).toBe(true)
  })

  it('isSameAddonId still separates two genuinely different addons', () => {
    expect(isSameAddonId('addon:composer', 'device-manager')).toBe(false)
    expect(isSameAddonId('addon:snapshot', 'addon:composer')).toBe(false)
  })
})

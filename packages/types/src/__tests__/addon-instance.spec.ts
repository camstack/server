import { describe, expect, it } from 'vitest'
import {
  isAddonInstanceId,
  oauthLinkInstanceId,
  oauthLinkServesInstance,
} from '../addon/addon-instance.js'

describe('oauthLinkServesInstance', () => {
  it('lets a link to an instance serve only that instance', () => {
    expect(oauthLinkServesInstance({ instanceId: 'second' }, 'second', 'export-x')).toBe(true)
    expect(oauthLinkServesInstance({ instanceId: 'second' }, 'third', 'export-x')).toBe(false)
  })

  it('refuses a link to an instance on the address of the default one', () => {
    expect(oauthLinkServesInstance({ instanceId: 'second' }, undefined, 'export-x')).toBe(false)
    expect(oauthLinkServesInstance({ instanceId: 'second' }, 'export-x', 'export-x')).toBe(false)
  })

  it('refuses a link with no instance on the address of another instance', () => {
    expect(oauthLinkServesInstance({}, 'second', 'export-x')).toBe(false)
  })

  it('reads a link with no instance as the default one, however the request spells it', () => {
    expect(oauthLinkServesInstance({}, undefined, 'export-x')).toBe(true)
    expect(oauthLinkServesInstance({}, 'export-x', 'export-x')).toBe(true)
    expect(oauthLinkServesInstance({ instanceId: null }, 'export-x', 'export-x')).toBe(true)
    expect(oauthLinkInstanceId({}, 'export-x')).toBe('export-x')
  })
})

describe('isAddonInstanceId', () => {
  it('accepts a plain id and nothing that could change a path', () => {
    expect(isAddonInstanceId('second_1.a-b')).toBe(true)
    expect(isAddonInstanceId('')).toBe(false)
    expect(isAddonInstanceId('a/b')).toBe(false)
    expect(isAddonInstanceId('a%2Fb')).toBe(false)
    expect(isAddonInstanceId('x'.repeat(65))).toBe(false)
  })
})

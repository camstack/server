/**
 * The email target's provider picker keeps the relay's verification tri-state (D315): an entry that
 * has not sent yet is "not checked yet", and only one whose last send FAILED reads "not verified".
 */
import { describe, expect, it } from 'vitest'
import { smtpProviderOption } from '../adapters/email.js'

describe('smtpProviderOption', () => {
  it('a verified entry carries no suffix', () => {
    expect(smtpProviderOption('smtp', 'Mail', { ready: true, verified: true, host: 'h' })).toEqual({
      value: 'smtp',
      label: 'Mail — h',
      description: 'smtp',
      ready: true,
      verified: true,
    })
  })

  it('an entry that has not sent yet is unknown, never "not verified"', () => {
    const option = smtpProviderOption('smtp', 'Mail', { ready: false, host: 'h' })
    expect(option.label).toBe('Mail — h (not checked yet)')
    expect(option.verified).toBeUndefined()
  })

  it('an entry whose last send failed is "not verified"', () => {
    const option = smtpProviderOption('smtp', 'Mail', { ready: false, verified: false, host: '' })
    expect(option.label).toBe('Mail — smtp (not verified)')
    expect(option.verified).toBe(false)
  })
})

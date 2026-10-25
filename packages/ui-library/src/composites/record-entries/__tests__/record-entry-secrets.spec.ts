import { REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { isRedactedSecret, mergeSecretForSubmit, secretDisplayValue } from '../record-entry-secrets'

describe('record entry secrets', () => {
  it('keeps the redaction token when the password box is left empty', () => {
    expect(secretDisplayValue(REDACTED_SECRET)).toBe('')
    expect(mergeSecretForSubmit('', REDACTED_SECRET)).toBe(REDACTED_SECRET)
  })

  it('sends a new string when the operator replaces a stored secret', () => {
    expect(mergeSecretForSubmit('new-pass', REDACTED_SECRET)).toBe('new-pass')
    expect(isRedactedSecret(REDACTED_SECRET)).toBe(true)
  })
})

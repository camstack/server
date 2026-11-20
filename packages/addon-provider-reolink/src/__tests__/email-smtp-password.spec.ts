import { describe, expect, it } from 'vitest'
import { smtpPasswordToWrite } from '../email-smtp-password.js'
import { reolinkCameraSchema } from '../schema.js'

describe('the camera SMTP password is a declared per-device secret', () => {
  it('emailPassword is declared secret by schema type (keychain-backed, like password)', () => {
    expect(reolinkCameraSchema.shape.emailPassword.meta()?.['secret']).toBe(true)
    expect(reolinkCameraSchema.shape.password.meta()?.['secret']).toBe(true)
  })

  it('writes only a real value: blank keeps, a marker echo is not a write', () => {
    expect(smtpPasswordToWrite('s3cret')).toBe('s3cret')
    expect(smtpPasswordToWrite('')).toBeNull()
    expect(smtpPasswordToWrite(undefined)).toBeNull()
    expect(smtpPasswordToWrite({ $secret: 'secret://a/b/c', v: 1 })).toBeNull()
  })
})

import { isSecretMarker } from '@camstack/types'

/**
 * The camera SMTP password an operator wrote on the Email tab, when it is a real value to push
 * to the camera and keep: a non-empty string that is not a keychain marker. Blank means "keep
 * the stored one" and a marker is the form echoing back what it was shown; neither is a write.
 */
export function smtpPasswordToWrite(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return isSecretMarker(value) ? null : value
}

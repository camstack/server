import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isPasskeyAuthenticationOptions(
  wire: unknown,
): wire is PublicKeyCredentialRequestOptionsJSON {
  return isRecord(wire) && typeof wire.challenge === 'string'
}

export function isPasskeyRegistrationOptions(
  wire: unknown,
): wire is PublicKeyCredentialCreationOptionsJSON {
  return isRecord(wire) && typeof wire.challenge === 'string'
}

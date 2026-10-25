/**
 * Passkey (WebAuthn) browser-ceremony helpers — OWNED BY THE ADDON.
 *
 * WebAuthn is a W3C standard (`navigator.credentials`); the browser step
 * (turn server-issued options JSON → a credential assertion/attestation
 * JSON) is protocol-standard. This module wraps `@simplewebauthn/browser`
 * so the dependency lives ENTIRELY inside `@camstack/addon-auth` — the
 * admin shell and `@camstack/ui-library` carry NO WebAuthn knowledge. The
 * ceremony ships as a Module-Federation widget bundle (`passkey-login` /
 * `passkey-enrollment`), lazy-loaded by the host — pre-auth via the
 * public `auth.listLoginMethods` login-method channel, post-auth via the
 * normal widget registry.
 *
 * Both helpers take/return plain JSON records so callers stay free of the
 * WebAuthn structural types: the hub serves options as an opaque
 * `z.record` (produced by `@simplewebauthn/server`) and expects the
 * response back as JSON. The single documented `via an unsafe cast to` casts are
 * that server-JSON ↔ browser-API boundary (the ONLY sanctioned cast in
 * this module, matching the addon's server-side `via an unsafe cast to` in
 * `auth-webauthn.addon.ts`).
 */
import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
} from '@simplewebauthn/browser'
/** `true` when the browser exposes the WebAuthn API at all (feature-gate the UI). */
export function isPasskeySupported(): boolean {
  return browserSupportsWebAuthn()
}

/**
 * Run the AUTHENTICATION ceremony (login): server options JSON in, a
 * credential-assertion JSON out (ready to POST back for verification).
 */
type StartAuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON']
type StartRegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON']

/** Server JSON → browser API at the wire boundary (see file header). */
function authOptionsFromWire(wire: Record<string, unknown>): StartAuthenticationOptions {
  return { ...wire, challenge: wire.challenge as string } as StartAuthenticationOptions
}

function registrationOptionsFromWire(wire: Record<string, unknown>): StartRegistrationOptions {
  return { ...wire, challenge: wire.challenge as string } as StartRegistrationOptions
}

export async function runPasskeyAuthentication(
  optionsJSON: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof optionsJSON.challenge !== 'string') {
    throw new Error('passkey authentication options missing challenge')
  }
  const wire = authOptionsFromWire(optionsJSON)
  const assertion = await startAuthentication({ optionsJSON: wire })
  return Object.fromEntries(Object.entries(assertion))
}

/**
 * Run the REGISTRATION ceremony (enrollment): server options JSON in, a
 * credential-attestation JSON out.
 */
export async function runPasskeyRegistration(
  optionsJSON: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof optionsJSON.challenge !== 'string') {
    throw new Error('passkey registration options missing challenge')
  }
  const wire = registrationOptionsFromWire(optionsJSON)
  const attestation = await startRegistration({ optionsJSON: wire })
  return Object.fromEntries(Object.entries(attestation))
}

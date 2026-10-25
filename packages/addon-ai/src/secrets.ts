/**
 * Profile secret discipline (spec §5) — the addon-notifiers `secrets.ts`
 * semantics over the kind's ONE secret field, `providerConfig[secretFieldOf(kind)]`
 * (D893): a stored key NEVER round-trips to a client (redacted to the marker
 * on read), and a write-side merge keeps the stored key when the marker is
 * untouched (or the field is absent), and clears the key on an empty string.
 */
import type { LlmProfile } from '@camstack/types'
import { secretFieldOf } from './kinds/provider-config.js'

/** Same marker as addon-notifiers/src/secrets.ts — UI contract. */
export const REDACTED_MARKER = '__redacted__'

function isPresentSecret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** The profile's secret value, if its kind has one and it is set. */
export function profileSecretOf(profile: LlmProfile): string | undefined {
  const field = secretFieldOf(profile.kind)
  if (field === null) return undefined
  const value = profile.providerConfig[field]
  return isPresentSecret(value) && value !== REDACTED_MARKER ? value : undefined
}

function withSecret(profile: LlmProfile, value: string | undefined): LlmProfile {
  const field = secretFieldOf(profile.kind)
  if (field === null) return profile
  const { [field]: _drop, ...rest } = profile.providerConfig
  return {
    ...profile,
    providerConfig: value === undefined ? rest : { ...rest, [field]: value },
  }
}

/** Wire-read redaction: a stored key NEVER round-trips to a client. */
export function redactProfileForRead(profile: LlmProfile): LlmProfile {
  const field = secretFieldOf(profile.kind)
  if (field === null || !isPresentSecret(profile.providerConfig[field])) return profile
  return withSecret(profile, REDACTED_MARKER)
}

/** A stored secret shows as set even when its value cannot be read right now. */
export function markSecretSet(profile: LlmProfile): LlmProfile {
  return secretFieldOf(profile.kind) === null ? profile : withSecret(profile, REDACTED_MARKER)
}

/** The incoming secret leaves the stored one as it is (absent or the marker). */
export function keepsStoredSecret(profile: LlmProfile): boolean {
  const field = secretFieldOf(profile.kind)
  if (field === null) return true
  const incoming = profile.providerConfig[field]
  return incoming === undefined || incoming === REDACTED_MARKER
}

/** Write-side merge (the notifiers mergeSecrets semantics over the kind's field). */
export function mergeProfileSecrets(existing: LlmProfile | null, incoming: LlmProfile): LlmProfile {
  const field = secretFieldOf(incoming.kind)
  if (field === null) return incoming
  const value = incoming.providerConfig[field]
  if (value === REDACTED_MARKER || value === undefined) {
    // A kind change never inherits the old kind's key.
    const prior =
      existing !== null && existing.kind === incoming.kind ? profileSecretOf(existing) : undefined
    return withSecret(incoming, prior)
  }
  if (value === '' || typeof value !== 'string') return withSecret(incoming, undefined)
  return incoming
}

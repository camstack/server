/**
 * Pure profile resolution chain (spec §3): explicit `profileId` → per-consumer
 * default → per-purpose default → `no-profile`. An explicit id that exists but
 * is unusable for the required purpose is a CALLER error (`bad-request`), not
 * "nothing configured".
 */
import type { LlmDefault, LlmGenerateErr, LlmProfile } from '@camstack/types'

export type LlmPurpose = 'text' | 'vision'

export type ResolveOutcome =
  | { readonly ok: true; readonly profile: LlmProfile }
  | { readonly ok: false; readonly err: LlmGenerateErr }

export interface ResolveInput {
  readonly profileId?: string
  readonly consumer: string
  readonly purpose: LlmPurpose
}

function usable(profile: LlmProfile, purpose: LlmPurpose): boolean {
  return profile.enabled && (purpose !== 'vision' || profile.supportsVision)
}

function defaultProfileId(
  defaults: readonly LlmDefault[],
  match: (selector: LlmDefault['selector']) => boolean,
): string | undefined {
  return defaults.find((d) => match(d.selector))?.profileId
}

export function resolveProfile(
  profiles: readonly LlmProfile[],
  defaults: readonly LlmDefault[],
  input: ResolveInput,
): ResolveOutcome {
  const byId = new Map(profiles.map((p) => [p.id, p]))

  if (input.profileId !== undefined) {
    const explicit = byId.get(input.profileId)
    if (explicit === undefined || !explicit.enabled) {
      return {
        ok: false,
        err: {
          ok: false,
          code: 'no-profile',
          message: `profile "${input.profileId}" not found or disabled`,
        },
      }
    }
    if (input.purpose === 'vision' && !explicit.supportsVision) {
      return {
        ok: false,
        err: {
          ok: false,
          code: 'bad-request',
          message: `profile "${input.profileId}" does not support vision`,
        },
      }
    }
    return { ok: true, profile: explicit }
  }

  const consumerId = defaultProfileId(
    defaults,
    (s) => 'consumer' in s && s.consumer === input.consumer,
  )
  const consumerProfile = consumerId !== undefined ? byId.get(consumerId) : undefined
  if (consumerProfile !== undefined && usable(consumerProfile, input.purpose)) {
    return { ok: true, profile: consumerProfile }
  }

  const purposeId = defaultProfileId(defaults, (s) => 'purpose' in s && s.purpose === input.purpose)
  const purposeProfile = purposeId !== undefined ? byId.get(purposeId) : undefined
  if (purposeProfile !== undefined && usable(purposeProfile, input.purpose)) {
    return { ok: true, profile: purposeProfile }
  }

  return {
    ok: false,
    err: {
      ok: false,
      code: 'no-profile',
      message: `no ${input.purpose} profile configured for consumer "${input.consumer}"`,
    },
  }
}

/**
 * The profile to try after `tried` refused for a reason that belongs to the
 * BACKEND rather than to the question — today only a guardrail refusal.
 *
 * Only for a caller that did NOT name a profile — the provider never falls
 * back from an explicit id (see `dispatch`). The chain is the one
 * `resolveProfile` walks: consumer default, then purpose default. A
 * candidate that is disabled, cannot serve the purpose, or was already tried is
 * skipped, never returned. `null` = the chain is exhausted.
 */
export function nextFallbackProfile(
  profiles: readonly LlmProfile[],
  defaults: readonly LlmDefault[],
  input: ResolveInput,
  tried: ReadonlySet<string>,
): LlmProfile | null {
  const byId = new Map(profiles.map((p) => [p.id, p]))
  const chain = [
    defaultProfileId(defaults, (s) => 'consumer' in s && s.consumer === input.consumer),
    defaultProfileId(defaults, (s) => 'purpose' in s && s.purpose === input.purpose),
  ]
  for (const id of chain) {
    if (id === undefined || tried.has(id)) continue
    const candidate = byId.get(id)
    if (candidate !== undefined && usable(candidate, input.purpose)) return candidate
  }
  return null
}

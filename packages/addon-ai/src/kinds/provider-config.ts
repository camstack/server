/**
 * What each kind keeps in `providerConfig`, and the one validator the provider
 * runs on save (D893). The cap types the bag as `Record<string, unknown>`; this
 * file is where an addon-ai kind says what it accepts, so a malformed profile is
 * refused at `upsertProfile` instead of failing at call time.
 */
import {
  collectSecretConfigKeys,
  type LlmProfile,
  type LlmProviderConfig,
  type ManagedRuntimeConfig,
  ManagedRuntimeConfigSchema,
} from '@camstack/types'
import { z } from 'zod'
import { AI_KIND_DESCRIPTORS, descriptorOf, type KindDescriptor } from './descriptors.js'
import { explicitBaseUrl, HttpConnectionSchema, isHttpKind } from './http-connection.js'

export const AppleConnectionSchema = z.object({ nodeId: z.string().min(1) })

export type ProviderConfigCheck =
  | { readonly ok: true; readonly config: LlmProviderConfig }
  | { readonly ok: false; readonly message: string }

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ')
}

/**
 * Validate (and normalise) a kind's `providerConfig`. `managed-local` stores a
 * whole `ManagedRuntimeConfig` (the engine defaults to llama.cpp, the only one);
 * `apple-foundation` a node id; the HTTP kinds an endpoint, a key and headers.
 * A kind this addon does not serve is refused.
 */
export function validateProviderConfig(
  kind: string,
  config: LlmProviderConfig,
): ProviderConfigCheck {
  if (isHttpKind(kind)) {
    const parsed = HttpConnectionSchema.safeParse(config)
    if (!parsed.success) return { ok: false, message: zodMessage(parsed.error) }
    if (kind === 'openai-compatible' && explicitBaseUrl(parsed.data) === null) {
      return { ok: false, message: 'an OpenAI-compatible profile needs a base URL' }
    }
    return { ok: true, config: parsed.data }
  }
  if (kind === 'managed-local') {
    const parsed = ManagedRuntimeConfigSchema.safeParse({ engine: 'llama-cpp', ...config })
    return parsed.success
      ? { ok: true, config: parsed.data }
      : { ok: false, message: zodMessage(parsed.error) }
  }
  if (kind === 'apple-foundation') {
    const parsed = AppleConnectionSchema.safeParse(config)
    return parsed.success
      ? { ok: true, config: parsed.data }
      : { ok: false, message: 'an apple-foundation profile needs the node it runs on' }
  }
  return { ok: false, message: `this provider serves no kind "${kind}"` }
}

/** The managed runtime of a `managed-local` row; `null` = not one, or malformed. */
export function managedRuntimeOf(profile: LlmProfile): ManagedRuntimeConfig | null {
  if (profile.kind !== 'managed-local') return null
  const parsed = ManagedRuntimeConfigSchema.safeParse({
    engine: 'llama-cpp',
    ...profile.providerConfig,
  })
  return parsed.success ? parsed.data : null
}

/** The node an `apple-foundation` row runs on; `null` = not one, or unset. */
export function appleNodeIdOf(profile: LlmProfile): string | null {
  if (profile.kind !== 'apple-foundation') return null
  const parsed = AppleConnectionSchema.safeParse(profile.providerConfig)
  return parsed.success ? parsed.data.nodeId : null
}

/**
 * The one keychain-held field of a kind: the `password` (or `secret: true`)
 * field of its schemas. The row has exactly one secret slot, so a kind that
 * declared two is a programming error, caught at module load.
 */
function secretFieldOfDescriptor(descriptor: KindDescriptor): string | null {
  const keys = new Set([
    ...collectSecretConfigKeys(descriptor.connectionSchema),
    ...(descriptor.advancedSchema !== undefined
      ? collectSecretConfigKeys(descriptor.advancedSchema)
      : []),
  ])
  if (keys.size > 1) {
    throw new Error(
      `kind "${descriptor.kind}" declares ${String(keys.size)} secret fields; a profile row holds one`,
    )
  }
  const [only] = [...keys]
  return only ?? null
}

const SECRET_FIELD_BY_KIND: ReadonlyMap<string, string | null> = new Map(
  AI_KIND_DESCRIPTORS.map((d) => [d.kind, secretFieldOfDescriptor(d)]),
)

/** `null` = this kind keeps no secret (or is not one of ours). */
export function secretFieldOf(kind: string): string | null {
  return SECRET_FIELD_BY_KIND.get(kind) ?? null
}

export function isServedKind(kind: string): boolean {
  return descriptorOf(kind) !== null
}

export { secretFieldOfDescriptor }

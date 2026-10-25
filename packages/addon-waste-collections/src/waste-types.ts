import { isSecretMarker, type SecretMarker } from '@camstack/types'
import { z } from 'zod'
import { hasUnresolvedCredential } from './waste-secrets.js'

/**
 * One argument of a source: a plain value, or - for a credential - the keychain
 * marker the store holds when the keychain could not serve it right now (D798).
 */
export const WasteArgValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.custom<SecretMarker>(isSecretMarker),
])
export type WasteArgValue = z.infer<typeof WasteArgValueSchema>

export const WasteSourceConfigSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  module: z.string().min(1),
  /**
   * The provider's constructor kwargs (HACS `args`), typed per service by the
   * catalog. A credential argument (`waste-secrets.ts`) is a keychain marker at
   * rest (D880).
   */
  args: z.preprocess((v) => v ?? {}, z.record(z.string(), WasteArgValueSchema)),
  /**
   * LEGACY (before D880): the same kwargs as a free JSON object string, which could
   * carry a password raw. Read only until `migrateSources` rewrites the row.
   */
  argsJson: z.string().optional(),
  enabled: z.boolean().default(true),
})
export type WasteSourceConfig = z.infer<typeof WasteSourceConfigSchema>

/** A credential this source holds that the keychain has not served is unusable: say so, never fetch without it. */
export class WasteCredentialUnavailableError extends Error {
  constructor(readonly sourceId: string) {
    super(`source '${sourceId}': its stored credential is unavailable (is the keychain locked?)`)
    this.name = 'WasteCredentialUnavailableError'
  }
}

/**
 * The arguments a fetch passes to the provider. A row that still carries `argsJson`
 * is legacy (or a migration that was rolled back) and that JSON is its truth;
 * every other row reads `args`.
 */
export function sourceArgs(source: WasteSourceConfig): Record<string, unknown> {
  const legacy = source.argsJson?.trim() ?? ''
  let out: Record<string, unknown> = { ...source.args }
  if (legacy.length > 0) {
    let parsed: unknown
    try {
      parsed = JSON.parse(legacy)
    } catch {
      // A SyntaxError quotes the text, which holds the credential: say only where.
      throw new Error(`source '${source.id}': argsJson is not valid JSON`)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`source '${source.id}': argsJson must be a JSON object`)
    }
    out = { ...parsed }
  }
  if (hasUnresolvedCredential(out)) throw new WasteCredentialUnavailableError(source.id)
  return out
}

export const WasteConfigSchema = z.object({
  sources: z.array(WasteSourceConfigSchema).default([]),
})
export type WasteConfig = z.infer<typeof WasteConfigSchema>

export const DEFAULT_WASTE_CONFIG: WasteConfig = WasteConfigSchema.parse({})

export const WasteCollectionEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.string(),
  icon: z.string().nullable().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
})
export type WasteCollectionEntry = z.infer<typeof WasteCollectionEntrySchema>

export const WasteFetchResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    entries: z.array(WasteCollectionEntrySchema),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
])
export type WasteFetchResult = z.infer<typeof WasteFetchResultSchema>

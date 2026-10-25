/**
 * The `providerConfig` of the four HTTP kinds (openai, openai-compatible,
 * anthropic, google): where to knock, with which key, and any extra headers.
 *
 * Read through {@link httpConnectionOf} everywhere a wire is built, never off
 * the bag directly: the bag is `Record<string, unknown>` on the wire, and this
 * is the one place that says what an HTTP kind keeps in it.
 */
import type { LlmProfile, LlmProviderConfig } from '@camstack/types'
import { z } from 'zod'

export const HTTP_KINDS = ['openai-compatible', 'openai', 'anthropic', 'google'] as const
export type HttpKind = (typeof HTTP_KINDS)[number]

export function isHttpKind(kind: string): kind is HttpKind {
  return HTTP_KINDS.some((k) => k === kind)
}

/** One extra request header. A list of rows (not a map) so the editor can draw it. */
export const HttpHeaderSchema = z.object({ name: z.string().min(1), value: z.string() })
export type HttpHeader = z.infer<typeof HttpHeaderSchema>

export const HttpConnectionSchema = z.object({
  baseUrl: z.string().optional(),
  /** The kind's one secret field — keychain-held, see `profile-store.ts`. */
  apiKey: z.string().optional().meta({ secret: true }),
  extraHeaders: z.array(HttpHeaderSchema).optional(),
})
export type HttpConnection = z.infer<typeof HttpConnectionSchema>

/** The connection of a bag; a bag that is not one reads as "nothing set". */
export function httpConnectionFrom(config: LlmProviderConfig): HttpConnection {
  const parsed = HttpConnectionSchema.safeParse(config)
  return parsed.success ? parsed.data : {}
}

export function httpConnectionOf(profile: LlmProfile): HttpConnection {
  return httpConnectionFrom(profile.providerConfig)
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/** The base URL the operator set, without a trailing slash; `null` = unset. */
export function explicitBaseUrl(conn: HttpConnection): string | null {
  return conn.baseUrl !== undefined && conn.baseUrl.trim().length > 0
    ? trimSlash(conn.baseUrl.trim())
    : null
}

/** The extra headers as the map a wire takes; `undefined` = none. */
export function extraHeadersOf(conn: HttpConnection): Record<string, string> | undefined {
  if (conn.extraHeaders === undefined || conn.extraHeaders.length === 0) return undefined
  return Object.fromEntries(conn.extraHeaders.map((h) => [h.name, h.value]))
}

/** A non-empty key, or `undefined`. */
export function apiKeyOf(conn: HttpConnection): string | undefined {
  return conn.apiKey !== undefined && conn.apiKey.length > 0 ? conn.apiKey : undefined
}

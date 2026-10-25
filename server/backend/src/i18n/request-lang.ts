/**
 * The language a request is answered in (D863).
 *
 * Order: the signed-in user's PROFILE language when the account has one (none
 * exists yet - the field is accepted so the day it is added only the context
 * wiring changes), else the app's explicit `lang` (`x-camstack-lang` header or
 * `lang` query/connection param), else the first supported tag of
 * `Accept-Language`, else English. Anything outside the allow-list is ignored,
 * never echoed.
 */
import type { IncomingHttpHeaders } from 'node:http'
import { CatalogLangSchema, DEFAULT_CATALOG_LANG, type CatalogLang } from '@camstack/types'
import { langFromAcceptLanguage } from '../auth/app-page-strings.js'

export interface RequestLangInput {
  readonly profileLanguage?: unknown
  readonly explicitLang?: unknown
  readonly acceptLanguage?: string | readonly string[]
}

function parseLang(value: unknown): CatalogLang | undefined {
  const parsed = CatalogLangSchema.safeParse(
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  return parsed.success ? parsed.data : undefined
}

export function resolveRequestLang(input: RequestLangInput): CatalogLang {
  return (
    parseLang(input.profileLanguage) ??
    parseLang(input.explicitLang) ??
    langFromAcceptLanguage(input.acceptLanguage) ??
    DEFAULT_CATALOG_LANG
  )
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

/** Reads the request-borne inputs; `query` is the parsed query object when there is one. */
export function requestLangInputFrom(
  headers: IncomingHttpHeaders,
  query?: Readonly<Record<string, unknown>> | null,
  connectionLang?: unknown,
): RequestLangInput {
  const acceptLanguage = headers['accept-language']
  return {
    explicitLang: firstHeader(headers['x-camstack-lang']) ?? query?.['lang'] ?? connectionLang,
    ...(acceptLanguage !== undefined ? { acceptLanguage } : {}),
  }
}

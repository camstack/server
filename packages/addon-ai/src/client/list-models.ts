/**
 * Model listing per HTTP wire — ours, and staying ours.
 *
 * The library has no model-listing surface at all (it takes a model id, it does
 * not discover one), so each vendor's list endpoint is a plain fetch here:
 *
 *   - OpenAI and OpenAI-compatible: `GET {base}/models`, Bearer key. On an
 *     OpenAI-compatible server (local: Ollama, llama.cpp…) what it reports about
 *     each model is read too — `local-model-features.ts`.
 *   - Anthropic: `GET {base}/models`, `x-api-key` + `anthropic-version`, paged
 *     with `after_id`; each model's features from its own capability tree —
 *     `anthropic-models.ts`.
 *   - Google Gemini: `GET {base}/models`, `x-goog-api-key` (a HEADER — never the
 *     `?key=` form, which would put the key in every URL a log or an error
 *     message prints), paged; only models that can `generateContent`.
 *
 * Never throws: an unreachable endpoint, a refused key or a server without a
 * list is a typed RESULT (`auth` | `network` | `unsupported` | `invalid`) the
 * editor renders inline — with the vendor's own reason when it gave one. No
 * message ever carries the key: it travels in a header only, and every message
 * is scrubbed of it besides.
 */
import type { LlmListModelsResult, LlmModelInfo } from '@camstack/types'
import { z } from 'zod'
import {
  apiKeyOf,
  explicitBaseUrl,
  extraHeadersOf,
  type HttpConnection,
  type HttpKind,
} from '../kinds/http-connection.js'
import { AnthropicModelsPageSchema, anthropicModelInfo } from './anthropic-models.js'
import { type ListModelsOptions, type Page, requestJson } from './list-models-http.js'
import {
  OpenAiModelEntrySchema,
  openAiModelInfo,
  serverRootOf,
  withOllamaFeatures,
} from './local-model-features.js'

export type { ListModelsOptions } from './list-models-http.js'

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'
export const GOOGLE_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const ANTHROPIC_VERSION = '2023-06-01'
/** The Models API's documented maximum page size (1–1000, default 20). */
const ANTHROPIC_PAGE_LIMIT = 1000
/** A vendor that pages forever is a bug on their side, not a reason to hang. */
const MAX_PAGES = 10

const OpenAiModelsSchema = z.object({ data: z.array(OpenAiModelEntrySchema) })
const GoogleModelsSchema = z.object({
  models: z
    .array(
      z.object({
        name: z.string(),
        displayName: z.string().optional(),
        inputTokenLimit: z.number().int().positive().optional(),
        supportedGenerationMethods: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  nextPageToken: z.string().optional(),
})

/** One GET, answered as a parsed body or a typed failure. */
function getJson<T>(
  url: string,
  headers: Record<string, string>,
  schema: z.ZodType<T>,
  secret: string | undefined,
  opts: ListModelsOptions,
): Promise<Page<T>> {
  return requestJson(url, { method: 'GET', headers }, schema, secret, opts)
}

function withExtra(conn: HttpConnection, headers: Record<string, string>): Record<string, string> {
  return { ...headers, ...extraHeadersOf(conn) }
}

type OpenAiList =
  | { readonly ok: true; readonly base: string; readonly models: LlmModelInfo[] }
  | { readonly ok: false; readonly fail: Extract<LlmListModelsResult, { ok: false }> }

const OllamaTagsListSchema = z.object({ models: z.array(z.object({ name: z.string() })) })

/**
 * `{base}/models`, then — only for a server the operator pointed at, and only
 * when it says "no such list" — the two places a local server keeps it when the
 * typed base is a bare host: `{base}/v1/models`, and Ollama's own `/api/tags`.
 */
async function openAiModelList(
  kind: 'openai' | 'openai-compatible',
  base: string,
  headers: Record<string, string>,
  key: string | undefined,
  opts: ListModelsOptions,
): Promise<OpenAiList> {
  const first = await getJson(`${base}/models`, headers, OpenAiModelsSchema, key, opts)
  if (first.ok) return { ok: true, base, models: first.body.data.map(openAiModelInfo) }
  if (kind === 'openai' || first.code !== 'unsupported') return { ok: false, fail: first }
  if (!base.endsWith('/v1')) {
    const v1 = `${base}/v1`
    const second = await getJson(`${v1}/models`, headers, OpenAiModelsSchema, key, opts)
    if (second.ok) return { ok: true, base: v1, models: second.body.data.map(openAiModelInfo) }
  }
  const root = serverRootOf(base)
  if (root !== null) {
    const tags = await getJson(`${root}/api/tags`, headers, OllamaTagsListSchema, key, opts)
    if (tags.ok) {
      return {
        ok: true,
        base: `${root}/v1`,
        models: tags.body.models.map((m) => ({ id: m.name })),
      }
    }
  }
  return { ok: false, fail: first }
}

async function listOpenAiWire(
  kind: 'openai' | 'openai-compatible',
  conn: HttpConnection,
  opts: ListModelsOptions,
): Promise<LlmListModelsResult> {
  const base = explicitBaseUrl(conn) ?? (kind === 'openai' ? OPENAI_DEFAULT_BASE_URL : null)
  if (base === null) return { ok: false, code: 'invalid', message: 'set the base URL first' }
  const key = apiKeyOf(conn)
  const headers = withExtra(conn, key !== undefined ? { authorization: `Bearer ${key}` } : {})
  const found = await openAiModelList(kind, base, headers, key, opts)
  if (!found.ok) return found.fail
  const { models } = found
  // Only a server the operator pointed at can be a local one; the cloud wire
  // is never probed for another server's endpoints.
  if (kind === 'openai') return { ok: true, models }
  return {
    ok: true,
    models: await withOllamaFeatures(found.base, models, headers, key, opts),
  }
}

/** A host with no path means `/v1`; a pasted `/models` suffix is not doubled. */
function anthropicBase(explicit: string | null): string {
  if (explicit === null) return ANTHROPIC_DEFAULT_BASE_URL
  const trimmed = explicit.endsWith('/models') ? explicit.slice(0, -'/models'.length) : explicit
  try {
    return new URL(trimmed).pathname === '/' ? `${trimmed}/v1` : trimmed
  } catch {
    return trimmed
  }
}

async function listAnthropic(
  conn: HttpConnection,
  opts: ListModelsOptions,
): Promise<LlmListModelsResult> {
  const base = anthropicBase(explicitBaseUrl(conn))
  const key = apiKeyOf(conn)
  if (key === undefined) return { ok: false, code: 'auth', message: 'an Anthropic key is required' }
  const headers = withExtra(conn, {
    'x-api-key': key,
    'anthropic-version': ANTHROPIC_VERSION,
  })
  const models: LlmModelInfo[] = []
  let after: string | undefined
  // A gateway in front of the API may refuse the page size; the first 400 is
  // answered once at the API's default size, which every server accepts.
  let withLimit = true
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const params = [
      ...(withLimit ? [`limit=${String(ANTHROPIC_PAGE_LIMIT)}`] : []),
      ...(after !== undefined ? [`after_id=${encodeURIComponent(after)}`] : []),
    ]
    const url = `${base}/models${params.length > 0 ? `?${params.join('&')}` : ''}`
    let page = await getJson(url, headers, AnthropicModelsPageSchema, key, opts)
    if (!page.ok && page.code === 'invalid' && withLimit && i === 0) {
      withLimit = false
      page = await getJson(`${base}/models`, headers, AnthropicModelsPageSchema, key, opts)
    }
    if (!page.ok) return page
    for (const m of page.body.data) models.push(anthropicModelInfo(m))
    const next = page.body.last_id ?? undefined
    if (page.body.has_more !== true || next === undefined) break
    after = next
  }
  return { ok: true, models }
}

async function listGoogle(
  conn: HttpConnection,
  opts: ListModelsOptions,
): Promise<LlmListModelsResult> {
  const base = explicitBaseUrl(conn) ?? GOOGLE_DEFAULT_BASE_URL
  const key = apiKeyOf(conn)
  if (key === undefined) return { ok: false, code: 'auth', message: 'a Gemini API key is required' }
  const headers = withExtra(conn, { 'x-goog-api-key': key })
  const models: LlmModelInfo[] = []
  let token: string | undefined
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const query = `pageSize=1000${token !== undefined ? `&pageToken=${encodeURIComponent(token)}` : ''}`
    const page = await getJson(`${base}/models?${query}`, headers, GoogleModelsSchema, key, opts)
    if (!page.ok) return page
    for (const m of page.body.models ?? []) {
      // Embedding / AQA models are listed too; they cannot answer a prompt.
      const methods = m.supportedGenerationMethods
      if (methods !== undefined && !methods.includes('generateContent')) continue
      models.push({
        id: m.name.startsWith('models/') ? m.name.slice('models/'.length) : m.name,
        ...(m.displayName !== undefined ? { label: m.displayName } : {}),
        ...(m.inputTokenLimit !== undefined ? { contextLength: m.inputTokenLimit } : {}),
      })
    }
    token = page.body.nextPageToken
    if (token === undefined || token === '') break
  }
  return { ok: true, models }
}

/** The models of an HTTP kind's endpoint. Never throws; never echoes the key. */
export async function listHttpModels(
  kind: HttpKind,
  conn: HttpConnection,
  opts: ListModelsOptions,
): Promise<LlmListModelsResult> {
  switch (kind) {
    case 'openai':
    case 'openai-compatible':
      return listOpenAiWire(kind, conn, opts)
    case 'anthropic':
      return listAnthropic(conn, opts)
    case 'google':
      return listGoogle(conn, opts)
  }
}

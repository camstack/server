/**
 * The one HTTP exchange every model-list wire makes: a request answered as a
 * parsed body or a typed failure, never a throw, never a message carrying the
 * key. Shared by `list-models.ts` and the per-vendor readers beside it.
 */
import type { LlmListModelsResult } from '@camstack/types'
import { z } from 'zod'

export interface ListModelsOptions {
  readonly timeoutMs: number
  readonly fetchImpl?: typeof fetch
}

export type ListFail = Extract<LlmListModelsResult, { ok: false }>
export type Page<T> = { readonly ok: true; readonly body: T } | ListFail

export interface JsonRequest {
  readonly method: 'GET' | 'POST'
  readonly headers: Record<string, string>
  readonly body?: string
}

/** A vendor's reason is shown inline; a page of HTML is not a reason. */
const MAX_REASON_CHARS = 300

export function scrub(message: string, secret: string | undefined): string {
  return secret === undefined ? message : message.split(secret).join('***')
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'the request timed out'
    return err.message
  }
  return String(err)
}

/**
 * The error bodies the wires we speak send: Anthropic
 * `{ type: 'error', error: { type, message } }`, OpenAI and Gemini
 * `{ error: { message, type?|status? } }`, Ollama `{ error: '…' }`.
 */
const VendorErrorSchema = z.object({
  error: z.union([
    z.string(),
    z.object({
      type: z.string().optional(),
      status: z.string().optional(),
      message: z.string().optional(),
    }),
  ]),
})

/** The vendor's own words for a refusal, or `null` when the body has none. */
function vendorReason(text: string): string | null {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = VendorErrorSchema.safeParse(json)
  if (!parsed.success) return null
  const err = parsed.data.error
  if (typeof err === 'string') return err.length > 0 ? err : null
  const kind = err.type ?? err.status
  const message = err.message
  if (message === undefined || message.length === 0) return kind ?? null
  return kind !== undefined ? `${kind}: ${message}` : message
}

function statusMessage(
  status: number,
  lead: string,
  body: string,
  secret: string | undefined,
): string {
  const reason = vendorReason(body)
  const base = `${lead} (HTTP ${String(status)})`
  if (reason === null) return base
  const clipped =
    reason.length > MAX_REASON_CHARS ? `${reason.slice(0, MAX_REASON_CHARS)}…` : reason
  return `${base}: ${scrub(clipped, secret)}`
}

async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

/** One request, answered as a parsed body or a typed failure. */
export async function requestJson<T>(
  url: string,
  req: JsonRequest,
  schema: z.ZodType<T>,
  secret: string | undefined,
  opts: ListModelsOptions,
): Promise<Page<T>> {
  const fetchImpl = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
  } catch (err: unknown) {
    return {
      ok: false,
      code: 'network',
      message: scrub(errorText(err), secret),
    }
  }
  if (!res.ok) {
    const body = await bodyText(res)
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        code: 'auth',
        message: statusMessage(res.status, 'the endpoint refused the credentials', body, secret),
      }
    }
    if (res.status === 404 || res.status === 405) {
      return {
        ok: false,
        code: 'unsupported',
        message: `the endpoint has no model list (HTTP ${String(res.status)}); type the model id`,
      }
    }
    if (res.status === 400 || res.status === 422) {
      // The endpoint understood the call and said no to something in it — a
      // header, a parameter, the key's type. Its reason is the whole diagnosis.
      return {
        ok: false,
        code: 'invalid',
        message: statusMessage(res.status, 'the endpoint rejected the request', body, secret),
      }
    }
    return {
      ok: false,
      code: 'network',
      message: statusMessage(res.status, 'the endpoint answered an error', body, secret),
    }
  }
  let json: unknown
  try {
    json = JSON.parse(await res.text())
  } catch {
    return {
      ok: false,
      code: 'network',
      message: 'the endpoint did not answer JSON',
    }
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    return {
      ok: false,
      code: 'network',
      message: 'the endpoint answered something that is not a model list',
    }
  }
  return { ok: true, body: parsed.data }
}

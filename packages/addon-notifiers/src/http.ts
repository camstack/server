/**
 * Outbound HTTP helpers for the notifiers addon.
 *
 * Adapters produce a pure `HttpRequestPlan`; this module is the only place
 * that touches the network. `fetchWithTimeout` bounds every request so a dead
 * endpoint fails fast instead of wedging the dispatch path (copied verbatim
 * from `addon-advanced-notifier/src/outputs/http.ts` — addons cannot
 * cross-import). `fetchAttachmentBytes` executes the degrade engine's
 * `needsFetch` directive with a HARD size cap, aborting mid-stream once the
 * cap is exceeded.
 */
import type {
  HttpRequestBody,
  HttpRequestPlan,
  HttpResponseLike,
  MultipartPart,
} from './adapters/adapter.js'

/** Default per-request timeout for notification dispatch. */
export const DEFAULT_OUTPUT_TIMEOUT_MS = 10_000

/** Fallback hard cap when a kind declares bytes attachments without an explicit `maxBytes`. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_OUTPUT_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** A remote attachment fetched into bytes, ready for a multipart/raw upload. */
export interface FetchedAttachment {
  readonly bytes: Uint8Array
  readonly mime?: string
  readonly name?: string
}

/**
 * Fetch `url` into bytes, enforcing a hard `maxBytes` cap. Rejects (aborting
 * the transfer) as soon as the declared `content-length` OR the streamed byte
 * count exceeds the cap, so a hostile/huge attachment can never blow up memory.
 */
export async function fetchAttachmentBytes(
  url: string,
  maxBytes: number,
  timeoutMs: number = DEFAULT_OUTPUT_TIMEOUT_MS,
): Promise<FetchedAttachment> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal })
    if (!res.ok) {
      throw new Error(`attachment fetch failed: HTTP ${res.status} ${res.statusText}`)
    }

    const declared = res.headers.get('content-length')
    if (declared !== null) {
      const len = Number(declared)
      if (Number.isFinite(len) && len > maxBytes) {
        controller.abort()
        throw new Error(`attachment exceeds maxBytes (${len} > ${maxBytes})`)
      }
    }

    const mime = res.headers.get('content-type') ?? undefined
    const name = fileNameFromUrl(url)

    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > maxBytes) {
        throw new Error(`attachment exceeds maxBytes (${buf.byteLength} > ${maxBytes})`)
      }
      return buildFetched(buf, mime, name)
    }

    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        controller.abort()
        throw new Error(`attachment exceeds maxBytes (>${maxBytes})`)
      }
      chunks.push(value)
    }
    const out = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return buildFetched(out, mime, name)
  } finally {
    clearTimeout(timer)
  }
}

function buildFetched(bytes: Uint8Array, mime?: string, name?: string): FetchedAttachment {
  return {
    bytes,
    ...(mime !== undefined ? { mime } : {}),
    ...(name !== undefined ? { name } : {}),
  }
}

function fileNameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    return last && last.length > 0 ? last : undefined
  } catch {
    return undefined
  }
}

/**
 * Execute a pure `HttpRequestPlan` over `fetchWithTimeout`, returning a
 * response the adapter's `parseResult` can inspect. This is the provider's
 * default HTTP sender; unit tests inject a fake instead.
 */
export async function sendHttpPlan(
  plan: HttpRequestPlan,
  timeoutMs: number = DEFAULT_OUTPUT_TIMEOUT_MS,
): Promise<HttpResponseLike> {
  const { init } = buildRequestInit(plan)
  return fetchWithTimeout(plan.url, init, timeoutMs)
}

function buildRequestInit(plan: HttpRequestPlan): { readonly init: RequestInit } {
  const headers: Record<string, string> = { ...plan.headers }
  const init: RequestInit = { method: plan.method ?? 'POST', headers }
  const body = plan.body
  if (body !== undefined) {
    init.body = renderBody(body, headers)
  }
  return { init }
}

function renderBody(
  body: HttpRequestBody,
  headers: Record<string, string>,
): string | Uint8Array | FormData {
  switch (body.kind) {
    case 'json':
      setContentTypeIfAbsent(headers, 'application/json')
      return JSON.stringify(body.value)
    case 'text':
      if (body.contentType !== undefined) setContentTypeIfAbsent(headers, body.contentType)
      return body.value
    case 'raw':
      if (body.contentType !== undefined) setContentTypeIfAbsent(headers, body.contentType)
      return body.value
    case 'multipart':
      // Let the platform set `content-type: multipart/form-data; boundary=…`.
      return buildFormData(body.parts)
  }
}

function buildFormData(parts: readonly MultipartPart[]): FormData {
  const form = new FormData()
  for (const part of parts) {
    if (part.kind === 'field') {
      form.append(part.name, part.value)
    } else {
      const blob = new Blob([part.bytes], {
        ...(part.contentType !== undefined ? { type: part.contentType } : {}),
      })
      form.append(part.name, blob, part.filename ?? part.name)
    }
  }
  return form
}

function setContentTypeIfAbsent(headers: Record<string, string>, value: string): void {
  const has = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')
  if (!has) headers['content-type'] = value
}

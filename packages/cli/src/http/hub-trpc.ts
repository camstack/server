/**
 * One tRPC mutation against the hub through the pinned-CA transport, for the
 * unauthenticated sign-in legs. The answer is validated with the caller's Zod
 * schema; a refusal is a value (`status` + the hub's message), not an
 * exception, so the caller decides what an expiry or a rate limit means.
 */
import { z } from 'zod'
import { hubRequest } from './hub-http.js'

export type TrpcMutationResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly message: string }

const ErrorEnvelopeSchema = z.object({
  error: z.object({ json: z.object({ message: z.string().optional() }) }).optional(),
})

const DataEnvelopeSchema = z.object({ result: z.object({ data: z.object({ json: z.unknown() }) }) })

function firstOf(body: unknown): unknown {
  return Array.isArray(body) ? body[0] : body
}

function messageOf(body: unknown, fallback: string): string {
  const parsed = ErrorEnvelopeSchema.safeParse(firstOf(body))
  return (parsed.success ? parsed.data.error?.json.message : undefined) ?? fallback
}

export async function hubTrpcMutation<T>(
  server: string,
  procedure: string,
  input: unknown,
  schema: z.ZodType<T>,
  opts: { readonly sessionDir?: string } = {},
): Promise<TrpcMutationResult<T>> {
  const res = await hubRequest(`${server}/trpc/${procedure}?batch=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ '0': { json: input ?? null } }),
    timeoutMs: 15_000,
    ...(opts.sessionDir ? { sessionDir: opts.sessionDir } : {}),
  })
  const raw = await res.text()
  let body: unknown = null
  try {
    body = raw === '' ? null : JSON.parse(raw)
  } catch {
    body = null
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      message: messageOf(body, `${res.status} ${res.statusText}`),
    }
  }
  const envelope = DataEnvelopeSchema.safeParse(firstOf(body))
  if (!envelope.success) {
    return { ok: false, status: res.status, message: `${procedure}: response missing result` }
  }
  const data = schema.safeParse(envelope.data.result.data.json)
  if (!data.success) {
    return { ok: false, status: res.status, message: `${procedure}: response shape mismatch` }
  }
  return { ok: true, data: data.data }
}

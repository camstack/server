/**
 * The hub's HTTP client for an agent's pairing endpoints (D857).
 *
 * An unpaired agent speaks plain HTTP on its API port (it has no certificate to
 * speak TLS with); a paired one answers `hello` the same way. Everything the agent
 * says is untrusted data: every answer is read through a size cap and a Zod
 * schema, a redirect is an error, and a refusal keeps the agent's own code so the
 * hub can tell "awaiting local confirmation" from a failure.
 *
 * The target is checked before anything is sent: a pairing talks to a machine on
 * the operator's own network, never to a public address (the hub must not be a
 * way to make requests to arbitrary hosts).
 */
import { isIP } from 'node:net'
import {
  type AgentEndpoint,
  type AgentHello,
  type AgentPairingTransport,
  type AgentPairingPoll,
  isLocalOnlyHostname,
  isPrivateAddress,
  type OfferAnswer,
  type OfferRequest,
  PAIRING_PATHS,
  PairingHttpError,
} from '@camstack/system'
import { z } from 'zod'

const REQUEST_TIMEOUT_MS = 8_000
const MAX_RESPONSE_BYTES = 128 * 1024

const HelloSchema = z.object({
  protocol: z.number(),
  nodeId: z.string().min(1).max(128),
  version: z.string().nullable(),
  state: z.enum(['unpaired', 'pending', 'paired']),
  pendingExpiresAt: z.number().nullable(),
})

const OfferAnswerSchema = z.object({
  ok: z.literal(true),
  answer: z.object({
    pairingId: z.string().min(1).max(128),
    csrPem: z.string().min(1).max(16_384),
    agentNonce: z.string().min(1).max(256),
    expiresAt: z.number(),
  }),
})

const PollSchema = z.object({
  ok: z.literal(true),
  poll: z.object({
    state: z.enum(['pending', 'idle']),
    localConfirmed: z.boolean(),
    last: z
      .object({
        pairingId: z.string(),
        outcome: z.enum(['completed', 'rejected', 'expired', 'code-mismatch', 'failed']),
      })
      .nullable(),
  }),
})

const FailureSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
})

/** A pairing target must be on the operator's own network. Throws with the reason. */
export function assertPairableHost(host: string): void {
  const bare = host.replace(/^\[|\]$/g, '')
  const isLoopback = bare === 'localhost' || bare === '::1' || bare.startsWith('127.')
  if (isLoopback) return
  if (isIP(bare) !== 0) {
    if (isPrivateAddress(bare)) return
    throw new Error(`"${host}" is not a private network address - an agent is paired from the LAN`)
  }
  if (isLocalOnlyHostname(bare.toLowerCase())) return
  throw new Error(
    `"${host}" is not a local name - use the agent's LAN address or a .local / .lan host name`,
  )
}

function baseUrl(endpoint: AgentEndpoint): string {
  const host = isIP(endpoint.host) === 6 ? `[${endpoint.host}]` : endpoint.host
  return `http://${host}:${endpoint.port}`
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('the agent answered with more than 128 KiB')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface PairingHttpOptions {
  /** Test seam; production uses the global `fetch`. */
  readonly fetchFn?: typeof fetch
  readonly timeoutMs?: number
}

export function createHttpAgentPairingTransport(
  options: PairingHttpOptions = {},
): AgentPairingTransport {
  const fetchFn = options.fetchFn ?? fetch
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  async function call<T extends z.ZodType>(
    endpoint: AgentEndpoint,
    method: 'GET' | 'POST',
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<z.infer<T>> {
    assertPairableHost(endpoint.host)
    let response: Response
    try {
      response = await fetchFn(`${baseUrl(endpoint)}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
    } catch (err) {
      throw new Error(
        `could not reach the agent at ${endpoint.host}:${endpoint.port}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    const text = await readCapped(response)
    let json: unknown
    try {
      json = text.length === 0 ? null : JSON.parse(text)
    } catch {
      json = null
    }
    if (!response.ok) {
      const failure = FailureSchema.safeParse(json)
      const code = failure.success ? (failure.data.error ?? 'refused') : 'refused'
      const message = failure.success
        ? (failure.data.message ?? failure.data.error ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`
      throw new PairingHttpError(response.status, code, message)
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new Error(
        `the agent at ${endpoint.host}:${endpoint.port} answered with an unexpected shape`,
      )
    }
    return parsed.data
  }

  const Ok = z.object({ ok: z.literal(true) })
  return {
    hello: (endpoint): Promise<AgentHello> =>
      call(endpoint, 'GET', PAIRING_PATHS.hello, HelloSchema),
    offer: async (endpoint, body: OfferRequest): Promise<OfferAnswer> =>
      (await call(endpoint, 'POST', PAIRING_PATHS.offer, OfferAnswerSchema, body)).answer,
    reveal: async (endpoint, body) => {
      await call(endpoint, 'POST', PAIRING_PATHS.reveal, Ok, body)
    },
    poll: async (endpoint, pairingId): Promise<AgentPairingPoll> =>
      (await call(endpoint, 'POST', PAIRING_PATHS.poll, PollSchema, { pairingId })).poll,
    complete: async (endpoint, body) => {
      await call(endpoint, 'POST', PAIRING_PATHS.complete, Ok, body)
    },
    reject: async (endpoint, pairingId) => {
      await call(endpoint, 'POST', PAIRING_PATHS.cancel, Ok, { pairingId })
    },
  }
}

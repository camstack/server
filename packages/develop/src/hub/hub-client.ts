/**
 * A tRPC caller for the hub, shared by `scripts/hub/hub.mjs` and the operator
 * MCP. It speaks the wire (`/trpc/<path>`, `{ json }` envelope, superjson Date
 * metadata) over `node:https` with the TLS trust from `hub-tls.ts`; there is
 * no login in here — the bearer comes from the credential chain.
 */
import * as http from 'node:http'
import * as https from 'node:https'
import { Buffer } from 'node:buffer'
import { createHubAgent, explainTlsFailure, type HubTlsConfig } from './hub-tls.js'

export type HubHttpMethod = 'GET' | 'POST'

export interface HubTransportRequest {
  readonly url: string
  readonly method: HubHttpMethod
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly tls: HubTlsConfig
}

export interface HubTransportResponse {
  readonly status: number
  readonly text: string
}

/** The wire, injectable so tests never open a socket. */
export type HubTransport = (req: HubTransportRequest) => Promise<HubTransportResponse>

export class HubHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly path: string,
  ) {
    super(message)
    this.name = 'HubHttpError'
  }
}

/** The hub answered with a tRPC error envelope. */
export class HubRpcError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly path: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'HubRpcError'
  }
}

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

export const nodeHubTransport: HubTransport = (req) =>
  new Promise<HubTransportResponse>((resolve, reject) => {
    const parsed = new URL(req.url)
    const isHttps = parsed.protocol === 'https:'
    const options: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: req.method,
      headers: { ...req.headers },
      timeout: req.timeoutMs,
      ...(isHttps ? { agent: createHubAgent(req.tls) } : {}),
    }
    const onResponse = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > req.maxBytes) {
          res.destroy(new Error(`response larger than ${req.maxBytes} bytes — narrow the query`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
        }),
      )
      res.on('error', reject)
    }
    const request = isHttps ? https.request(options, onResponse) : http.request(options, onResponse)
    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy(new Error(`hub request to ${parsed.host} timed out after ${req.timeoutMs}ms`))
    })
    if (req.body !== undefined) request.write(req.body)
    request.end()
  })

interface EncodedInput {
  readonly json: unknown
  readonly meta?: {
    readonly values: Readonly<Record<string, readonly string[]>>
  }
}

/**
 * The `{ json, meta }` envelope for an input. A `Date` travels as its ISO
 * string and is named in `meta.values` so the hub's superjson revives it.
 */
export function encodeTrpcInput(input: unknown): EncodedInput {
  const dates: Record<string, readonly string[]> = {}
  const walk = (value: unknown, at: string): unknown => {
    if (value instanceof Date) {
      dates[at] = ['Date']
      return value.toISOString()
    }
    if (Array.isArray(value)) return value.map((v, i) => walk(v, at === '' ? `${i}` : `${at}.${i}`))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined) continue
        out[k] = walk(v, at === '' ? k : `${at}.${k}`)
      }
      return out
    }
    return value
  }
  const json = walk(input, '')
  return Object.keys(dates).length > 0 ? { json, meta: { values: dates } } : { json }
}

export interface HubClientOptions {
  readonly baseUrl: string
  readonly token: string
  readonly tls?: HubTlsConfig
  readonly transport?: HubTransport
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /**
   * Called ONCE per request when the hub answers 401: return a fresh token
   * (the session was refreshed) to retry with, or `undefined` to surface the
   * 401. Throwing surfaces that error instead.
   */
  readonly onUnauthorized?: () => Promise<string | undefined>
}

export interface HubClient {
  call(method: HubHttpMethod, path: string, input?: unknown): Promise<unknown>
}

function readError(
  body: unknown,
): { readonly message: string; readonly code: string | undefined } | null {
  if (body === null || typeof body !== 'object') return null
  const error: unknown = Reflect.get(body, 'error')
  if (error === null || typeof error !== 'object') return null
  const inner: unknown = Reflect.get(error, 'json') ?? error
  const message: unknown =
    inner !== null && typeof inner === 'object' ? Reflect.get(inner, 'message') : undefined
  const code: unknown =
    inner !== null && typeof inner === 'object' ? Reflect.get(inner, 'code') : undefined
  return {
    message: typeof message === 'string' ? message : JSON.stringify(error).slice(0, 400),
    code: typeof code === 'string' ? code : undefined,
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isUnauthorized(err: unknown): boolean {
  return (err instanceof HubRpcError || err instanceof HubHttpError) && err.status === 401
}

export function createHubClient(options: HubClientOptions): HubClient {
  const transport = options.transport ?? nodeHubTransport
  const base = options.baseUrl.replace(/\/+$/, '')
  let token = options.token

  async function attempt(method: HubHttpMethod, path: string, input: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (token !== '') headers['authorization'] = `Bearer ${token}`
    let url = `${base}/trpc/${path}`
    let body: string | undefined
    if (method === 'POST') {
      body = JSON.stringify(encodeTrpcInput(input))
    } else if (input !== undefined) {
      url += `?input=${encodeURIComponent(JSON.stringify(encodeTrpcInput(input)))}`
    }
    let res: HubTransportResponse
    try {
      res = await transport({
        url,
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        tls: options.tls ?? {},
      })
    } catch (err) {
      const explained = explainTlsFailure(base, err)
      if (explained) throw new Error(explained, { cause: err })
      throw err
    }
    const parsed = parseJson(res.text)
    const rpcError = readError(parsed)
    if (rpcError) throw new HubRpcError(rpcError.message, rpcError.code, path, res.status)
    if (res.status < 200 || res.status >= 300) {
      throw new HubHttpError(
        `${path}: HTTP ${res.status} ${res.text.slice(0, 200)}`,
        res.status,
        path,
      )
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new HubHttpError(`${path}: response is not a tRPC envelope`, res.status, path)
    }
    const result: unknown = Reflect.get(parsed, 'result')
    const data: unknown =
      result !== null && typeof result === 'object' ? Reflect.get(result, 'data') : undefined
    if (data !== null && typeof data === 'object' && 'json' in data)
      return Reflect.get(data, 'json')
    return data
  }

  return {
    async call(method, path, input) {
      try {
        return await attempt(method, path, input)
      } catch (err) {
        if (!isUnauthorized(err) || !options.onUnauthorized) throw err
        const fresh = await options.onUnauthorized()
        if (fresh === undefined || fresh === token) throw err
        token = fresh
        return attempt(method, path, input)
      }
    },
  }
}

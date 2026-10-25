/**
 * Hub HTTP transport for the CLI.
 *
 * camstack hubs serve a SELF-SIGNED cert on the LAN by default. Rather
 * than flip the process-global `NODE_TLS_REJECT_UNAUTHORIZED` env var —
 * which disables TLS verification for EVERY https client in the process
 * and trips a Node runtime warning — we route hub calls through
 * `node:https` with a per-request `https.Agent({ rejectUnauthorized:
 * false })`. TLS verification stays ON for every other https client in
 * the process (e.g. the npm-registry update check).
 *
 * undici / the global `fetch` exposes no per-request `rejectUnauthorized`
 * knob, so hub traffic must use `node:https` to attach the custom agent.
 * Every call here targets the hub, so the insecure agent is always the
 * right one; non-hub HTTP (npm registry) keeps using global `fetch`.
 */
import type { IncomingHttpHeaders } from 'node:http'
import * as http from 'node:http'
import * as https from 'node:https'
import { Buffer } from 'node:buffer'

/**
 * Shared agent that accepts the hub's self-signed LAN cert. Scoped to
 * hub requests only — never installed globally.
 */
const insecureHubAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false })

const DEFAULT_TIMEOUT_MS = 30_000

export interface HubRequestOptions {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Buffer
  readonly timeoutMs?: number
}

/**
 * Buffered response with a `fetch`-like surface (the subset the CLI uses).
 * `text()` / `json()` resolve from the already-buffered body; `json()`
 * rejects on invalid JSON, matching `fetch` semantics so existing
 * `.catch(() => …)` guards keep working.
 */
export interface HubResponse {
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly headers: IncomingHttpHeaders
  text(): Promise<string>
  json(): Promise<unknown>
}

/**
 * Issue a single request to the hub over `node:https` (or `node:http` for
 * a plain-HTTP hub URL). The self-signed-cert agent is attached only for
 * `https:` URLs — verification is never disabled process-wide.
 */
export function hubRequest(url: string, opts: HubRequestOptions = {}): Promise<HubResponse> {
  const parsed = new URL(url)
  const isHttps = parsed.protocol === 'https:'
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<HubResponse>((resolve, reject) => {
    const requestOptions: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: opts.method ?? 'GET',
      headers: { ...opts.headers },
      timeout: timeoutMs,
      ...(isHttps ? { agent: insecureHubAgent } : {}),
    }

    const onResponse = (res: http.IncomingMessage): void => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const buffer = Buffer.concat(chunks)
        const status = res.statusCode ?? 0
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: res.statusMessage ?? '',
          headers: res.headers,
          text: () => Promise.resolve(buffer.toString('utf8')),
          json: () => Promise.resolve().then((): unknown => JSON.parse(buffer.toString('utf8'))),
        })
      })
      res.on('error', reject)
    }

    const req = isHttps
      ? https.request(requestOptions, onResponse)
      : http.request(requestOptions, onResponse)

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error(`Hub request to ${parsed.host} timed out after ${timeoutMs}ms`))
    })
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

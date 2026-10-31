/**
 * Hub HTTP transport for the CLI.
 *
 * A hub on the LAN serves a self-signed (or privately issued) certificate. The
 * CLI never switches verification off: it trusts the PEM the operator pinned
 * for THAT hub (`~/.camstack/<host>_<port>.ca.pem`, or `$CAMSTACK_HUB_CA_FILE`),
 * through the same `resolveHubTls` / `createHubAgent` the MCP and `develop`
 * use (D835). A hub with a publicly trusted certificate needs no pin.
 *
 * undici / the global `fetch` exposes no per-request CA, so hub traffic uses
 * `node:https` with a per-request agent; non-hub HTTP (npm registry) keeps
 * using global `fetch`.
 */
import type { IncomingHttpHeaders } from 'node:http'
import * as http from 'node:http'
import * as https from 'node:https'
import { Buffer } from 'node:buffer'
import { createHubAgent, explainTlsFailure, resolveHubTls } from '@camstack/develop'

const DEFAULT_TIMEOUT_MS = 30_000

export interface HubRequestOptions {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string | Buffer
  readonly timeoutMs?: number
  /** Where pinned CAs live; defaults to `~/.camstack`. */
  readonly sessionDir?: string
  /** Environment for `CAMSTACK_HUB_CA_FILE`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>
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
 * a plain-HTTP hub URL). The pinned-CA agent is attached only for
 * `https:` URLs; verification is never disabled.
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
      ...(isHttps
        ? { agent: createHubAgent(resolveHubTls(parsed.origin, opts.env, opts.sessionDir)) }
        : {}),
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

    req.on('error', (err) => {
      const explained = isHttps
        ? explainTlsFailure(`${parsed.protocol}//${parsed.host}`, err)
        : null
      reject(explained === null ? err : new Error(explained, { cause: err }))
    })
    req.on('timeout', () => {
      req.destroy(new Error(`Hub request to ${parsed.host} timed out after ${timeoutMs}ms`))
    })
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

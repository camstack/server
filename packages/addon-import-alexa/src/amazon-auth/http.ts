/**
 * The one HTTPS seam of the in-house Amazon sign-in. Every call to Amazon (device registration,
 * token and cookie exchange, the csrf probe, the device-code poll) goes through an injected
 * {@link AmazonHttp}, so no spec touches the network.
 *
 * Adapted from the request handling of alexa-cookie2 (MIT, Copyright (c) Apollon77 and
 * contributors); see assets/alexa-cookie2.LICENSE.md.
 */
import https from 'node:https'

/** One HTTPS call to Amazon. */
export interface AmazonHttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT'
  readonly host: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  readonly body?: string
}

export interface AmazonHttpResponse {
  readonly status: number
  /** The raw `Location` of a redirect, or null. */
  readonly location: string | null
  readonly setCookies: readonly string[]
  readonly text: string
  /** The parsed JSON body, or null when it was not JSON. */
  readonly json: unknown
}

export type AmazonHttp = (req: AmazonHttpRequest) => Promise<AmazonHttpResponse>

const REQUEST_TIMEOUT_MS = 20_000

/** No Amazon answer in this flow is larger; a bigger body is cut off rather than buffered. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** Read a response body as text, rejecting as soon as it grows past {@link MAX_RESPONSE_BYTES}. */
export function readCappedBody(stream: AsyncIterable<Buffer | string>): Promise<string> {
  return (async () => {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      total += buffer.length
      if (total > MAX_RESPONSE_BYTES) throw new Error('Amazon response too large')
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  })()
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export const defaultAmazonHttp: AmazonHttp = (req) =>
  new Promise<AmazonHttpResponse>((resolve, reject) => {
    const headers: Record<string, string> = { ...req.headers }
    if (req.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(req.body))
    const r = https.request(
      { host: req.host, path: req.path, method: req.method, headers },
      (res) => {
        readCappedBody(res).then(
          (text) => {
            const location = res.headers.location
            resolve({
              status: res.statusCode ?? 0,
              location: typeof location === 'string' ? location : null,
              setCookies: res.headers['set-cookie'] ?? [],
              text,
              json: parseJson(text),
            })
          },
          (err: unknown) => {
            res.destroy()
            reject(err instanceof Error ? err : new Error(String(err)))
          },
        )
      },
    )
    r.setTimeout(REQUEST_TIMEOUT_MS, () => r.destroy(new Error('timeout')))
    r.on('error', reject)
    r.end(req.body)
  })

/** Thrown when Amazon rejects the stored registration: the account must sign in again. */
export class AmazonAuthRejectedError extends Error {
  readonly statusCode: number
  constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'AmazonAuthRejectedError'
    this.statusCode = statusCode
  }
}

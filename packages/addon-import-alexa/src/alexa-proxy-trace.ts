/**
 * Sanitised one-line trace of the alexa-cookie2 proxy's own log lines.
 *
 * alexa-cookie2 logs every step it takes (routing, upstream request, redirect),
 * but its lines also carry headers, cookies and query values. This keeps only
 * what diagnoses a failed login: the method, the path or upstream host, and the
 * redirect target — always WITHOUT a query string or fragment. Any line that is
 * not one of the known step lines yields `null` and is never traced.
 */

import { formatUrlParams } from './alexa-url-params.js'

const ROUTER_RE = /^Router: (\S+) \/ ([A-Z]+) \/ (.*)$/
const INITIAL_REQUEST_RE = /^Alexa-Cookie: Initial Page Request: (\S+)$/
const USER_AGENT_RE = /"user-agent":"([^"]*)"/i
const PROXY_REQUEST_RE = /^Alexa-Cookie: Proxy-Request: ([A-Z]+) (\S+)$/
const PROXY_RESPONSE_RE = /^Alexa-Cookie: Proxy Response from Host: (\S+)$/
const REDIRECT_ORIGINAL_RE = /^Redirect: Original Location ----> (\S+)$/
const REDIRECT_FINAL_RE = /^Redirect: Final Location ----> (\S+)$/

/** Cut a URL or path at its query string or fragment. */
function stripQuery(target: string): string {
  const cut = target.search(/[?#]/)
  return cut === -1 ? target : target.slice(0, cut)
}

/** The target without its query, plus the value-free parameter summary. */
function withParams(target: string): string {
  return `${stripQuery(target)} ${formatUrlParams(target)}`
}

/** Browser family of the header block's user-agent; the string itself is never kept. */
function userAgentFamily(headers: string): string {
  const ua = USER_AGENT_RE.exec(headers)?.[1]
  if (ua === undefined) return 'none'
  if (/CriOS|Chrome|Chromium|Edg\//.test(ua)) return 'chrome'
  if (/Firefox|FxiOS/.test(ua)) return 'firefox'
  if (/Safari/.test(ua)) return 'safari'
  return 'other'
}

export function sanitizeProxyTraceLine(line: string): string | null {
  const router = ROUTER_RE.exec(line)
  if (router !== null) {
    return `router ${router[2]} ${withParams(router[1] ?? '')} ua=${userAgentFamily(router[3] ?? '')}`
  }
  const initial = INITIAL_REQUEST_RE.exec(line)
  if (initial !== null) return `initial-request ${withParams(initial[1] ?? '')}`
  const request = PROXY_REQUEST_RE.exec(line)
  if (request !== null) return `proxy-request ${request[1]} ${withParams(request[2] ?? '')}`
  const response = PROXY_RESPONSE_RE.exec(line)
  if (response !== null) return `proxy-response host=${response[1]}`
  const original = REDIRECT_ORIGINAL_RE.exec(line)
  if (original !== null) return `redirect-original ${withParams(original[1] ?? '')}`
  const final = REDIRECT_FINAL_RE.exec(line)
  if (final !== null) return `redirect-final ${withParams(final[1] ?? '')}`
  return null
}

/**
 * Sanitised one-line trace of the alexa-cookie2 proxy's own log lines.
 *
 * alexa-cookie2 logs every step it takes (routing, upstream request, redirect),
 * but its lines also carry headers, cookies and query values. This keeps only
 * what diagnoses a failed login: the method, the path or upstream host, and the
 * redirect target — always WITHOUT a query string or fragment. Any line that is
 * not one of the known step lines yields `null` and is never traced.
 */

const ROUTER_RE = /^Router: (\S+) \/ ([A-Z]+) \//
const PROXY_REQUEST_RE = /^Alexa-Cookie: Proxy-Request: ([A-Z]+) (\S+)$/
const PROXY_RESPONSE_RE = /^Alexa-Cookie: Proxy Response from Host: (\S+)$/
const REDIRECT_ORIGINAL_RE = /^Redirect: Original Location ----> (\S+)$/
const REDIRECT_FINAL_RE = /^Redirect: Final Location ----> (\S+)$/

/** Cut a URL or path at its query string or fragment. */
function stripQuery(target: string): string {
  const cut = target.search(/[?#]/)
  return cut === -1 ? target : target.slice(0, cut)
}

export function sanitizeProxyTraceLine(line: string): string | null {
  const router = ROUTER_RE.exec(line)
  if (router !== null) return `router ${router[2]} ${stripQuery(router[1] ?? '')}`
  const request = PROXY_REQUEST_RE.exec(line)
  if (request !== null) return `proxy-request ${request[1]} ${stripQuery(request[2] ?? '')}`
  const response = PROXY_RESPONSE_RE.exec(line)
  if (response !== null) return `proxy-response host=${response[1]}`
  const original = REDIRECT_ORIGINAL_RE.exec(line)
  if (original !== null) return `redirect-original ${stripQuery(original[1] ?? '')}`
  const final = REDIRECT_FINAL_RE.exec(line)
  if (final !== null) return `redirect-final ${stripQuery(final[1] ?? '')}`
  return null
}

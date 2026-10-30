/**
 * Names-only trace of one proxied login request (D955). A sign-in that loses a parameter on
 * the way (an OAuth extension, a hidden field) is invisible in the page flow; this says WHICH
 * request still carried it. Everything here is a NAME, a count, a status or a boolean: no
 * query value, form value, cookie value or attempt id ever leaves this module.
 */

/** The most trace lines one login attempt writes; an attempt lives minutes, this is a backstop. */
export const FLOW_TRACE_MAX_LINES = 200

export interface FlowTraceInput {
  readonly attemptId: string
  readonly method: string
  readonly upstreamHost: string
  readonly upstreamPath: string
  readonly requestSearch: string
  /** The raw urlencoded request body of a form POST, or null. */
  readonly formBody: string | null
  readonly contentType: string | undefined
  readonly status: number
  readonly location: string | null
  readonly setCookies: readonly string[]
  readonly cookieHeader: string | undefined
}

/** A short stable label for the attempt: enough to group lines, useless as a capability. */
export function attemptLabel(attemptId: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < attemptId.length; i += 1) {
    hash = Math.imul(hash ^ attemptId.charCodeAt(i), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Distinct parameter names of a `?a=1&b=2` string (or of a urlencoded body), in order. */
export function paramNames(query: string): string[] {
  const names: string[] = []
  const raw = query.startsWith('?') ? query.slice(1) : query
  for (const pair of raw.split('&')) {
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    const rawName = eq === -1 ? pair : pair.slice(0, eq)
    let name: string
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '))
    } catch {
      name = rawName
    }
    if (!names.includes(name)) names.push(name)
  }
  return names
}

export function hasOa2(names: readonly string[]): boolean {
  return names.some((name) => name.startsWith('openid.oa2.') || name === 'openid.ns.oa2')
}

function cookieNamesOf(setCookies: readonly string[]): string[] {
  return setCookies.map((c) => c.split(';')[0]?.split('=')[0]?.trim() ?? '')
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? 'none').split(';')[0]?.trim().toLowerCase() || 'none'
}

/** Host and path of a Location (no query), or 'unparsable'. */
function locationShape(location: string, base: string): { target: string; names: string[] } {
  try {
    const url = new URL(location, base)
    return {
      target: `${url.host}${url.pathname}`,
      names: paramNames(url.search),
    }
  } catch {
    return { target: 'unparsable', names: [] }
  }
}

/** The `meta` of one trace line. Values: never. */
export function flowTraceMeta(input: FlowTraceInput): Record<string, string | number | boolean> {
  const queryNames = paramNames(input.requestSearch)
  const formNames = input.formBody === null ? null : paramNames(input.formBody)
  const meta: Record<string, string | number | boolean> = {
    session: attemptLabel(input.attemptId),
    method: input.method,
    upstream: `${input.upstreamHost}${input.upstreamPath}`,
    queryNames: queryNames.join(',') || 'none',
    oa2InQuery: hasOa2(queryNames),
    status: input.status,
    setCookieNames: cookieNamesOf(input.setCookies).join(',') || 'none',
    cookiesSent: (input.cookieHeader ?? '').split(';').filter((p) => p.trim().length > 0).length,
  }
  if (formNames !== null) {
    meta['contentType'] = mediaType(input.contentType)
    meta['formNames'] = formNames.join(',') || 'none'
    meta['oa2InForm'] = hasOa2(formNames)
  }
  if (input.location !== null) {
    const loc = locationShape(input.location, `http://${input.upstreamHost}/`)
    meta['location'] = loc.target
    meta['locationQueryNames'] = loc.names.join(',') || 'none'
    meta['oa2InLocation'] = hasOa2(loc.names)
  }
  return meta
}

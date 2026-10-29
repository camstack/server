/**
 * Describe a URL for the sign-in trace WITHOUT leaking any value: the path and
 * the sorted parameter NAMES only, plus the flags that matter when Amazon ends a
 * login without an authorization code. Query values and fragments are never
 * read into the result.
 */
export interface UrlParamsDescription {
  readonly path: string
  readonly names: readonly string[]
  /** Any `openid.oa2.*` parameter is present. */
  readonly oa2: boolean
  readonly returnTo: boolean
  readonly assocHandle: boolean
  readonly mode: boolean
}

const BASE = 'http://placeholder.invalid'

export function describeUrlParams(url: string): UrlParamsDescription {
  let parsed: URL
  try {
    parsed = new URL(url, BASE)
  } catch {
    return {
      path: '',
      names: [],
      oa2: false,
      returnTo: false,
      assocHandle: false,
      mode: false,
    }
  }
  const names = [...new Set(parsed.searchParams.keys())].sort()
  return {
    path: parsed.pathname,
    names,
    oa2: names.some((n) => n.startsWith('openid.oa2.')),
    returnTo: names.includes('openid.return_to'),
    assocHandle: names.includes('openid.assoc_handle'),
    mode: names.includes('openid.mode'),
  }
}

/** One-line, value-free rendering of {@link describeUrlParams}. */
export function formatUrlParams(url: string): string {
  const d = describeUrlParams(url)
  return `names=[${d.names.join(',')}] oa2=${d.oa2} return_to=${d.returnTo} assoc_handle=${d.assocHandle} mode=${d.mode}`
}

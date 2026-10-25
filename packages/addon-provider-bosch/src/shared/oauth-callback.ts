export type OAuthCallbackFailure =
  | 'empty'
  | 'no-code'
  | 'state-missing'
  | 'state-mismatch'
  | 'denied'

export type OAuthCallbackResult =
  | {
      readonly ok: true
      readonly code: string
      readonly params: URLSearchParams
    }
  | { readonly ok: false; readonly reason: OAuthCallbackFailure }

/** A code on its own: no scheme, no query, no separators. */
const BARE_CODE = /^[A-Za-z0-9._~-]+$/

/**
 * What a browser puts on the clipboard around the address: whitespace, quotes or angle
 * brackets, and the `Location:` / `Request URL:` label of a developer-tools header row.
 */
function cleanPaste(input: string): string {
  return input
    .trim()
    .replace(/^(?:location|request url)\s*:\s*/i, '')
    .replace(/^["'<]+|["'>]+$/g, '')
    .trim()
}

function paramsOf(input: string): URLSearchParams {
  try {
    const url = new URL(input)
    const merged = new URLSearchParams(url.search)
    for (const [key, value] of new URLSearchParams(url.hash.replace(/^#/, ''))) {
      if (!merged.has(key)) merged.set(key, value)
    }
    return merged
  } catch {
    // "code=…&state=…" copied from a network panel, with or without a leading ? or #.
    return new URLSearchParams(input.replace(/^[?#]/, ''))
  }
}

/**
 * The authorization code from whatever an operator pasted after a browser sign-in: the full
 * app-scheme address, an address copied from the browser's developer tools, a bare
 * `code=…&state=…` query, or the bare code. Anything that carries a query must carry the
 * `state` of THIS attempt; a bare code has none to check.
 */
export function parseOAuthCallback(input: string, expectedState: string): OAuthCallbackResult {
  const text = cleanPaste(input)
  if (text.length === 0) return { ok: false, reason: 'empty' }
  if (BARE_CODE.test(text)) return { ok: true, code: text, params: new URLSearchParams() }
  const params = paramsOf(text)
  if (params.has('error')) return { ok: false, reason: 'denied' }
  const code = params.get('code')
  if (code === null || code.length === 0) return { ok: false, reason: 'no-code' }
  const state = params.get('state')
  if (state === null) return { ok: false, reason: 'state-missing' }
  if (state !== expectedState) return { ok: false, reason: 'state-mismatch' }
  return { ok: true, code, params }
}

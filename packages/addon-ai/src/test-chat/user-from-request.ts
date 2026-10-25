/**
 * Identity for the test-chat data-plane.
 *
 * The hub authenticates the request (cookie or Bearer) and reverse-proxies
 * the SAME token. We do not re-verify the signature — we cannot, the JWT
 * secret lives on the hub — we only read `userId` from the payload the gate
 * already accepted. A client cannot swap in another user's id without
 * failing that gate.
 */
import type { IncomingMessage } from 'node:http'

const SESSION_COOKIE = 'camstack_session'

function cookieValue(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length === 0) return null
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() !== name) continue
    const raw = pair.slice(eq + 1).trim()
    if (raw.length === 0) return null
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return null
}

function userIdFromJwt(token: string): string | null {
  const parts = token.split('.')
  if (parts.length < 2 || parts[1] === undefined) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const payload = JSON.parse(json) as { userId?: unknown }
    return typeof payload.userId === 'string' && payload.userId.length > 0 ? payload.userId : null
  } catch {
    return null
  }
}

function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (raw === undefined || !raw.startsWith('Bearer ')) return null
  const token = raw.slice('Bearer '.length).trim()
  return token.length > 0 ? token : null
}

export function readUserIdFromRequest(req: IncomingMessage): string | null {
  const fromAuth = bearerToken(req.headers.authorization)
  if (fromAuth !== null) return userIdFromJwt(fromAuth)
  const cookie = Array.isArray(req.headers.cookie) ? req.headers.cookie[0] : req.headers.cookie
  const fromCookie = cookieValue(cookie, SESSION_COOKIE)
  if (fromCookie === null) return null
  return userIdFromJwt(fromCookie)
}

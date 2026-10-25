import { describe, expect, it } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { readUserIdFromRequest } from '../test-chat/user-from-request.js'

function jwtFor(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ userId, isAdmin: false })).toString('base64url')
  return `eyJhbGciOiJub25lIn0.${payload}.sig`
}

function req(headers: Record<string, string>): IncomingMessage {
  const incoming = new IncomingMessage(new Socket())
  incoming.method = 'GET'
  incoming.url = '/'
  for (const [k, v] of Object.entries(headers)) incoming.headers[k] = v
  return incoming
}

describe('readUserIdFromRequest', () => {
  it('reads userId from a Bearer JWT the hub already verified', () => {
    expect(readUserIdFromRequest(req({ authorization: `Bearer ${jwtFor('alice')}` }))).toBe('alice')
  })

  it('falls back to the session cookie', () => {
    expect(readUserIdFromRequest(req({ cookie: `camstack_session=${jwtFor('bob')}` }))).toBe('bob')
  })

  it('prefers Authorization over Cookie — the same token the hub gate used', () => {
    expect(
      readUserIdFromRequest(
        req({
          authorization: `Bearer ${jwtFor('alice')}`,
          cookie: `camstack_session=${jwtFor('bob')}`,
        }),
      ),
    ).toBe('alice')
  })

  it('returns null when there is no session', () => {
    expect(readUserIdFromRequest(req({}))).toBeNull()
    expect(readUserIdFromRequest(req({ authorization: 'Bearer not-a-jwt' }))).toBeNull()
  })
})

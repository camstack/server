import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  clientLogTags,
  createClientLogIngest,
  type ClientLogEntry,
  type ClientLogIdentity,
} from '../client-log-ingest'

interface Shipped {
  readonly entries: readonly ClientLogEntry[]
  readonly source: string
  readonly identity: ClientLogIdentity
}

async function post(
  body: unknown,
  headers: { [name: string]: string } = {},
): Promise<{ shipped: Shipped[]; status: number }> {
  const shipped: Shipped[] = []
  const handler = createClientLogIngest((entries, source, identity) => {
    shipped.push({ entries, source, identity })
  })
  const req = Object.assign(new EventEmitter(), {
    method: 'POST',
    headers,
  }) as unknown as IncomingMessage
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: () => undefined,
  } as unknown as ServerResponse
  handler(req, res)
  req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  return { shipped, status: res.statusCode }
}

const entry = { ts: 1, level: 'warn', scope: 'live', msg: 'stalled' }

describe('client-log ingest identity', () => {
  it('still accepts an old viewer payload with none of the new fields', async () => {
    const { shipped, status } = await post({ entries: [entry] })
    expect(status).toBe(200)
    expect(shipped).toHaveLength(1)
    expect(shipped[0]?.identity).toEqual({
      user: null,
      platform: null,
      appVersion: null,
      sessionId: null,
    })
    expect(clientLogTags(shipped[0]!.identity)).toEqual({ source: 'viewer' })
  })

  it('takes the user from the hub header, never from the body', async () => {
    const { shipped } = await post(
      { entries: [entry], user: 'mallory', client: { user: 'mallory', platform: 'ios' } },
      { 'x-camstack-user': encodeURIComponent('gian luca') },
    )
    expect(shipped[0]?.identity.user).toBe('gian luca')
    expect(shipped[0]?.identity.platform).toBe('ios')
  })

  it('a body naming a user with no hub header attributes nobody', async () => {
    const { shipped } = await post({
      entries: [entry],
      user: 'mallory',
      client: { user: 'mallory' },
    })
    expect(shipped[0]?.identity.user).toBeNull()
  })

  it('carries platform, appVersion and a per-launch session as typed tags', async () => {
    const { shipped } = await post(
      {
        entries: [entry],
        client: { platform: 'android', appVersion: '1.4.2', sessionId: 'a1b2-c3' },
      },
      { 'x-camstack-user': 'admin' },
    )
    expect(clientLogTags(shipped[0]!.identity)).toEqual({
      source: 'viewer',
      user: 'admin',
      platform: 'android',
      appVersion: '1.4.2',
      clientSessionId: 'a1b2-c3',
    })
  })

  it('drops a client field that is not a short token instead of tagging it', async () => {
    const { shipped } = await post({
      entries: [entry],
      client: { platform: 'ios\nforged: line', appVersion: 'x'.repeat(200) },
    })
    expect(shipped[0]?.identity.platform).toBeNull()
    expect(shipped[0]?.identity.appVersion).toBeNull()
  })
})

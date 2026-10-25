/**
 * Data-plane chat list/resume + throwaway POST still writes nothing.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { OutgoingHttpHeader } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { ChatStore } from '../test-chat/chat-store.js'
import { createTestChatPlaneHandler } from '../test-chat/plane.js'
import type { TestChatStreamDeps } from '../test-chat/run-stream.js'
import { makeAiRecords } from './support/fake-records.js'
import { createTestLogger } from './support/logger.js'
import { makeProfile } from './support/profile.js'

function jwtFor(userId: string): string {
  const payload = Buffer.from(JSON.stringify({ userId })).toString('base64url')
  return `eyJhbGciOiJub25lIn0.${payload}.sig`
}

function makeReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = url
  for (const [k, v] of Object.entries(headers)) req.headers[k] = v
  if (body !== undefined) {
    const buf = Buffer.from(body)
    req.headers['content-length'] = String(buf.byteLength)
    queueMicrotask(() => {
      req.push(buf)
      req.push(null)
    })
  } else {
    queueMicrotask(() => req.push(null))
  }
  return req
}

interface Recorded {
  statusCode: number
  headers: Record<string, OutgoingHttpHeader>
  chunks: Buffer[]
}

function makeRes(req: IncomingMessage): { res: ServerResponse; recorded: Recorded } {
  const recorded: Recorded = { statusCode: 200, headers: {}, chunks: [] }
  const res = new ServerResponse(req)
  res.assignSocket(new Socket())
  res.writeHead = ((code: number, hdrs?: Record<string, string | number | string[]>) => {
    recorded.statusCode = code
    if (hdrs) for (const [k, v] of Object.entries(hdrs)) recorded.headers[k] = v
    return res
  }) as typeof res.writeHead
  res.write = ((chunk: unknown) => {
    recorded.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    return true
  }) as typeof res.write
  res.end = ((chunk?: unknown) => {
    if (chunk !== undefined && chunk !== null) {
      recorded.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    }
    return res
  }) as typeof res.end
  res.flushHeaders = () => {}
  return { res, recorded }
}

function bodyText(recorded: Recorded): string {
  return Buffer.concat(recorded.chunks).toString('utf8')
}

async function settled(recorded: Recorded): Promise<string> {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setImmediate(r))
    if (bodyText(recorded).length > 0 || recorded.statusCode !== 200) break
  }
  await new Promise((r) => setImmediate(r))
  return bodyText(recorded)
}

function streamDeps(): TestChatStreamDeps {
  const log = createTestLogger()
  return {
    getProfile: async () =>
      makeProfile({
        id: 'p1',
        name: 'Mac LM Studio',
        model: 'm',
        supportsVision: true,
      }),
    openStream: async () => ({
      kind: 'open',
      chunks: (async function* () {
        yield { kind: 'token' as const, text: 'pong' }
        yield { kind: 'end' as const, inputTokens: 1, outputTokens: 1, truncated: false }
      })(),
    }),
    generateOnce: async () => ({
      ok: true,
      text: 'pong',
      model: 'm',
      usage: { inputTokens: 1, outputTokens: 1 },
      truncated: false,
      latencyMs: 1,
    }),
    getSnapshot: async () => null,
    getTrackMedia: async () => [],
    recordUsage: vi.fn(async () => {}),
    logger: log.logger,
    now: () => 1_000,
  }
}

async function harness(): Promise<{
  handler: ReturnType<typeof createTestChatPlaneHandler>
  chats: ChatStore
}> {
  const chats = ChatStore.of((await makeAiRecords()).records, () => 1_000)
  const log = createTestLogger()
  const handler = createTestChatPlaneHandler({
    stream: streamDeps(),
    logger: log.logger,
    chats,
  })
  return { handler, chats }
}

describe('test-chat plane — list/get by user', () => {
  it('lists only the caller’s chats and refuses another user’s id', async () => {
    const { handler, chats } = await harness()
    const aliceChat = await chats.create('alice', [{ role: 'user', content: 'from alice' }])
    await chats.create('bob', [{ role: 'user', content: 'from bob' }])

    const listReq = makeReq('GET', '/chats', { authorization: `Bearer ${jwtFor('alice')}` })
    const listRes = makeRes(listReq)
    await handler(listReq, listRes.res)
    const listed = JSON.parse(await settled(listRes.recorded)) as { chats: { id: string }[] }
    expect(listed.chats.map((c) => c.id)).toEqual([aliceChat.id])

    const stealReq = makeReq('GET', `/chats/${aliceChat.id}`, {
      authorization: `Bearer ${jwtFor('bob')}`,
    })
    const stealRes = makeRes(stealReq)
    await handler(stealReq, stealRes.res)
    expect(stealRes.recorded.statusCode).toBe(404)
  })

  it('GET /chats/:id returns messages including mediaSent', async () => {
    const { handler, chats } = await harness()
    const created = await chats.create('alice', [
      {
        role: 'user',
        content: 'what',
        mediaSent: {
          kind: 'snapshot',
          mimeType: 'image/jpeg',
          sizeBytes: 3,
          thumbnailBase64: 'QUJD',
        },
      },
    ])
    const req = makeReq('GET', `/chats/${created.id}`, {
      authorization: `Bearer ${jwtFor('alice')}`,
    })
    const res = makeRes(req)
    await handler(req, res.res)
    const json = JSON.parse(await settled(res.recorded)) as {
      messages: { mediaSent: { thumbnailBase64: string } }[]
    }
    expect(json.messages[0]?.mediaSent.thumbnailBase64).toBe('QUJD')
  })
})

describe('test-chat plane — throwaway POST writes nothing', () => {
  it('a POST without persist leaves the store empty', async () => {
    const { handler, chats } = await harness()
    const req = makeReq(
      'POST',
      '/',
      {
        authorization: `Bearer ${jwtFor('alice')}`,
        'content-type': 'application/json',
      },
      JSON.stringify({ profileId: 'p1', messages: [{ role: 'user', content: 'ping' }] }),
    )
    const res = makeRes(req)
    await handler(req, res.res)
    await settled(res.recorded)
    expect(await chats.list('alice')).toEqual([])
  })
})

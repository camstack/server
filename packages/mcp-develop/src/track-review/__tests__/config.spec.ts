import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { saveSession, type HubTransport, type HubTransportRequest } from '@camstack/develop'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createReviewHubProvider, HubConfigError } from '../config.js'
import { registerTrackReviewTools } from '../register.js'

const HUB = 'https://hub.example.test:4443'

let dir: string
let requests: HubTransportRequest[]

const transport: HubTransport = async (req) => {
  requests.push(req)
  return { status: 200, text: JSON.stringify({ result: { data: [] } }) }
}

/** A token with readable claims, so the tier is settled locally with no hub call. */
function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.sig`
}

function session(token: string, isAdmin: boolean): void {
  saveSession(
    {
      server: HUB,
      username: 'op',
      tokenId: 'tid',
      token,
      scopes: [],
      createdAt: 1,
      ...(isAdmin ? { isAdmin: true } : {}),
    },
    dir,
  )
}

function provider(env: Record<string, string | undefined> = {}) {
  return createReviewHubProvider({ env, sessionDir: dir, transport })
}

function sentHeaders(): string {
  return JSON.stringify(requests[0]?.headers)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-'))
  requests = []
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('review hub resolution', () => {
  it('(a) a cached login session alone resolves, hub address included', async () => {
    session('sess-token', true)
    const hub = await provider()('write')
    await hub.listCameras().catch(() => undefined)
    expect(requests[0]?.url).toContain('hub.example.test:4443')
    expect(sentHeaders()).toContain('sess-token')
  })

  it('(b) a token file resolves', async () => {
    const file = path.join(dir, 'tok')
    fs.writeFileSync(file, 'file-token\n', { mode: 0o600 })
    const hub = await provider({
      CAMSTACK_HUB_URL: HUB,
      CAMSTACK_HUB_TOKEN_FILE: file,
    })('read')
    await hub.listCameras().catch(() => undefined)
    expect(sentHeaders()).toContain('file-token')
  })

  it('(c) env wins over a cached session', async () => {
    session('sess-token', true)
    const hub = await provider({
      CAMSTACK_HUB_URL: HUB,
      CAMSTACK_HUB_TOKEN: 'env-token',
    })('read')
    await hub.listCameras().catch(() => undefined)
    expect(sentHeaders()).toContain('env-token')
    expect(sentHeaders()).not.toContain('sess-token')
  })

  it('(d) with nothing, the error names camstack login and the token file', async () => {
    const err = await provider({ CAMSTACK_HUB_URL: HUB })('read').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    const message = err instanceof Error ? err.message : ''
    expect(message).toContain('camstack login')
    expect(message).toContain('CAMSTACK_HUB_TOKEN_FILE')
  })

  it('(e) a non-admin session is refused by the write tools before any hub call', async () => {
    session(jwt({ isAdmin: false }), false)
    const get = provider()
    const err = await get('write').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HubConfigError)
    expect(err instanceof Error ? err.message : '').toMatch(/admin/i)
    expect(requests).toEqual([])

    const server = new McpServer({ name: 't', version: '0' })
    registerTrackReviewTools(server, {
      getHub: get,
      now: () => 0,
      random: () => 0,
    })
    const client = new Client({ name: 'c', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])
    const reply = await client.callTool({
      name: 'track_review_apply',
      arguments: { plan: { tracks: [] }, collectionName: 'x', confirm: true },
    })
    expect(JSON.stringify(reply)).toMatch(/admin/i)
    expect(requests).toEqual([])
  })
})

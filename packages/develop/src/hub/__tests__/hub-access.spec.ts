import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadSession, saveSession, sessionFileForServer } from '../session-store.js'
import { resolveHubUrl } from '../hub-url.js'
import { explainTlsFailure, hubCaFileForServer, resolveHubTls } from '../hub-tls.js'
import {
  createHubClient,
  encodeTrpcInput,
  HubRpcError,
  type HubTransport,
  type HubTransportRequest,
} from '../hub-client.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-hub-access-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const SESSION = {
  server: 'https://hub.example.test:4443',
  username: 'admin',
  tokenId: 't1',
  token: 'tok_abc',
  scopes: [],
  createdAt: 1,
}

describe('session store', () => {
  it('round-trips a session through a 0600 file named after the host', () => {
    const file = saveSession(SESSION, dir)
    expect(file).toBe(sessionFileForServer(SESSION.server, dir))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(loadSession(SESSION.server, dir)?.token).toBe('tok_abc')
  })

  it('treats a malformed cache file as no session', () => {
    fs.writeFileSync(sessionFileForServer(SESSION.server, dir), '{"server":"x"}')
    expect(loadSession(SESSION.server, dir)).toBeNull()
  })

  it('does not mistake a non-session file for a session', () => {
    fs.writeFileSync(path.join(dir, 'hub.lan_4443.admin-token'), 'opaque_x')
    expect(loadSession(undefined, dir)).toBeNull()
  })
})

describe('resolveHubUrl', () => {
  it('prefers flag, then env, then scratchpad, then the session — and never invents one', () => {
    fs.mkdirSync(path.join(dir, 'scratchpad'))
    fs.writeFileSync(path.join(dir, 'scratchpad', '.hub-url'), 'https://scratch.example.test/\n')
    const session = { server: 'https://session.example.test' }
    expect(resolveHubUrl({ explicit: 'https://flag.example.test/', env: {} })?.source).toBe('flag')
    expect(
      resolveHubUrl({ env: { CAMSTACK_HUB_URL: 'https://env.example.test' }, workspaceRoot: dir }),
    ).toEqual({ url: 'https://env.example.test:4443', source: 'env' })
    expect(resolveHubUrl({ env: {}, workspaceRoot: dir, session })).toEqual({
      url: 'https://scratch.example.test:4443',
      source: 'scratchpad',
    })
    expect(resolveHubUrl({ env: {}, session })?.source).toBe('session')
    expect(resolveHubUrl({ env: {} })).toBeUndefined()
  })
})

describe('resolveHubTls', () => {
  it('trusts the pinned PEM next to the session cache, with verification still on', () => {
    fs.writeFileSync(hubCaFileForServer(SESSION.server, dir), 'PEM')
    expect(resolveHubTls(SESSION.server, {}, dir).ca).toBe('PEM')
  })
  it('uses the system store when nothing is pinned, and nothing for plain http', () => {
    expect(resolveHubTls(SESSION.server, {}, dir)).toEqual({})
    expect(resolveHubTls('http://hub.example.test', {}, dir)).toEqual({})
  })
  it('refuses a named CA file that cannot be read instead of falling back', () => {
    expect(() =>
      resolveHubTls(SESSION.server, { CAMSTACK_HUB_CA_FILE: path.join(dir, 'nope') }, dir),
    ).toThrow(/CAMSTACK_HUB_CA_FILE/)
  })
  it('explains a verification failure and never suggests disabling it', () => {
    const err = Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    const text = explainTlsFailure(SESSION.server, err) ?? ''
    expect(text).toContain('.ca.pem')
    expect(text).not.toMatch(/REJECT_UNAUTHORIZED=0/)
    expect(explainTlsFailure(SESSION.server, new Error('boom'))).toBeNull()
  })
})

describe('hub client', () => {
  function fake(reply: unknown, seen: HubTransportRequest[]): HubTransport {
    return async (req) => {
      seen.push(req)
      return { status: 200, text: JSON.stringify(reply) }
    }
  }

  it('sends a bearer, unwraps result.data.json and encodes Dates for superjson', async () => {
    const seen: HubTransportRequest[] = []
    const client = createHubClient({
      baseUrl: 'https://hub.example.test/',
      token: 'tok_abc',
      transport: fake({ result: { data: { json: [1, 2] } } }, seen),
    })
    const out = await client.call('GET', 'logDestination.query', { since: new Date(0), limit: 5 })
    expect(out).toEqual([1, 2])
    expect(seen[0]!.headers['authorization']).toBe('Bearer tok_abc')
    const input = new URL(seen[0]!.url).searchParams.get('input') ?? ''
    expect(JSON.parse(input)).toEqual({
      json: { since: '1970-01-01T00:00:00.000Z', limit: 5 },
      meta: { values: { since: ['Date'] } },
    })
  })

  it('throws a HubRpcError carrying the hub message for an error envelope', async () => {
    const client = createHubClient({
      baseUrl: 'https://hub.example.test',
      token: 't',
      transport: async () => ({
        status: 403,
        text: JSON.stringify({ error: { json: { message: 'FORBIDDEN', code: -32003 } } }),
      }),
    })
    await expect(client.call('GET', 'nodes.topology')).rejects.toBeInstanceOf(HubRpcError)
  })

  it('encodeTrpcInput leaves plain input without meta', () => {
    expect(encodeTrpcInput({ a: 1, b: undefined })).toEqual({ json: { a: 1 } })
  })
})

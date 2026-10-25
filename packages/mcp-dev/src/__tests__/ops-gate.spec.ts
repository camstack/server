import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HubClient, HubHttpMethod, HubTransportRequest } from '@camstack/develop'
import { parseApiIndex } from '../ops/api-index.js'
import { connectOpsHub, createGatedHub, QueryRefusedError, type OpsHub } from '../ops/hub.js'
import { gateQuery } from '../ops/query-gate.js'
import { redactDeclaredSecrets, toToolOutput, truncateOutput } from '../ops/redact.js'

const API_MD = [
  '| tRPC path | kind | auth | capability |',
  '|---|---|---|---|',
  '| `addons.listCapabilityProviders` | query | protected | addons |',
  '| `nodes.topology` | query | admin | nodes |',
  '| `nodes.restartNode` | mutation | admin | nodes |',
  '| `keychain.resolve` | query | admin | keychain |',
  '| `cameraCredentials.getCredentials` | query | admin | camera-credentials |',
  '| `pipelineAnalytics.getTrack` | query | protected | pipeline-analytics |',
].join('\n')

const INDEX = parseApiIndex(API_MD)

describe('parseApiIndex', () => {
  it('reads path, kind, auth and capability from the generated table', () => {
    expect(INDEX.get('nodes.topology')).toEqual({
      path: 'nodes.topology',
      kind: 'query',
      auth: 'admin',
      capability: 'nodes',
    })
    expect(INDEX.size).toBe(6)
  })
})

describe('gateQuery — query-only, tier-checked, never secret-bearing', () => {
  it('allows a protected query with a protected credential', () => {
    expect(gateQuery(INDEX, 'pipelineAnalytics.getTrack', 'protected').allowed).toBe(true)
  })

  it('refuses a mutation, even with an admin credential', () => {
    const d = gateQuery(INDEX, 'nodes.restartNode', 'admin')
    expect(d).toMatchObject({ allowed: false })
    expect(d.allowed === false && d.reason).toMatch(/read-only/)
  })

  it('refuses a path the generator never emitted', () => {
    const d = gateQuery(INDEX, 'nodes.topologyy', 'admin')
    expect(d.allowed === false && d.reason).toMatch(/not in the generated API index/)
  })

  it('refuses an admin-tier query without an admin-scoped credential, allows it with one', () => {
    const refused = gateQuery(INDEX, 'nodes.topology', 'protected')
    expect(refused.allowed).toBe(false)
    expect(refused.allowed === false && refused.reason).toMatch(/admin-tier/)
    expect(gateQuery(INDEX, 'nodes.topology', 'admin').allowed).toBe(true)
  })

  it('refuses queries that return secret material even for admin', () => {
    expect(gateQuery(INDEX, 'keychain.resolve', 'admin').allowed).toBe(false)
    expect(gateQuery(INDEX, 'cameraCredentials.getCredentials', 'admin').allowed).toBe(false)
  })
})

interface Call {
  readonly method: HubHttpMethod
  readonly path: string
  readonly input: unknown
}

function fakeClient(answers: Record<string, unknown> = {}): { client: HubClient; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    client: {
      async call(method, p, input) {
        calls.push({ method, path: p, input })
        return answers[p] ?? null
      },
    },
  }
}

describe('createGatedHub — the client is only reached through the gate', () => {
  it('never calls the client for a refused method, and always uses GET otherwise', async () => {
    const { client, calls } = fakeClient({ 'pipelineAnalytics.getTrack': { ok: true } })
    const hub = createGatedHub({
      server: 'https://hub.example.test',
      tier: 'protected',
      source: 'session',
      index: INDEX,
      client,
    })
    await expect(hub.query('nodes.restartNode', {})).rejects.toBeInstanceOf(QueryRefusedError)
    await expect(hub.query('nodes.topology')).rejects.toBeInstanceOf(QueryRefusedError)
    expect(calls).toHaveLength(0)
    await expect(hub.query('pipelineAnalytics.getTrack', { deviceId: 1 })).resolves.toEqual({
      ok: true,
    })
    expect(calls).toEqual([
      { method: 'GET', path: 'pipelineAnalytics.getTrack', input: { deviceId: 1 } },
    ])
  })
})

describe('redaction and truncation', () => {
  it('redacts stored markers and declared password fields, whatever the key is called', () => {
    const out = redactDeclaredSecrets({
      sections: [
        {
          fields: [
            { key: 'url', type: 'text', value: 'https://loki.example.test' },
            { key: 'apiAccess', type: 'password', value: 'hunter2hunter2', default: 'x' },
            { key: 'other', secret: true, value: 'abcdefgh' },
            { key: 'stored', value: { $secret: 'secret://a/b/c', v: 1 } },
          ],
        },
      ],
    })
    const text = JSON.stringify(out)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('abcdefgh')
    expect(text).not.toContain('secret://')
    expect(text).toContain('https://loki.example.test')
  })

  it('does not mutate its input', () => {
    const input = { f: { type: 'password', value: 'keep-me-12345' } }
    redactDeclaredSecrets(input)
    expect(input.f.value).toBe('keep-me-12345')
  })

  it('cuts long strings, caps arrays and bounds the total', () => {
    const blob = 'A'.repeat(50_000)
    const out = truncateOutput({ frame: blob, rows: Array.from({ length: 500 }, (_, i) => i) })
    const json = JSON.stringify(out)
    expect(json.length).toBeLessThan(30_000)
    expect(json).not.toContain('A'.repeat(2_000))
    expect(json).toContain('more items')
  })

  it('turns an over-budget result into a labelled preview, not a flood', () => {
    const wide = Array.from({ length: 100 }, (_, i) => ({ i, text: 'x'.repeat(900) }))
    const out = toToolOutput(wide)
    expect(out).toMatchObject({ truncated: true })
  })
})

describe('credential chain behind the ops hub', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-chain-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const HUB = 'https://hub.example.test:4443'

  function writeSession(token: string): void {
    fs.writeFileSync(
      path.join(dir, 'hub.example.test_4443.json'),
      JSON.stringify({
        server: HUB,
        username: 'admin',
        tokenId: 't',
        token,
        scopes: [],
        createdAt: 1,
      }),
      { mode: 0o600 },
    )
  }

  async function connect(
    extra: { tokenFile?: string; env?: Record<string, string> } = {},
  ): Promise<{
    hub: OpsHub
    seen: HubTransportRequest[]
  }> {
    const seen: HubTransportRequest[] = []
    const hub = await connectOpsHub({
      workspaceRoot: dir,
      index: INDEX,
      sessionDir: dir,
      server: HUB,
      env: extra.env ?? {},
      ...(extra.tokenFile ? { tokenFile: extra.tokenFile } : {}),
      transport: async (req) => {
        seen.push(req)
        return { status: 200, text: JSON.stringify({ result: { data: { json: [] } } }) }
      },
    })
    return { hub, seen }
  }

  it('uses the cached session (protected tier) when nothing else exists', async () => {
    writeSession('tok_session_token')
    const { hub, seen } = await connect()
    expect(hub).toMatchObject({ source: 'session', tier: 'protected' })
    await hub.query('pipelineAnalytics.getTrack', { deviceId: 1 })
    expect(seen[0]!.headers['authorization']).toBe('Bearer tok_session_token')
  })

  it('keeps the session when a legacy admin-token file exists; --token-file wins over the session', async () => {
    writeSession('tok_session_token')
    fs.writeFileSync(path.join(dir, 'hub.example.test_4443.admin-token'), 'opaque_admin_token', {
      mode: 0o600,
    })
    const sessionHub = await connect()
    expect(sessionHub.hub).toMatchObject({ source: 'session', tier: 'protected' })

    const explicit = path.join(dir, 'explicit')
    fs.writeFileSync(explicit, 'opaque_explicit_admin', { mode: 0o600 })
    const flagHub = await connect({ tokenFile: explicit })
    expect(flagHub.hub).toMatchObject({ source: 'token-file', tier: 'protected' }) // no prefix buys admin
    await flagHub.hub.query('pipelineAnalytics.getTrack', { deviceId: 1 })
    expect(flagHub.seen[0]!.headers['authorization']).toBe('Bearer opaque_explicit_admin')
  })

  it('ignores $CAMSTACK_TOKEN and any password in the environment', async () => {
    await expect(
      connect({ env: { CAMSTACK_TOKEN: 'tok_env_token', HUB_PW: 'pw', CAMSTACK_PASSWORD: 'pw' } }),
    ).rejects.toThrow(/Not logged in/)
  })

  it('verifies TLS against the pinned PEM and never touches the process-wide switch', async () => {
    writeSession('tok_session_token')
    fs.writeFileSync(path.join(dir, 'hub.example.test_4443.ca.pem'), 'PEM-TEXT')
    const before = process.env['NODE_TLS_REJECT_UNAUTHORIZED']
    const { hub, seen } = await connect()
    await hub.query('pipelineAnalytics.getTrack', { deviceId: 1 })
    expect(seen[0]!.tls.ca).toBe('PEM-TEXT')
    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe(before)
  })

  it('has no address to fall back to: it never invents one', async () => {
    await expect(
      connectOpsHub({ workspaceRoot: dir, index: INDEX, sessionDir: dir, env: {} }),
    ).rejects.toThrow(/no hub address/)
  })
})

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseApiIndex,
  type HubClient,
  type HubHttpMethod,
  type HubTransportRequest,
} from '@camstack/develop'
import { connectOpsHub, createGatedHub, QueryRefusedError, type OpsHub } from '../ops/hub.js'

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

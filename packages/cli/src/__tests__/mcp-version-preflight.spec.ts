import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MutationGate, type ConnectOutcome } from '@camstack/develop'
import type { McpContext } from '../mcp/context.js'
import { createPublicServer } from '../mcp/server.js'
import type { VersionProbe } from '../mcp/version-probe.js'

const NO_SESSION: ConnectOutcome = {
  ok: false,
  reason: 'no-session',
  message: 'no usable hub session',
  action: 'run `camstack login <host>` in a terminal',
}

const CTX: McpContext = {
  cliVersion: '1.2.212',
  hub: async () => NO_SESSION,
  gate: new MutationGate({ allowMutations: true }),
  fetch: async () => new Response('{}'),
}

const CURRENT: VersionProbe = {
  server: { state: 'current', running: '1.2.714', latest: '1.2.714' },
  addons: { state: 'current', count: 0, names: [] },
  cli: { state: 'current', installed: '1.2.230', latest: '1.2.230' },
}
const OUTDATED: VersionProbe = {
  server: { state: 'behind', running: '1.2.700', latest: '1.2.714' },
  addons: {
    state: 'behind',
    count: 3,
    names: ['auth', 'reolink', 'hikvision'],
  },
  cli: { state: 'behind', installed: '1.2.212', latest: '1.2.230' },
}
const UNKNOWN_503: VersionProbe = {
  server: { state: 'not-checked', reason: 'no hub session' },
  addons: { state: 'not-checked', reason: 'no hub session' },
  cli: { state: 'unknown', reason: 'registry answered 503' },
}

interface Harness {
  readonly client: Client
  readonly probeCalls: () => number
  readonly clock: { now: number }
  readonly toolRuns: () => number
}

async function harness(probe: () => Promise<VersionProbe>, timeoutMs = 2_000): Promise<Harness> {
  const clock = { now: 1_000_000 }
  let calls = 0
  let runs = 0
  const server = createPublicServer({
    toolsets: ['ops'],
    context: CTX,
    versionPreflight: {
      probe: () => {
        calls += 1
        return probe()
      },
      now: () => clock.now,
      timeoutMs,
    },
    registerDevelop: undefined,
  })
  server.tool('arbitrary_tool', 'a stand-in tool', {}, async () => {
    runs += 1
    return { content: [{ type: 'text', text: 'real answer' }] }
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  return { client, probeCalls: () => calls, clock, toolRuns: () => runs }
}

function texts(result: Awaited<ReturnType<Client['callTool']>>): string[] {
  const content = Array.isArray(result.content) ? result.content : []
  return content.flatMap((c) => (c.type === 'text' ? [c.text] : []))
}

const call = (h: Harness, name = 'arbitrary_tool') => h.client.callTool({ name, arguments: {} })

describe('version preflight', () => {
  it('prepends the warning to an arbitrary tool result when outdated', async () => {
    const h = await harness(async () => OUTDATED)
    const out = texts(await call(h))
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(
      '⚠ CamStack versions: server 1.2.700 → 1.2.714 · 3 addons outdated (auth, reolink, hikvision) · CLI/MCP 1.2.212 → 1.2.230 — run ops_update_check / ops_update_apply.',
    )
    expect(out[1]).toBe('real answer')
  })

  it('names the first three addons and an ellipsis when there are more', async () => {
    const h = await harness(async () => ({
      ...OUTDATED,
      addons: { state: 'behind', count: 5, names: ['a', 'b', 'c'] },
    }))
    expect(texts(await call(h))[0]).toContain('5 addons outdated (a, b, c, …)')
  })

  it('adds nothing when everything is up to date', async () => {
    const h = await harness(async () => CURRENT)
    expect(texts(await call(h))).toEqual(['real answer'])
  })

  it('holds the TTL: one probe for two calls within 15 minutes, another after', async () => {
    const h = await harness(async () => OUTDATED)
    await call(h)
    h.clock.now += 14 * 60_000
    const second = texts(await call(h))
    expect(second[0]).toContain('CamStack versions')
    expect(h.probeCalls()).toBe(1)
    h.clock.now += 2 * 60_000
    await call(h)
    expect(h.probeCalls()).toBe(2)
  })

  it('shares one in-flight probe between concurrent calls', async () => {
    let release: (p: VersionProbe) => void = () => undefined
    const h = await harness(() => new Promise<VersionProbe>((r) => (release = r)))
    const both = Promise.all([call(h), call(h)])
    await new Promise((r) => setTimeout(r, 20))
    release(OUTDATED)
    const [x, y] = await both
    expect(h.probeCalls()).toBe(1)
    expect(texts(x)[0]).toContain('CamStack versions')
    expect(texts(y)[0]).toContain('CamStack versions')
  })

  it('a probe failure says so once per session, then stays silent', async () => {
    const h = await harness(async () => UNKNOWN_503)
    const first = texts(await call(h))
    expect(first[0]).toBe('version check unavailable: CLI/MCP: registry answered 503')
    expect(first[1]).toBe('real answer')
    h.clock.now += 20 * 60_000
    expect(texts(await call(h))).toEqual(['real answer'])
  })

  it('a thrown probe is a failure too, not a failed tool', async () => {
    const h = await harness(async () => {
      throw new Error('boom')
    })
    const out = texts(await call(h))
    expect(out[0]).toBe(
      'version check unavailable: hub server: boom; hub addons: boom; CLI/MCP: boom',
    )
    expect(out[1]).toBe('real answer')
  })

  it('a timeout does not delay the tool, and the late result fills the cache', async () => {
    let release: (p: VersionProbe) => void = () => undefined
    const h = await harness(() => new Promise<VersionProbe>((r) => (release = r)), 30)
    const started = Date.now()
    const first = texts(await call(h))
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(first).toEqual(['real answer'])
    release(OUTDATED)
    await new Promise((r) => setTimeout(r, 20))
    const second = texts(await call(h))
    expect(second[0]).toContain('CamStack versions')
    expect(h.probeCalls()).toBe(1)
  })

  it('version_check bypasses the TTL and does not double-warn', async () => {
    const h = await harness(async () => OUTDATED)
    await call(h)
    const checked = await call(h, 'version_check')
    expect(h.probeCalls()).toBe(2)
    const out = texts(checked)
    expect(out).toHaveLength(1)
    expect(out[0]?.startsWith('{')).toBe(true)
    expect(out[0]).toContain('1.2.714')
  })

  it('an unmeasured part is never reported as up to date', async () => {
    const h = await harness(async () => UNKNOWN_503)
    const body = texts(await call(h, 'version_check'))[0] ?? ''
    expect(body).not.toContain('up to date')
    expect(body).toContain('"status": "incomplete"')
    expect(body).toContain('registry answered 503')
    expect(body).toContain('no hub session')
  })

  it('only a fully measured, current probe says up to date', async () => {
    const h = await harness(async () => CURRENT)
    const body = texts(await call(h, 'version_check'))[0] ?? ''
    expect(body).toContain('everything is up to date')
    expect(body).toContain('"status": "ok"')
  })

  it('leaves a tool error result as it is, with the warning in front', async () => {
    const h = await harness(async () => OUTDATED)
    const r = await h.client.callTool({ name: 'ops_whoami', arguments: {} })
    expect(r.isError).toBe(true)
    expect(texts(r)[0]).toContain('CamStack versions')
    expect(texts(r)[1]).toContain('no-session')
  })
})

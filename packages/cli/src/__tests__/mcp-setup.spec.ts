import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import {
  MutationGate,
  type ConnectOutcome,
  type HubClient,
  type HubHttpMethod,
} from '@camstack/develop'
import type { FetchFn, McpContext } from '../mcp/context.js'
import { createPublicServer } from '../mcp/server.js'
import { composeToDockerRun } from '../mcp/setup-compose.js'
import { addNodeTool, connectTool, discoverHubsTool, type HealthProbe } from '../mcp/setup-hubs.js'
import { installGuide, type GuideReady } from '../mcp/setup-install.js'
import { TEMPLATE_URLS } from '../mcp/setup-install-rules.js'

function fixture(name: string): string {
  return fs.readFileSync(
    fileURLToPath(new URL(`./fixtures/install/${name}`, import.meta.url)),
    'utf8',
  )
}

const BODIES: Readonly<Record<string, string>> = {
  [TEMPLATE_URLS.compose.hub]: fixture('hub.yml'),
  [TEMPLATE_URLS.compose.agent]: fixture('agent.yml'),
  [TEMPLATE_URLS.proxmoxInstaller]: fixture('install-camstack-proxmox.sh'),
  [TEMPLATE_URLS.unraid.hub]: fixture('camstack.xml'),
  [TEMPLATE_URLS.unraid.agent]: fixture('camstack-agent.xml'),
  [TEMPLATE_URLS.latestRelease]: fixture('release.json'),
}

const fakeFetch: FetchFn = async (url) => {
  const body = BODIES[url]
  return body === undefined ? new Response('nope', { status: 404 }) : new Response(body)
}

function ready(r: Awaited<ReturnType<typeof installGuide>>): GuideReady {
  if (r.status !== 'ready') throw new Error(`expected ready, got ${r.status}`)
  return r
}

const PATHS = { data: '/srv/cam/data', recordings: '/mnt/disk/rec' }

describe('setup_install_guide — the interview', () => {
  it('asks only for what is still unknown', async () => {
    const empty = await installGuide({}, fakeFetch)
    expect(empty).toMatchObject({ status: 'need-answers' })
    if (empty.status !== 'need-answers') return
    expect(empty.questions.map((q) => q.id)).toEqual(['hostKind', 'role', 'accelerator'])

    const some = await installGuide({ hostKind: 'docker-compose', role: 'hub' }, fakeFetch)
    if (some.status !== 'need-answers') throw new Error('expected need-answers')
    expect(some.questions.map((q) => q.id)).toEqual(['accelerator', 'paths'])
  })

  it('a Mac needs no accelerator and no paths', async () => {
    const r = await installGuide({ hostKind: 'macos-desktop', role: 'hub' }, fakeFetch)
    expect(r.status).toBe('ready')
  })

  it('apple on a container host is asked again, not accepted', async () => {
    const r = await installGuide(
      {
        hostKind: 'docker-compose',
        role: 'hub',
        accelerator: 'apple',
        paths: PATHS,
      },
      fakeFetch,
    )
    if (r.status !== 'need-answers') throw new Error('expected need-answers')
    expect(r.questions.map((q) => q.id)).toEqual(['accelerator'])
    expect(r.questions[0]?.options).not.toContain('apple')
  })
})

describe('setup_install_guide — routes', () => {
  it('docker-compose: the official file, image tag by accelerator, paths and devices applied', async () => {
    const g = ready(
      await installGuide(
        {
          hostKind: 'docker-compose',
          role: 'hub',
          accelerator: 'intel',
          paths: PATHS,
        },
        fakeFetch,
      ),
    )
    const file = g.files[0]
    expect(file?.source).toBe(TEMPLATE_URLS.compose.hub)
    const body = file?.body ?? ''
    expect(body).toContain('ghcr.io/camstack/camstack:intel-latest')
    expect(body).not.toContain(':amd-latest')
    expect(body).toContain('- /srv/cam/data:/data')
    expect(body).toContain('- /mnt/disk/rec:/recordings')
    expect(body).toMatch(/^ {4}devices:/m)
    expect(body).toMatch(/^ {6}- \/dev\/dri:\/dev\/dri/m)
    expect(body).toMatch(/^ {6}- \/dev\/accel:\/dev\/accel/m)
    expect(body).not.toMatch(/^ {6}- \/dev\/bus\/usb/m)
    expect(g.edits.join('\n')).toContain('/config')
    expect(g.mustNotOmit.join('\n')).toContain('pids')
    expect(g.steps.join('\n')).toContain('admin / changeme')
    expect(g.steps.join('\n')).toContain('camstack login')
  })

  it('docker-compose with a Coral enables the USB bus and the cgroup rule', async () => {
    const g = ready(
      await installGuide(
        {
          hostKind: 'docker-compose',
          role: 'hub',
          accelerator: 'coral',
          paths: PATHS,
        },
        fakeFetch,
      ),
    )
    const body = g.files[0]?.body ?? ''
    expect(body).toMatch(/^ {6}- \/dev\/bus\/usb:\/dev\/bus\/usb/m)
    expect(body).toMatch(/^ {4}device_cgroup_rules:/m)
    expect(body).toMatch(/^ {6}- 'c 189:\* rmw'/m)
    expect(body).not.toMatch(/^ {6}- \/dev\/dri/m)
  })

  it('docker: a docker run derived from the compose file, never a bare latest', async () => {
    const g = ready(
      await installGuide(
        { hostKind: 'docker', role: 'hub', accelerator: 'amd', paths: PATHS },
        fakeFetch,
      ),
    )
    const run = g.files[0]?.body ?? ''
    expect(run).toContain('docker run -d')
    expect(run).toContain('--pids-limit=8192')
    expect(run).toContain('--network host')
    expect(run).toContain('--restart unless-stopped')
    expect(run).toContain('-v /srv/cam/data:/data')
    expect(run).toContain('-e CAMSTACK_MEDIA_ROOT=/recordings')
    expect(run).toContain('ghcr.io/camstack/camstack:amd-latest')
    expect(run).not.toMatch(/camstack:latest/)
    expect(run).toContain('--group-add 44')
  })

  it('an agent takes the agent file and the hub address', async () => {
    const g = ready(
      await installGuide(
        {
          hostKind: 'docker-compose',
          role: 'agent',
          accelerator: 'cpu',
          paths: PATHS,
          hubAddress: '192.0.2.9',
        },
        fakeFetch,
      ),
    )
    expect(g.files[0]?.source).toBe(TEMPLATE_URLS.compose.agent)
    expect(g.files[0]?.body).toContain('CAMSTACK_HUB_ADDRESS=192.0.2.9')
    expect(g.steps.join('\n')).toContain('4444')
    expect(g.steps.join('\n')).toContain('six digits')
  })

  it('unraid: the template URL, the template body, the repository edit', async () => {
    const g = ready(
      await installGuide({ hostKind: 'unraid', role: 'hub', accelerator: 'amd' }, fakeFetch),
    )
    expect(g.steps.join('\n')).toContain(TEMPLATE_URLS.unraid.hub)
    expect(g.files[0]?.body).toContain('<Name>CamStack</Name>')
    expect(g.edits.join('\n')).toContain('ghcr.io/camstack/camstack:amd-latest')
  })

  it('proxmox-lxc: a one-line command with the role, image tag and recordings path', async () => {
    const g = ready(
      await installGuide(
        {
          hostKind: 'proxmox-lxc',
          role: 'agent',
          accelerator: 'intel',
          paths: PATHS,
        },
        fakeFetch,
      ),
    )
    const cmd = g.steps.find((s) => s.includes('install-camstack-proxmox.sh')) ?? ''
    expect(cmd).toContain('ROLE=agent')
    expect(cmd).toContain('IMAGE_TAG=ghcr.io/camstack/camstack:intel-latest')
    expect(cmd).toContain('RECORDINGS_HOST_PATH=/mnt/disk/rec')
    expect(cmd).toContain(TEMPLATE_URLS.proxmoxInstaller)
  })

  it('macos-desktop: both dmg assets of the latest release, no viewer', async () => {
    const g = ready(await installGuide({ hostKind: 'macos-desktop', role: 'hub' }, fakeFetch))
    const text = g.steps.join('\n')
    expect(text).toContain('CamStack-0.1.4-arm64.dmg')
    expect(text).toContain('CamStack-0.1.4-x64.dmg')
    expect(text).not.toContain('CamStackViewer-')
    expect(text).toContain('Hub (full server)')
  })

  it('a failed fetch is a structured result naming the URL, not a throw', async () => {
    const down: FetchFn = async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    const r = await installGuide({ hostKind: 'unraid', role: 'hub', accelerator: 'intel' }, down)
    expect(r).toEqual({
      status: 'fetch-failed',
      url: TEMPLATE_URLS.unraid.hub,
      error: 'getaddrinfo ENOTFOUND',
    })
    const notFound: FetchFn = async () => new Response('x', { status: 404 })
    const r2 = await installGuide({ hostKind: 'macos-desktop', role: 'hub' }, notFound)
    expect(r2).toMatchObject({
      status: 'fetch-failed',
      url: TEMPLATE_URLS.latestRelease,
    })
  })
})

describe('composeToDockerRun', () => {
  it('ignores commented lines and compose interpolation', () => {
    const run = composeToDockerRun(fixture('agent.yml')) ?? ''
    expect(run).not.toContain('/dev/dri')
    expect(run).not.toContain('${')
    expect(run).toContain('-e CAMSTACK_ROLE=agent')
  })
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camstack-setup-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

const OK_HEALTH: HealthProbe = async () => ({ ok: true, status: 200 })

function writeSession(server: string): void {
  fs.writeFileSync(
    path.join(dir, 'hub.example.test_4443.json'),
    JSON.stringify({
      server,
      username: 'admin',
      tokenId: 't',
      token: 'tok_should_never_leak',
      scopes: [],
      createdAt: 1,
    }),
  )
}

describe('setup_connect', () => {
  it('reachable without a session: says to run camstack login, no verification bypass', async () => {
    const r = await connectTool('hub.example.test', {
      sessionDir: dir,
      env: {},
      health: OK_HEALTH,
    })
    expect(r.status).toBe('reachable')
    expect(r.server).toBe('https://hub.example.test:4443')
    expect(r.session).toEqual({ exists: false, username: null })
    expect(r.tls?.caPinned).toBe(false)
    expect(r.next).toContain('camstack login https://hub.example.test:4443')
  })

  it('reports a pinned CA and an existing session', async () => {
    writeSession('https://hub.example.test:4443')
    fs.writeFileSync(path.join(dir, 'hub.example.test_4443.ca.pem'), 'PEM')
    let seenCa: string | undefined
    const r = await connectTool('https://hub.example.test:4443', {
      sessionDir: dir,
      env: {},
      health: async (_u, tls) => {
        seenCa = tls.ca
        return { ok: true, status: 200 }
      },
    })
    expect(seenCa).toBe('PEM')
    expect(r.tls?.caPinned).toBe(true)
    expect(r.session).toEqual({ exists: true, username: 'admin' })
    expect(JSON.stringify(r)).not.toContain('tok_should_never_leak')
  })

  it('an untrusted certificate is reported with the pin instructions, never bypassed', async () => {
    const r = await connectTool('hub.example.test', {
      sessionDir: dir,
      env: {},
      health: async () => ({
        ok: false,
        error: 'self-signed certificate',
        tlsHint: 'TLS verification failed. Verification is never switched off.',
      }),
    })
    expect(r.status).toBe('unreachable')
    expect(r.tls?.hint).toContain('never switched off')
    expect(r.next).toContain('camstack login')
  })

  it('refuses a plain-http address', async () => {
    const r = await connectTool('http://hub.example.test', {
      sessionDir: dir,
      health: OK_HEALTH,
    })
    expect(r.status).toBe('invalid-address')
  })
})

describe('setup_discover_hubs', () => {
  it('returns host, port, name, version, and passes a bounded timeout', async () => {
    let asked = 0
    const r = await discoverHubsTool(900, {
      findHubs: async (ms) => {
        asked = ms
        return [
          {
            url: 'https://192.0.2.9:4443',
            host: '192.0.2.9',
            port: 4443,
            nodeId: 'hub',
            version: '1.2.3',
            sources: ['LAN (mDNS)'],
          },
        ]
      },
    })
    expect(asked).toBe(900)
    expect(r.hubs).toEqual([
      {
        host: '192.0.2.9',
        port: 4443,
        name: 'hub',
        version: '1.2.3',
        sources: ['LAN (mDNS)'],
      },
    ])
    const none = await discoverHubsTool(undefined, {
      findHubs: async () => [],
    })
    expect(none.hubs).toEqual([])
    expect(none.next).toContain('setup_install_guide')
  })
})

describe('setup_add_node', () => {
  function ctx(hub: ConnectOutcome): McpContext {
    return {
      cliVersion: '9.9.9',
      hub: async () => hub,
      gate: new MutationGate({ allowMutations: true }),
      fetch: fakeFetch,
    }
  }

  it('without a session: agent guide plus pairing steps, no hub call', async () => {
    const r = await addNodeTool(
      { hostKind: 'docker-compose', accelerator: 'cpu', paths: PATHS },
      ctx({
        ok: false,
        reason: 'no-session',
        message: 'none',
        action: 'run `camstack login <host>`',
      }),
    )
    expect(r.guide.status).toBe('ready')
    if (r.guide.status === 'ready') expect(r.guide.role).toBe('agent')
    expect(r.pairing.join('\n')).toContain('BOTH sides')
    expect(r.agentsOnNetwork.status).toBe('no-session')
  })

  it('with a session: lists agents awaiting pairing, never the pairing codes', async () => {
    const calls: { method: HubHttpMethod; path: string }[] = []
    const client: HubClient = {
      async call(method, p) {
        calls.push({ method, path: p })
        return {
          agents: [
            {
              nodeId: 'gpu-box',
              host: '192.0.2.40',
              port: 4444,
              version: '1.0.0',
              name: null,
              state: 'unpaired',
              pairing: { code: '123456' },
            },
          ],
          scannedAt: 1,
        }
      },
    }
    const r = await addNodeTool(
      {},
      ctx({
        ok: true,
        connection: {
          server: 'https://hub.example.test:4443',
          token: 't',
          tier: 'admin',
          source: 'session',
          tls: {},
          client,
          adminHint: null,
          loginCommand: 'camstack login',
        },
      }),
    )
    expect(calls).toEqual([{ method: 'GET', path: 'agentPairing.listDiscoveredAgents' }])
    expect(r.agentsOnNetwork).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(r)).not.toContain('123456')
    expect(r.guide.status).toBe('need-answers')
  })
})

describe('registration through MCP', () => {
  it('the setup toolset serves the five tools', async () => {
    const server = createPublicServer({
      toolsets: ['setup'],
      context: {
        cliVersion: '9.9.9',
        hub: async () => ({
          ok: false,
          reason: 'no-session',
          message: 'x',
          action: 'y',
        }),
        gate: new MutationGate({ allowMutations: true }),
        fetch: fakeFetch,
      },
    })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await server.connect(a)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(b)
    expect((await client.listTools()).tools.map((t) => t.name).toSorted()).toEqual([
      'setup_about',
      'setup_add_node',
      'setup_connect',
      'setup_discover_hubs',
      'setup_install_guide',
    ])
    const res = await client.callTool({
      name: 'setup_install_guide',
      arguments: {},
    })
    const content = Array.isArray(res.content) ? res.content : []
    expect(JSON.stringify(content)).toContain('need-answers')
  })
})

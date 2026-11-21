/** Fake machines and an MCP client for the onboarding specs. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MutationGate, type HubClient } from '@camstack/develop'
import { hostCheck, type HostCheckReport } from '../host-check/host-check.js'
import type { HostFs } from '../host-check/probe.js'
import type { HostFacts } from '../host-check/sizing.js'
import type { HostProbe, McpContext } from '../mcp/context.js'
import { createPublicServer } from '../mcp/server.js'
import { bundledOnly } from '../onboarding/manifest.js'
import { memoryStateStore } from '../onboarding/state-file.js'

export function fakeFs(files: Readonly<Record<string, string>>): HostFs {
  const paths = Object.keys(files)
  return {
    exists: (p) => p in files || paths.some((f) => f.startsWith(`${p}/`)),
    readText: (p) => files[p] ?? null,
    listDir: (p) => {
      const names = new Set<string>()
      for (const f of paths) {
        if (f.startsWith(`${p}/`)) names.add(f.slice(p.length + 1).split('/')[0] ?? '')
      }
      return [...names].toSorted()
    },
  }
}

const INTEL_IGPU: Readonly<Record<string, string>> = {
  '/sys/bus/pci/devices/0000:00:02.0/class': '0x030000\n',
  '/sys/bus/pci/devices/0000:00:02.0/vendor': '0x8086\n',
  '/sys/bus/pci/devices/0000:00:02.0/device': '0x46d1\n',
  '/sys/class/drm/renderD128/device/uevent': 'DRIVER=i915\nPCI_SLOT_NAME=0000:00:02.0\n',
  '/dev/dri/renderD128': '',
}

export function linuxHost(cpuModel: string, intelGpu: boolean): HostCheckReport {
  return hostCheck({
    platform: 'linux',
    nvidiaSmi: null,
    fs: fakeFs({
      '/proc/cpuinfo': `vendor_id\t: GenuineIntel\nmodel name\t: ${cpuModel}\n`,
      '/etc/group': 'render:x:992:\n',
      ...(intelGpu ? INTEL_IGPU : {}),
    }),
  })
}

export const N100 = 'Intel(R) N100'
/** An Intel CPU with a usable iGPU and no column in the measured tables. */
export const UNMEASURED_CPU = 'Intel(R) Core(TM) i5-8500 CPU @ 3.00GHz'

export const ROOMY: HostFacts = {
  cpuModel: null,
  ramGb: 16,
  cores: 4,
  diskFreeGb: 8000,
  diskPath: '/r',
}

export function fakeHost(check: HostCheckReport, facts: HostFacts = ROOMY): HostProbe {
  return { check: () => check, facts: () => facts }
}

export async function connectPublic(ctx: McpContext): Promise<Client> {
  const server = createPublicServer({
    toolsets: ['setup', 'ops', 'configure', 'support'],
    context: ctx,
    versionPreflight: false,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(b)
  return client
}

/** The JSON a tool answered with. */
export async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args })
  const content: unknown = result.content
  if (!Array.isArray(content)) throw new Error(`${name}: no content`)
  const first: unknown = content[0]
  if (typeof first !== 'object' || first === null || !('text' in first)) {
    throw new Error(`${name}: no text content`)
  }
  if (typeof first.text !== 'string') throw new Error(`${name}: text is not a string`)
  return JSON.parse(first.text)
}

export type HubAnswers = {
  readonly [path: string]: unknown | ((input: unknown) => unknown)
}

export interface FakeHub {
  readonly ctx: McpContext
  readonly calls: {
    readonly method: string
    readonly path: string
    readonly input: unknown
  }[]
}

export interface FakeHubOptions {
  readonly failing?: readonly string[]
  readonly tier?: 'admin' | 'protected'
  readonly extra?: Partial<McpContext>
}

/** A hub that answers each tRPC path from a table; a path in `failing` throws. */
export function fakeHub(answers: HubAnswers, options: FakeHubOptions = {}): FakeHub {
  const calls: FakeHub['calls'] = []
  const tier = options.tier ?? 'admin'
  const client: HubClient = {
    async call(method, path, input) {
      calls.push({ method, path, input })
      if (options.failing?.includes(path) === true) throw new Error(`${path} exploded`)
      const answer = answers[path]
      return typeof answer === 'function' ? answer(input) : (answer ?? null)
    },
  }
  return {
    calls,
    ctx: {
      cliVersion: '9.9.9',
      hub: async () => ({
        ok: true,
        connection: {
          server: 'https://hub.example.test',
          token: 'tok-should-never-appear-in-output',
          tier,
          source: 'session',
          tls: {},
          client,
          adminHint: tier === 'admin' ? null : 'log in as admin',
          loginCommand: 'camstack login',
        },
      }),
      gate: new MutationGate({ allowMutations: true, audit: () => {} }),
      fetch: async () => new Response(JSON.stringify({ version: '9.9.9' })),
      manifest: bundledOnly,
      onboardingState: memoryStateStore(),
      ...options.extra,
    },
  }
}

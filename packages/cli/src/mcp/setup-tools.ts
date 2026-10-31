/**
 * `setup` toolset: hub-less. Needs no credentials and no hub; the only network
 * it touches is the public npm registry.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { text } from './tool-result.js'
import { z } from 'zod'
import type { FetchFn, McpContext, ToolTextResult } from './context.js'
import { addNodeTool, connectTool, discoverHubsTool, type SetupDeps } from './setup-hubs.js'
import { installGuide } from './setup-install.js'
import {
  AcceleratorSchema,
  HOST_KINDS,
  HostKindSchema,
  InstallPathsSchema,
  RoleSchema,
} from './setup-install-rules.js'

/** The kinds of host a CamStack hub or agent is installed on (P1 grows this). */
export const SUPPORTED_HOST_KINDS: readonly string[] = HOST_KINDS

const REGISTRY = 'https://registry.npmjs.org'
const REGISTRY_TIMEOUT_MS = 5_000

const RegistryLatestSchema = z.object({ version: z.string() })

export interface PackageVersion {
  readonly latest: string | null
  /** Why `latest` is null; never a stack trace. */
  readonly error?: string
}

/** The `latest` dist-tag of one package, or the reason it could not be read. */
export async function latestOnNpm(name: string, fetchFn: FetchFn): Promise<PackageVersion> {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}/latest`
  try {
    const res = await fetchFn(url, {
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    })
    if (!res.ok) return { latest: null, error: `registry answered ${res.status}` }
    const parsed = RegistryLatestSchema.safeParse(await res.json())
    if (!parsed.success) return { latest: null, error: 'registry answer had no version' }
    return { latest: parsed.data.version }
  } catch (err) {
    return {
      latest: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export interface AboutResult {
  readonly cli: { readonly installed: string } & PackageVersion
  readonly server: PackageVersion
  readonly supportedHostKinds: readonly string[]
}

export async function about(ctx: McpContext): Promise<AboutResult> {
  const [cli, server] = await Promise.all([
    latestOnNpm('camstack', ctx.fetch),
    latestOnNpm('@camstack/server', ctx.fetch),
  ])
  return {
    cli: { installed: ctx.cliVersion, ...cli },
    server,
    supportedHostKinds: SUPPORTED_HOST_KINDS,
  }
}

export function registerSetupTools(server: McpServer, ctx: McpContext, deps: SetupDeps = {}): void {
  server.tool(
    'setup_about',
    'Versions of the camstack CLI (installed and latest on npm), the latest @camstack/server on npm, and the host kinds CamStack supports. Needs no hub and no login.',
    {},
    async (): Promise<ToolTextResult> => text(await about(ctx)),
  )
  server.tool(
    'setup_install_guide',
    'Interview-style install guide. Call it with whatever you know; while an answer is missing it returns {status:"need-answers", questions} listing only what is still unknown. When complete it returns the steps and the OFFICIAL template files (fetched live) for that route: docker-compose, docker, unraid, proxmox-lxc or macos-desktop. Start with a hub.',
    {
      hostKind: HostKindSchema.optional(),
      role: RoleSchema.optional(),
      accelerator: AcceleratorSchema.optional(),
      paths: InstallPathsSchema.optional(),
      hubAddress: z.string().min(1).optional().describe('Agents only: the hub to dial.'),
    },
    async (input): Promise<ToolTextResult> => text(await installGuide(input, ctx.fetch)),
  )
  server.tool(
    'setup_discover_hubs',
    'Find CamStack hubs on the local network (mDNS) plus the hubs this machine already knows, with host, port, name and version. Needs no login.',
    { timeoutMs: z.number().int().min(200).max(15_000).optional() },
    async ({ timeoutMs }): Promise<ToolTextResult> => text(await discoverHubsTool(timeoutMs, deps)),
  )
  server.tool(
    'setup_connect',
    'Check that a hub answers on https://<server>:4443/health, whether its CA is already pinned for TLS, and whether a `camstack login` session exists. Never takes a password: when there is no session it says to run `camstack login <server>` in a terminal.',
    { server: z.string().min(1) },
    async ({ server: address }): Promise<ToolTextResult> => text(await connectTool(address, deps)),
  )
  server.tool(
    'setup_add_node',
    'Guide to add an AGENT (a second machine) to a hub: the install route for that host, then the pairing flow where the operator types the six digits shown on the other screen on both sides. With a login session it also lists the agents found on the network. It never confirms a pairing.',
    {
      hostKind: HostKindSchema.optional(),
      accelerator: AcceleratorSchema.optional(),
      paths: InstallPathsSchema.optional(),
      hubAddress: z.string().min(1).optional(),
    },
    async (input): Promise<ToolTextResult> => text(await addNodeTool(input, ctx)),
  )
}

/**
 * The public MCP server behind `camstack mcp` (stdio). Stdout is the protocol:
 * everything diagnostic goes to stderr, and never a token, cookie or secret.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { MutationGate, tryConnectHub } from '@camstack/develop'
import { createManifestProvider } from '../onboarding/manifest.js'
import { SERVER_INSTRUCTIONS, registerGetStartedPrompt } from './get-started-prompt.js'
import type { FetchFn, HubProvider, McpContext } from './context.js'
import { registerConfigureTools } from './configure-tools.js'
import { registerOpsTools } from './ops-tools.js'
import { registerSetupTools } from './setup-tools.js'
import { registerSupportTools } from './support-tools.js'
import { PreflightMcpServer, VersionPreflight, type PreflightConfig } from './version-preflight.js'
import { probeVersions, type VersionProbe } from './version-probe.js'
import type { Toolset } from './toolsets.js'

export interface PublicServerOptions {
  readonly toolsets: readonly Toolset[]
  readonly context: McpContext
  /** Registers the `develop` toolset; injected so the CLI keeps it lazy. */
  readonly registerDevelop?: (server: McpServer) => void
  /**
   * The version preflight in front of every tool call. On by default, with the
   * real probe; pass a config to inject the probe and clock, `false` to turn it off.
   */
  readonly versionPreflight?: Partial<PreflightConfig> | false
}

function registerToolsets(
  server: McpServer,
  toolsets: readonly Toolset[],
  context: McpContext,
  refreshPreflight: (() => Promise<VersionProbe>) | undefined,
): void {
  if (toolsets.includes('setup')) registerSetupTools(server, context)
  if (toolsets.includes('ops')) registerOpsTools(server, context, refreshPreflight)
  if (toolsets.includes('configure')) registerConfigureTools(server, context)
  if (toolsets.includes('support')) registerSupportTools(server, context)
}

/**
 * The names of the tools this selection of toolsets serves, asked the way a
 * client asks: a second server with the same registration, listed over an
 * in-memory link. Built once, on the first call that needs it.
 */
function servedToolNames(
  toolsets: readonly Toolset[],
  context: McpContext,
): () => Promise<ReadonlySet<string>> {
  let cached: Promise<ReadonlySet<string>> | undefined
  const list = async (): Promise<ReadonlySet<string>> => {
    const shadow = new McpServer({
      name: 'camstack',
      version: context.cliVersion,
    })
    registerToolsets(shadow, toolsets, context, undefined)
    const [a, b] = InMemoryTransport.createLinkedPair()
    await shadow.connect(a)
    const client = new Client({
      name: 'camstack-self',
      version: context.cliVersion,
    })
    await client.connect(b)
    const names = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor })
      for (const tool of page.tools) names.add(tool.name)
      cursor = page.nextCursor
    } while (cursor !== undefined)
    await client.close()
    return names
  }
  return () => (cached ??= list())
}

/** Pure assembly: which toolsets register which tools. */
export function createPublicServer(options: PublicServerOptions): McpServer {
  const { toolsets } = options
  const context: McpContext = {
    ...options.context,
    registeredTools: options.context.registeredTools ?? servedToolNames(toolsets, options.context),
  }
  const info = { name: 'camstack', version: context.cliVersion }
  const serverOptions = toolsets.includes('setup') ? { instructions: SERVER_INSTRUCTIONS } : {}
  const preflight =
    options.versionPreflight === false
      ? null
      : new VersionPreflight({
          probe: () => probeVersions(context),
          ...options.versionPreflight,
        })
  const server = preflight
    ? new PreflightMcpServer(info, preflight, serverOptions)
    : new McpServer(info, serverOptions)
  registerToolsets(server, toolsets, context, preflight ? () => preflight.refresh() : undefined)
  if (toolsets.includes('setup')) registerGetStartedPrompt(server, context)
  if (toolsets.includes('develop') && options.registerDevelop) options.registerDevelop(server)
  return server
}

export interface CliMcpOptions {
  readonly cliVersion: string
  readonly toolsets: readonly Toolset[]
  /** `--server`: the hub to use instead of the cached session's. */
  readonly server?: string
  /** `--no-docs-fetch`: never read the onboarding steps from the docs site. */
  readonly noDocsFetch?: boolean
}

/** The CLI's own chain, resolved per call so a `camstack login` mid-session is picked up. */
function sessionHub(options: CliMcpOptions): HubProvider {
  return () =>
    tryConnectHub({
      workspaceRoot: process.cwd(),
      ...(options.server ? { server: options.server } : {}),
    })
}

const registryFetch: FetchFn = (url, init) => fetch(url, init)

export async function runPublicMcp(options: CliMcpOptions): Promise<void> {
  // Public mode has no `--allow-mutations`: the gate is always armed, and every
  // `configure` tool still needs its dry run and confirm token.
  const gate = new MutationGate({ allowMutations: true })
  const context: McpContext = {
    cliVersion: options.cliVersion,
    hub: sessionHub(options),
    gate,
    fetch: registryFetch,
    manifest: createManifestProvider({
      fetch: registryFetch,
      live: options.noDocsFetch !== true,
    }),
  }
  const registerDevelop = options.toolsets.includes('develop')
    ? (await import('@camstack/mcp-develop')).registerDevelopTools
    : undefined
  const server = createPublicServer({
    toolsets: options.toolsets,
    context,
    ...(registerDevelop ? { registerDevelop } : {}),
  })
  await server.connect(new StdioServerTransport())
}

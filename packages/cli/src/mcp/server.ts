/**
 * The public MCP server behind `camstack mcp` (stdio). Stdout is the protocol:
 * everything diagnostic goes to stderr, and never a token, cookie or secret.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { MutationGate, tryConnectHub } from '@camstack/develop'
import type { FetchFn, HubProvider, McpContext } from './context.js'
import { registerConfigureTools } from './configure-tools.js'
import { registerOpsTools } from './ops-tools.js'
import { registerSetupTools } from './setup-tools.js'
import type { Toolset } from './toolsets.js'

export interface PublicServerOptions {
  readonly toolsets: readonly Toolset[]
  readonly context: McpContext
  /** Registers the `develop` toolset; injected so the CLI keeps it lazy. */
  readonly registerDevelop?: (server: McpServer) => void
}

/** Pure assembly: which toolsets register which tools. */
export function createPublicServer(options: PublicServerOptions): McpServer {
  const server = new McpServer({ name: 'camstack', version: options.context.cliVersion })
  const { toolsets, context } = options
  if (toolsets.includes('setup')) registerSetupTools(server, context)
  if (toolsets.includes('ops')) registerOpsTools(server, context)
  if (toolsets.includes('configure')) registerConfigureTools(server, context)
  if (toolsets.includes('develop') && options.registerDevelop) options.registerDevelop(server)
  return server
}

export interface CliMcpOptions {
  readonly cliVersion: string
  readonly toolsets: readonly Toolset[]
  /** `--server`: the hub to use instead of the cached session's. */
  readonly server?: string
  /** `--token-file`: an explicit override for a token you were handed. */
  readonly tokenFile?: string
}

/** The CLI's own chain, resolved per call so a `camstack login` mid-session is picked up. */
function sessionHub(options: CliMcpOptions): HubProvider {
  return () =>
    tryConnectHub({
      workspaceRoot: process.cwd(),
      ...(options.server ? { server: options.server } : {}),
      ...(options.tokenFile ? { tokenFile: options.tokenFile } : {}),
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

/**
 * `setup` toolset: hub-less. Needs no credentials and no hub; the only network
 * it touches is the public npm registry.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { text } from '@camstack/develop'
import { z } from 'zod'
import type { FetchFn, McpContext, ToolTextResult } from './context.js'

/** The kinds of host a CamStack hub or agent is installed on (P1 grows this). */
export const SUPPORTED_HOST_KINDS: readonly string[] = [
  'docker',
  'docker-compose',
  'unraid',
  'proxmox',
  'desktop-app',
]

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
    const res = await fetchFn(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) })
    if (!res.ok) return { latest: null, error: `registry answered ${res.status}` }
    const parsed = RegistryLatestSchema.safeParse(await res.json())
    if (!parsed.success) return { latest: null, error: 'registry answer had no version' }
    return { latest: parsed.data.version }
  } catch (err) {
    return { latest: null, error: err instanceof Error ? err.message : String(err) }
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

export function registerSetupTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'setup_about',
    'Versions of the camstack CLI (installed and latest on npm), the latest @camstack/server on npm, and the host kinds CamStack supports. Needs no hub and no login.',
    {},
    async (): Promise<ToolTextResult> => text(await about(ctx)),
  )
}

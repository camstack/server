/**
 * `ops` toolset: read-only questions to a hub, through the CLI's own session
 * (`camstack login`). A tool that finds no session answers with a structured
 * "run camstack login" result; the MCP never accepts a password.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  jwtClaims,
  text,
  type CredentialSource,
  type CredentialTier,
  type NoSessionOutcome,
} from '@camstack/develop'
import type { McpContext, ToolTextResult } from './context.js'

export interface NoSessionResult {
  readonly status: 'no-session'
  readonly message: string
  readonly action: string
}

export function noSessionResult(outcome: NoSessionOutcome): NoSessionResult {
  return { status: 'no-session', message: outcome.message, action: outcome.action }
}

export interface WhoamiResult {
  readonly status: 'ok'
  readonly hub: string
  readonly tier: CredentialTier
  readonly source: CredentialSource
  /** Display claims of the credential; never the credential itself. */
  readonly identity: { readonly [claim: string]: string }
}

const IDENTITY_CLAIMS: readonly string[] = ['sub', 'username', 'name', 'role']

function identityOf(token: string): { readonly [claim: string]: string } {
  const claims = jwtClaims(token)
  const out: { [claim: string]: string } = {}
  if (claims === null) return out
  for (const key of IDENTITY_CLAIMS) {
    const value = claims[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

export async function whoami(ctx: McpContext): Promise<WhoamiResult | NoSessionResult> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return noSessionResult(outcome)
  const c = outcome.connection
  return {
    status: 'ok',
    hub: c.server,
    tier: c.tier,
    source: c.source,
    identity: identityOf(c.token),
  }
}

export function registerOpsTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'ops_whoami',
    'Which hub this MCP talks to and as whom, from the `camstack login` session (no network call). If there is no session, says to run `camstack login <host>` in a terminal.',
    {},
    async (): Promise<ToolTextResult> => text(await whoami(ctx)),
  )
}

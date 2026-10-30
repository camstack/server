/**
 * `ops` toolset: read-only questions to a hub, through the CLI's own session
 * (`camstack login`). A tool that finds no session answers with a structured
 * "run camstack login" result; the MCP never accepts a password.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { jwtClaims, text, type CredentialSource, type CredentialTier } from '@camstack/develop'
import type { McpContext, ToolTextResult } from './context.js'
import { noSessionResult, type NoSessionResult } from './ops-hub.js'
import { opsAccelerators } from './ops-accelerators.js'
import { opsDevice, opsUnhealthyDevices } from './ops-device.js'
import { opsEvents, opsTrack } from './ops-events.js'
import { opsLogs } from './ops-logs.js'
import { opsStatus } from './ops-status.js'
import { opsUpdateApply, UPDATE_APPLY_TOOL } from './ops-update-apply.js'
import { opsUpdateCheck } from './ops-update-check.js'

export { noSessionResult, type NoSessionResult }

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

  server.tool(
    'ops_status',
    'Cluster summary: every node (online, platform, server version, capability count, "online-but-capless" flag), the active alerts and the addons with an update. A part the hub did not answer is null with its reason in `unavailable`, never zero. Node list and updates need an admin `camstack login`.',
    {},
    async (): Promise<ToolTextResult> => text(await opsStatus(ctx)),
  )

  server.tool(
    'ops_device',
    'One device: online state, provider addon and node, bound capabilities, runtime-state age and, for a camera, its pipeline, recording state, the functions an operator switched off (not faults) and its latest object events.',
    { deviceId: z.number().int() },
    async ({ deviceId }): Promise<ToolTextResult> => text(await opsDevice(ctx, deviceId)),
  )

  server.tool(
    'ops_unhealthy_devices',
    'Every enabled device that is unhealthy, each with a typed reason (offline, detection-provisioning-failed, detection-not-assigned, recording-inactive). A function an operator switched off is never listed; a camera whose status could not be fully read is listed under `unknown`.',
    {},
    async (): Promise<ToolTextResult> => text(await opsUnhealthyDevices(ctx)),
  )

  server.tool(
    'ops_logs',
    'Hub logs scoped by deviceId, addon, node, level, window and free text, grouped and deduplicated with counts. Says which tier answered (ring = recent in-RAM; persisted = the default log destination). With `around` (a track or event id) returns `contextLines` lines on each side of its first mention. Needs an admin `camstack login`.',
    {
      deviceId: z.number().int().optional(),
      addonId: z.string().optional(),
      nodeId: z.string().optional(),
      level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      windowMinutes: z.number().int().min(1).max(1440).optional(),
      text: z.string().max(200).optional(),
      around: z.string().max(200).optional(),
      contextLines: z.number().int().min(1).max(50).optional(),
    },
    async (args): Promise<ToolTextResult> =>
      text(
        await opsLogs(ctx, {
          ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
          ...(args.addonId ? { addonId: args.addonId } : {}),
          ...(args.nodeId ? { nodeId: args.nodeId } : {}),
          ...(args.level ? { level: args.level } : {}),
          ...(args.windowMinutes !== undefined ? { windowMinutes: args.windowMinutes } : {}),
          ...(args.text ? { text: args.text } : {}),
          ...(args.around ? { around: args.around } : {}),
          ...(args.contextLines !== undefined ? { contextLines: args.contextLines } : {}),
        }),
      ),
  )

  server.tool(
    'ops_events',
    'Find tracks (and, for one camera, object events) by camera, class, zone, time window and free text. Each result carries an admin-UI link and a viewer link built on the hub address flagged for app connections.',
    {
      deviceId: z.number().int().optional(),
      className: z.string().optional(),
      zone: z.string().optional(),
      text: z.string().max(200).optional(),
      windowMinutes: z.number().int().min(1).max(10080).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async (args): Promise<ToolTextResult> =>
      text(
        await opsEvents(ctx, {
          ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
          ...(args.className ? { className: args.className } : {}),
          ...(args.zone ? { zone: args.zone } : {}),
          ...(args.text ? { text: args.text } : {}),
          ...(args.windowMinutes !== undefined ? { windowMinutes: args.windowMinutes } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }),
      ),
  )

  server.tool(
    'ops_track',
    'One track with its media audit: best shot, keyframes, every missing media kind with the reason the track recorded for it, and the audit findings. Links to the admin UI and the viewer.',
    { deviceId: z.number().int(), trackId: z.string().min(1) },
    async ({ deviceId, trackId }): Promise<ToolTextResult> =>
      text(await opsTrack(ctx, { deviceId, trackId })),
  )

  server.tool(
    'ops_accelerators',
    'Per node: the inference devices it has, the Auto-tune hardware class the node maps to, and whether the measured detector-latency table has a row for that class and accelerator. A node that could not be read is null with a reason, never "no accelerator". Needs an admin `camstack login`.',
    {},
    async (): Promise<ToolTextResult> => text(await opsAccelerators(ctx)),
  )

  server.tool(
    'ops_update_check',
    'Read-only update report for the whole cluster. Every node from the topology: running vs installed vs latest @camstack/server, restartRequired / updateState / rolledBack, the wrapper (Docker image / desktop app) verdict, and whether its addon versions match the hub; the hub\'s addon updates; the viewer (not exposed by any API, said so); and this CLI/MCP against npm. A node that cannot be read is null with a reason, never "up to date". Needs an admin `camstack login`.',
    {},
    async (): Promise<ToolTextResult> => text(await opsUpdateCheck(ctx)),
  )

  server.tool(
    UPDATE_APPLY_TOOL,
    'Bring the cluster up to date, verified step by step: hub server closure, wait until the hub runs it, then each online agent, then addons (agents follow by reconciliation, verified), then this CLI last. Two steps: call without confirm_token for a preview (order, versions, wrapper instructions, timeouts) and a one-shot token, then again with the SAME arguments and that token. A failed step stops the chain and names the node. Wrapper (image/app) updates are only reported with instructions. Needs an admin `camstack login`.',
    {
      version: z.string().min(1).optional().describe("Server target; default = the hub's latest."),
      addons: z.boolean().optional().describe('Update addons too (default true).'),
      cli: z.boolean().optional().describe('Update this CLI last (default true).'),
      confirm_token: z.string().optional(),
    },
    async ({ version, addons, cli, confirm_token }): Promise<ToolTextResult> =>
      text(
        await opsUpdateApply(
          ctx,
          {
            ...(version !== undefined ? { version } : {}),
            ...(addons !== undefined ? { addons } : {}),
            ...(cli !== undefined ? { cli } : {}),
          },
          confirm_token,
        ),
      ),
  )
}

/**
 * `configure` toolset: writes. Every tool here is two-step through the
 * mutation gate (D836): a call without `confirm_token` is a dry run that
 * changes nothing and returns a one-shot token bound to the exact arguments;
 * the same call with that token applies it. There is no flag that skips this.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  runGated,
  type DryRunOutcome,
  type GatedResult,
  type GatedToolSpec,
  type HubClient,
} from '@camstack/develop'
import { text } from './tool-result.js'
import { z } from 'zod'
import { registerConfigureP3bTools } from './configure-p3b.js'
import type { McpContext, ToolTextResult } from './context.js'
import { registerAddonTools } from './configure-addons.js'
import { registerCameraTools } from './configure-cameras.js'
import { registerNotifierTools } from './configure-notifiers.js'
import { noSessionResult } from './ops-tools.js'

export interface RenameDeviceArgs {
  readonly deviceId: number
  readonly name: string
}

const CurrentDeviceSchema = z.object({ name: z.string() }).nullable()

export const RENAME_DEVICE_TOOL = 'configure_rename_device'

/** The gated spec of one rename: the dry run READS, only `execute` writes. */
export function renameDeviceSpec(client: HubClient): GatedToolSpec<RenameDeviceArgs> {
  return {
    tool: RENAME_DEVICE_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const current = CurrentDeviceSchema.safeParse(
        await client.call('GET', 'deviceManager.getDevice', {
          deviceId: args.deviceId,
        }),
      )
      if (!current.success || current.data === null) {
        return {
          confirmable: false,
          describe: {
            problem: `device ${args.deviceId} was not found on the hub`,
          },
        }
      }
      if (current.data.name === args.name) {
        return {
          confirmable: false,
          describe: {
            problem: `device ${args.deviceId} is already named "${args.name}"`,
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: 'rename device',
          deviceId: args.deviceId,
          from: current.data.name,
          to: args.name,
        },
      }
    },
    async execute(args) {
      await client.call('POST', 'deviceManager.setName', {
        deviceId: args.deviceId,
        name: args.name,
      })
      return { deviceId: args.deviceId, name: args.name }
    },
  }
}

export async function renameDevice(
  ctx: McpContext,
  args: RenameDeviceArgs,
  confirmToken: string | undefined,
): Promise<GatedResult | ReturnType<typeof noSessionResult>> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return noSessionResult(outcome)
  if (outcome.connection.tier !== 'admin') {
    return {
      status: 'refused',
      reason: outcome.connection.adminHint ?? 'this credential is not admin-scoped',
    }
  }
  return runGated(ctx.gate, renameDeviceSpec(outcome.connection.client), args, confirmToken)
}

export function registerConfigureTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    RENAME_DEVICE_TOOL,
    'Rename a device. Two steps: call without confirm_token for a preview and a one-shot token, then call again with the SAME arguments and that token to apply. Needs an admin `camstack login` session.',
    {
      deviceId: z.number().int(),
      name: z.string().min(1),
      confirm_token: z.string().optional(),
    },
    async ({ deviceId, name, confirm_token }): Promise<ToolTextResult> =>
      text(await renameDevice(ctx, { deviceId, name }, confirm_token)),
  )
  registerAddonTools(server, ctx)
  registerCameraTools(server, ctx)
  registerNotifierTools(server, ctx)
  registerConfigureP3bTools(server, ctx)
}

/**
 * Exports: which cameras each exporter (Alexa, Google Home, Home Assistant,
 * HomeKit) shows, and the Home Assistant guide.
 *
 * `device-export` is a collection cap addressed by `addonId`. The status of an
 * exporter carries a pairing block (a QR payload and setup fields; the HomeKit
 * setup code is in it in clear). That block is NEVER read into a tool answer:
 * only the link state, the count and the error are. Switching a camera on or
 * off goes through the exporter's own `exposeDevice` / `unexposeDevice`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type DryRunOutcome, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { text } from './tool-result.js'
import { z } from 'zod'
import {
  ConfirmTokenSchema,
  adminGated,
  readCameras,
  type AdminGatedResult,
} from './configure-common.js'
import type { McpContext, ToolTextResult } from './context.js'
import { readQuery, withHub, type NoSessionResult } from './ops-hub.js'

export const EXPORT_SET_TOOL = 'configure_export_set'

const ProvidersSchema = z.array(z.looseObject({ addonId: z.string() }))
const StatusSchema = z.looseObject({
  linkState: z.string().optional(),
  exposedDeviceCount: z.number().optional(),
  error: z.string().nullish(),
})
const ExposedSchema = z.array(
  z.looseObject({
    deviceId: z.union([z.string(), z.number()]),
    exposedAs: z.string().optional(),
  }),
)

async function readProviders(
  client: HubClient,
): Promise<readonly string[] | { readonly reason: string }> {
  const read = await readQuery(
    client,
    'addons.listCapabilityProviders',
    { capName: 'device-export' },
    ProvidersSchema,
  )
  return read.ok ? read.value.map((p) => p.addonId) : { reason: read.reason }
}

export async function readExports(
  ctx: McpContext,
  args: { readonly deviceId?: number },
): Promise<Record<string, unknown> | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const providers = await readProviders(client)
    if (!Array.isArray(providers)) {
      return {
        status: 'unavailable' as const,
        reason: 'reason' in providers ? providers.reason : 'no providers',
      }
    }
    const cameras = await readCameras(client)
    const names = new Map(cameras.ok ? cameras.value.map((c) => [c.id, c.name]) : [])
    const rows = await Promise.all(
      providers.map(async (addonId) => {
        const [status, exposed] = await Promise.all([
          readQuery(client, 'deviceExport.getStatus', { addonId }, StatusSchema),
          readQuery(client, 'deviceExport.listExposedDevices', { addonId }, ExposedSchema),
        ])
        const ids = exposed.ok ? exposed.value.map((e) => Number(e.deviceId)) : []
        const cameraIds = ids.filter((id) => names.has(id))
        return {
          addonId,
          linkState: status.ok ? (status.value.linkState ?? null) : null,
          exposedDeviceCount: status.ok
            ? (status.value.exposedDeviceCount ?? ids.length)
            : ids.length,
          error: status.ok ? (status.value.error ?? null) : status.reason,
          cameras: cameraIds.map((id) => ({
            deviceId: id,
            name: names.get(id) ?? String(id),
          })),
          ...(args.deviceId !== undefined
            ? { exposesThisCamera: ids.includes(args.deviceId) }
            : {}),
          ...(exposed.ok ? {} : { exposedUnavailable: exposed.reason }),
        }
      }),
    )
    return {
      status: 'ok' as const,
      exporters: rows,
      note: 'Pairing details (QR, setup codes) are not shown here; open the exporter page in the admin UI to pair.',
      next: `Show or hide a camera with ${EXPORT_SET_TOOL}.`,
      ...(cameras.ok ? {} : { camerasUnavailable: cameras.reason }),
    }
  })
}

export interface ExportSetArgs {
  readonly addonId: string
  readonly deviceId: number
  readonly exposed: boolean
}

export function exportSetSpec(client: HubClient): GatedToolSpec<ExportSetArgs> {
  return {
    tool: EXPORT_SET_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const providers = await readProviders(client)
      if (!Array.isArray(providers)) {
        return {
          confirmable: false,
          describe: {
            problem: 'reason' in providers ? providers.reason : 'no providers',
          },
        }
      }
      if (!providers.includes(args.addonId)) {
        return {
          confirmable: false,
          describe: {
            problem: `${args.addonId} is not an exporter (exporters: ${providers.join(', ') || 'none'})`,
          },
        }
      }
      const cameras = await readCameras(client)
      if (!cameras.ok) return { confirmable: false, describe: { problem: cameras.reason } }
      const camera = cameras.value.find((c) => c.id === args.deviceId)
      if (camera === undefined)
        return {
          confirmable: false,
          describe: {
            problem: `device ${args.deviceId} is not a camera on this hub`,
          },
        }
      const exposed = await readQuery(
        client,
        'deviceExport.listExposedDevices',
        { addonId: args.addonId },
        ExposedSchema,
      )
      if (!exposed.ok) return { confirmable: false, describe: { problem: exposed.reason } }
      const now = exposed.value.some((e) => Number(e.deviceId) === args.deviceId)
      if (now === args.exposed) {
        return {
          confirmable: false,
          describe: {
            problem: `"${camera.name}" is already ${now ? 'shown to' : 'hidden from'} ${args.addonId}`,
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: args.exposed ? 'show camera in export' : 'hide camera from export',
          exporter: args.addonId,
          camera: camera.name,
          deviceId: args.deviceId,
          before: now,
          after: args.exposed,
        },
      }
    },
    async execute(args) {
      await client.call(
        'POST',
        args.exposed ? 'deviceExport.exposeDevice' : 'deviceExport.unexposeDevice',
        {
          addonId: args.addonId,
          deviceId: String(args.deviceId),
        },
      )
      return {
        exporter: args.addonId,
        deviceId: args.deviceId,
        exposed: args.exposed,
      }
    },
  }
}

export async function exportSet(
  ctx: McpContext,
  args: ExportSetArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, exportSetSpec, args, confirmToken)
}

/** The Home Assistant guide: plain text, no hub access, nothing to leak. */
export const HA_GUIDE: readonly string[] = [
  'Showing CamStack cameras in Home Assistant',
  '',
  '1. In CamStack, open Integrations and enable the Home Assistant export (the exporter addon). configure_exports shows whether it is installed and linked, and configure_export_set chooses which cameras it shows.',
  '2. Pair it from the exporter page in the admin UI. The pairing details are shown there only; this tool never prints them.',
  '3. In Home Assistant, the CamStack integration appears under Settings > Devices & services once it is linked; add it and pick the cameras.',
  '',
  'Getting the Home Assistant side installed:',
  '- A custom integration is normally installed through HACS (Home Assistant Community Store): add the CamStack repository as a custom repository, download it, restart Home Assistant, then add the integration.',
  '- How CamStack is distributed through HACS may change (a custom repository today, possibly the default HACS list later). Check the current Home Assistant and HACS documentation for the exact steps before relying on the ones above.',
  '',
  'If a camera does not show up: confirm the exporter reports a linked state, the camera is shown to it, and Home Assistant can reach the hub address CamStack advertises for app connections (Network page).',
]

export function registerExportTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_exports',
    'Read the exporters (Alexa, Google Home, Home Assistant, HomeKit): link state, how many devices each shows and which cameras. Pairing codes are never shown. Writes nothing.',
    { deviceId: z.number().int().nonnegative().optional() },
    async ({ deviceId }): Promise<ToolTextResult> =>
      text(await readExports(ctx, deviceId !== undefined ? { deviceId } : {})),
  )
  server.tool(
    EXPORT_SET_TOOL,
    "Show or hide one camera in one exporter, through the exporter's own cap. Two steps: call without confirm_token for a preview and a one-shot token, then call again with the SAME arguments and that token. Needs an admin `camstack login` session.",
    {
      addonId: z.string().min(1),
      deviceId: z.number().int().nonnegative(),
      exposed: z.boolean(),
      confirm_token: ConfirmTokenSchema,
    },
    async ({ addonId, deviceId, exposed, confirm_token }): Promise<ToolTextResult> =>
      text(await exportSet(ctx, { addonId, deviceId, exposed }, confirm_token)),
  )
  server.tool(
    'configure_ha_guide',
    'Read-only guide for showing CamStack cameras in Home Assistant, including the HACS route. Needs no hub.',
    {},
    async (): Promise<ToolTextResult> => text({ status: 'ok', guide: HA_GUIDE }),
  )
}

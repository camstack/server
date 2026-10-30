/**
 * Remote access: the tunnel and the TURN relay.
 *
 * `configure_remote_access` reads the live state and each addon's settings;
 * `configure_remote_access_set` changes the NON-secret ones through
 * `addonSettings.updateGlobalSettings`.
 *
 * A secret never crosses a tool call, in either direction. A `password` field
 * is reported as `configured: true|false` and never with its value; asking to
 * set one answers `secret-required` with the admin-UI page that holds the
 * field, built on the address the hub flags for app connections. `turnProvider`
 * is never called: it returns relay credentials.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { text, type DryRunOutcome, type GatedToolSpec, type HubClient } from '@camstack/develop'
import { z } from 'zod'
import {
  ConfirmTokenSchema,
  adminGated,
  adminLink,
  type AdminGatedResult,
} from './configure-common.js'
import type { McpContext, ToolTextResult } from './context.js'
import { readQuery, withHub, type NoSessionResult } from './ops-hub.js'

export const REMOTE_ACCESS_SET_TOOL = 'configure_remote_access_set'

export const RemoteAddonSchema = z.enum(['cloudflare-tunnel', 'cloudflare-turn', 'static-turn'])
export type RemoteAddon = z.infer<typeof RemoteAddonSchema>

const ADDON_PAGE: Readonly<Record<RemoteAddon, string>> = {
  'cloudflare-tunnel': '/system/remote-access',
  'cloudflare-turn': '/system/turn',
  'static-turn': '/system/turn',
}

const FieldSchema = z.looseObject({
  type: z.string(),
  key: z.string().optional(),
  label: z.string().optional(),
  value: z.unknown().optional(),
})
const GlobalSettingsSchema = z
  .looseObject({
    sections: z.array(z.looseObject({ fields: z.array(FieldSchema) })),
  })
  .nullable()

const SECRET_TYPES: readonly string[] = ['password', 'secret']

export interface PublicField {
  readonly key: string
  readonly label: string
  readonly type: string
  /** Absent for a secret field: only whether it is set. */
  readonly value?: unknown
  readonly configured?: boolean
}

function isSet(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.length > 0
  return true
}

/** Fields as a tool may show them: a secret becomes `configured`, its value is dropped. */
export function publicFields(
  settings: z.infer<typeof GlobalSettingsSchema>,
): readonly PublicField[] {
  if (settings === null) return []
  const out: PublicField[] = []
  for (const section of settings.sections) {
    for (const f of section.fields) {
      if (f.key === undefined) continue
      const label = f.label ?? f.key
      if (SECRET_TYPES.includes(f.type)) {
        out.push({
          key: f.key,
          label,
          type: f.type,
          configured: isSet(f.value),
        })
      } else {
        out.push({ key: f.key, label, type: f.type, value: f.value })
      }
    }
  }
  return out
}

const AccessStatusSchema = z.looseObject({
  connected: z.boolean().optional(),
  endpoint: z
    .looseObject({
      url: z.string().optional(),
      hostname: z.string().optional(),
      stable: z.boolean().optional(),
    })
    .nullish(),
})
const AddressesSchema = z.looseObject({
  roles: z
    .looseObject({
      publicEndpoint: z.looseObject({ resolved: z.unknown().optional() }).optional(),
    })
    .optional(),
})

export async function readRemoteAccess(
  ctx: McpContext,
): Promise<Record<string, unknown> | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const unavailable: Record<string, string> = {}
    const [status, addresses, ...addons] = await Promise.all([
      readQuery(client, 'networkAccess.getStatus', {}, AccessStatusSchema.nullable()),
      readQuery(client, 'localNetwork.getAddresses', {}, AddressesSchema),
      ...RemoteAddonSchema.options.map((addonId) =>
        readQuery(client, 'addonSettings.getGlobalSettings', { addonId }, GlobalSettingsSchema),
      ),
    ])
    if (!status.ok) unavailable['access'] = status.reason
    if (!addresses.ok) unavailable['publicEndpoint'] = addresses.reason
    const publicEndpoint = addresses.ok
      ? addresses.value.roles?.publicEndpoint?.resolved
      : undefined
    const settings = RemoteAddonSchema.options.map((addonId, i) => {
      const read = addons[i]
      if (read === undefined || !read.ok) {
        unavailable[addonId] = read === undefined ? 'not read' : read.reason
        return {
          addonId,
          state: 'unavailable' as const,
          fields: [] as readonly PublicField[],
        }
      }
      return {
        addonId,
        state: read.value === null ? ('no-settings' as const) : ('read' as const),
        fields: publicFields(read.value),
      }
    })
    return {
      status: 'ok' as const,
      access: status.ok ? status.value : null,
      publicEndpoint: typeof publicEndpoint === 'string' ? publicEndpoint : null,
      addons: settings,
      note: 'Secret fields (tunnel API token, TURN credentials) are reported as configured true/false and are never shown or accepted here.',
      next: `Change a plain field with ${REMOTE_ACCESS_SET_TOOL}; a secret field is entered in the admin UI.`,
      unavailable,
    }
  })
}

export interface RemoteAccessSetArgs {
  readonly addonId: RemoteAddon
  readonly patch: Readonly<Record<string, string | number | boolean>>
}

export function remoteAccessSetSpec(client: HubClient): GatedToolSpec<RemoteAccessSetArgs> {
  return {
    tool: REMOTE_ACCESS_SET_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      if (Object.keys(args.patch).length === 0)
        return {
          confirmable: false,
          describe: { problem: 'the patch is empty' },
        }
      const read = await readQuery(
        client,
        'addonSettings.getGlobalSettings',
        { addonId: args.addonId },
        GlobalSettingsSchema,
      )
      if (!read.ok) return { confirmable: false, describe: { problem: read.reason } }
      if (read.value === null) {
        return {
          confirmable: false,
          describe: {
            problem: `${args.addonId} has no settings on this hub (is the addon installed?)`,
          },
        }
      }
      const fields = read.value.sections.flatMap((s) => s.fields)
      const secrets = Object.keys(args.patch).filter((k) =>
        SECRET_TYPES.includes(fields.find((f) => f.key === k)?.type ?? ''),
      )
      if (secrets.length > 0) {
        const link = await adminLink(client, ADDON_PAGE[args.addonId])
        return {
          confirmable: false,
          describe: {
            status: 'secret-required',
            fields: secrets,
            reason: 'a secret is never a tool argument; nothing was changed',
            how:
              link.url !== null
                ? [`open ${link.url} and enter it in the field`]
                : [
                    'enter it in the addon page of the admin UI (the app-connections address could not be resolved)',
                  ],
          },
        }
      }
      const problems: string[] = []
      const changes: { key: string; before: unknown; after: unknown }[] = []
      for (const [key, after] of Object.entries(args.patch)) {
        const field = fields.find((f) => f.key === key)
        if (field === undefined) {
          problems.push(`${key}: no such setting on ${args.addonId}`)
          continue
        }
        const expected =
          field.type === 'number' ? 'number' : field.type === 'boolean' ? 'boolean' : 'string'
        if (typeof after !== expected) problems.push(`${key}: a ${expected} is expected`)
        changes.push({ key, before: field.value, after })
      }
      if (problems.length > 0)
        return {
          confirmable: false,
          describe: { problem: problems.join('; ') },
        }
      return {
        confirmable: true,
        describe: {
          action: 'change remote-access settings',
          addonId: args.addonId,
          changes,
          effect: 'the addon applies it on its next reconcile; a tunnel may reconnect briefly',
        },
      }
    },
    async execute(args) {
      await client.call('POST', 'addonSettings.updateGlobalSettings', {
        addonId: args.addonId,
        patch: args.patch,
      })
      return { addonId: args.addonId, applied: Object.keys(args.patch) }
    },
  }
}

export async function remoteAccessSet(
  ctx: McpContext,
  args: RemoteAccessSetArgs,
  confirmToken: string | undefined,
): Promise<AdminGatedResult> {
  return adminGated(ctx, remoteAccessSetSpec, args, confirmToken)
}

export function registerNetworkTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_remote_access',
    'Read how the hub is reachable from outside: the access status and public endpoint, and the settings of the tunnel and TURN addons. Secret fields are reported as configured true/false, never their value. Writes nothing.',
    {},
    async (): Promise<ToolTextResult> => text(await readRemoteAccess(ctx)),
  )
  server.tool(
    REMOTE_ACCESS_SET_TOOL,
    'Change NON-secret settings of the tunnel or TURN addon (mode, host, port, hostname, account id…). A secret (API token, credentials) is refused with secret-required and the admin-UI page to enter it. Two steps: call without confirm_token for a preview and a one-shot token, then call again with the SAME arguments and that token. Needs an admin `camstack login` session.',
    {
      addonId: RemoteAddonSchema,
      patch: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
      confirm_token: ConfirmTokenSchema,
    },
    async ({ addonId, patch, confirm_token }): Promise<ToolTextResult> =>
      text(await remoteAccessSet(ctx, { addonId, patch }, confirm_token)),
  )
}

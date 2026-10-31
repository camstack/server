/**
 * `configure` tools for adding a camera (board #274, camera providers).
 *
 * Same API the admin UI's "add camera" flow uses: `addons.list` and
 * `addons.searchAvailable` for the providers, `deviceManager.discoveryProviders`
 * / `discoverProvider` for discovery, `getCreationSchema` for the form and
 * `createDevice` to create. The fields come from the provider's own creation
 * schema; a secret field (a camera password) is never a tool argument and the
 * tool answers `secret-required` with the admin-UI link (`configure-support.ts`).
 *
 * A manifest declares no brand or model list, so what a provider "covers" is
 * matched on its name, description and keywords. A brand nothing matches is
 * `unsupported`, with a pointer to the support tools — never a guess.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type DryRunOutcome,
  type GatedResult,
  type GatedToolSpec,
  type HubClient,
} from '@camstack/develop'
import { text } from './tool-result.js'
import { z } from 'zod'
import type { McpContext, ToolTextResult } from './context.js'
import {
  formFields,
  formValidator,
  looksLikeCredentialName,
  runGatedAdmin,
  secretFieldFor,
  secretRequired,
  splitConfig,
  validationProblems,
  viewConfig,
  withAdminHub,
  type FormField,
  type RefusedToolResult,
  type SecretRequired,
} from './configure-support.js'
import { resolveLinkBase } from './ops-events.js'
import { cap, readQuery, reasonOf, withHub, type NoSessionResult } from './ops-hub.js'

export const UNSUPPORTED_HINT = 'use support_diagnose_camera / support_draft_issue'

const MAX_PROVIDERS = 40
const MAX_CANDIDATES = 50
const DEVICE_PROVIDER = 'device-provider'

export interface UnsupportedResult {
  readonly status: 'unsupported'
  readonly provider?: string
  readonly reason: string
  readonly hint: string
}

function unsupported(reason: string, provider?: string): UnsupportedResult {
  return {
    status: 'unsupported',
    ...(provider !== undefined ? { provider } : {}),
    reason,
    hint: UNSUPPORTED_HINT,
  }
}

// ---------------------------------------------------------------------------
// the installed and the available providers

const CapabilityEntry = z.union([z.string(), z.looseObject({ name: z.string() })])

const InstalledAddonShape = z.looseObject({
  manifest: z.looseObject({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    packageName: z.string(),
    packageVersion: z.string(),
    capabilities: z.array(CapabilityEntry).optional(),
  }),
})

const CatalogShape = z.looseObject({
  name: z.string(),
  version: z.string(),
  description: z.string(),
  keywords: z.array(z.string()),
  installed: z.boolean(),
  capabilities: z.array(z.string()).nullable(),
})

const DiscoveryProvidersShape = z.looseObject({
  providers: z.array(z.looseObject({ addonId: z.string(), label: z.string() })),
})

export interface InstalledProvider {
  readonly addonId: string
  readonly name: string
  readonly description: string | null
  readonly packageName: string
  readonly version: string
  readonly discovery: boolean | null
}

export interface AvailableProvider {
  readonly packageName: string
  readonly version: string
  readonly description: string
  readonly keywords: readonly string[]
}

function capabilityName(entry: z.infer<typeof CapabilityEntry>): string {
  return typeof entry === 'string' ? entry : entry.name
}

async function readInstalledProviders(
  client: HubClient,
): Promise<{ ok: true; value: readonly InstalledProvider[] } | { ok: false; reason: string }> {
  const [list, discovery] = await Promise.all([
    readQuery(client, 'addons.list', {}, z.array(InstalledAddonShape)),
    readQuery(client, 'deviceManager.discoveryProviders', {}, DiscoveryProvidersShape),
  ])
  if (!list.ok) return list
  const discoverable = discovery.ok
    ? new Set(discovery.value.providers.map((p) => p.addonId))
    : null
  return {
    ok: true,
    value: list.value
      .filter((a) => (a.manifest.capabilities ?? []).map(capabilityName).includes(DEVICE_PROVIDER))
      .map((a) => ({
        addonId: a.manifest.id,
        name: a.manifest.name ?? a.manifest.id,
        description: a.manifest.description ?? null,
        packageName: a.manifest.packageName,
        version: a.manifest.packageVersion,
        discovery: discoverable === null ? null : discoverable.has(a.manifest.id),
      })),
  }
}

function matchesQuery(haystack: readonly string[], query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
  if (words.length === 0) return false
  const joined = haystack.join(' ').toLowerCase()
  return words.some((w) => joined.includes(w))
}

export interface CameraProvidersResult {
  readonly status: 'ok' | 'unavailable'
  readonly installed?: readonly InstalledProvider[]
  readonly available?: readonly AvailableProvider[]
  readonly truncated?: number
  readonly reason?: string
  readonly note?: string
}

export async function configureCameraProviders(
  ctx: McpContext,
  query: string | undefined,
): Promise<CameraProvidersResult | UnsupportedResult | NoSessionResult> {
  return withHub(ctx, async ({ client }) => {
    const [installed, catalog] = await Promise.all([
      readInstalledProviders(client),
      readQuery(
        client,
        'addons.searchAvailable',
        { capability: DEVICE_PROVIDER },
        z.array(CatalogShape),
      ),
    ])
    if (!installed.ok) return { status: 'unavailable', reason: installed.reason }
    const installedPackages = new Set(installed.value.map((p) => p.packageName))
    const available: AvailableProvider[] = catalog.ok
      ? catalog.value
          .filter((c) => !c.installed && !installedPackages.has(c.name))
          .map((c) => ({
            packageName: c.name,
            version: c.version,
            description: c.description,
            keywords: c.keywords,
          }))
      : []
    const trimmed = query?.trim() ?? ''
    const keepInstalled =
      trimmed === ''
        ? installed.value
        : installed.value.filter((p) =>
            matchesQuery([p.addonId, p.name, p.description ?? '', p.packageName], trimmed),
          )
    const keepAvailable =
      trimmed === ''
        ? available
        : available.filter((p) =>
            matchesQuery([p.packageName, p.description, ...p.keywords], trimmed),
          )
    if (trimmed !== '' && keepInstalled.length === 0 && keepAvailable.length === 0) {
      return unsupported(
        `no installed or published camera provider matches "${trimmed}" by name, description or keywords`,
      )
    }
    const cappedAvailable = cap(keepAvailable, MAX_PROVIDERS)
    return {
      status: 'ok',
      installed: keepInstalled,
      available: cappedAvailable.items,
      truncated: cappedAvailable.truncated,
      ...(catalog.ok ? {} : { reason: `catalog unreadable: ${catalog.reason}` }),
      note: 'A provider manifest declares no brand or model list; matching is on name, description and keywords.',
    }
  })
}

// ---------------------------------------------------------------------------
// configure_camera_discover

const CandidateShape = z.looseObject({
  stableId: z.string(),
  type: z.string(),
  suggestedName: z.string(),
  prefilledConfig: z.record(z.string(), z.unknown()),
})

const DiscoverShape = z.looseObject({ candidates: z.array(CandidateShape) })

export interface DiscoveredCamera {
  readonly stableId: string
  readonly type: string
  readonly suggestedName: string
  /** Non-secret prefilled fields; a credential-looking one is reduced to set/unset. */
  readonly config: { readonly [key: string]: unknown }
  readonly secrets: { readonly [key: string]: 'set' | 'unset' }
}

export interface CameraDiscoverResult {
  readonly status: 'ok' | 'unavailable' | 'secret-required'
  readonly addonId?: string
  readonly candidates?: readonly DiscoveredCamera[]
  readonly truncated?: number
  readonly reason?: string
  readonly secret?: SecretRequired
  readonly note?: string
}

export interface CameraDiscoverArgs {
  readonly addonId: string
  readonly params?: { readonly [key: string]: unknown }
}

export async function configureCameraDiscover(
  ctx: McpContext,
  args: CameraDiscoverArgs,
): Promise<CameraDiscoverResult | UnsupportedResult | NoSessionResult | RefusedToolResult> {
  return withAdminHub(ctx, async ({ client }) => {
    const providers = await readQuery(
      client,
      'deviceManager.discoveryProviders',
      {},
      DiscoveryProvidersShape,
    )
    if (!providers.ok) return { status: 'unavailable', reason: providers.reason }
    if (!providers.value.providers.some((p) => p.addonId === args.addonId)) {
      return unsupported(
        `"${args.addonId}" is not an installed provider with discovery (see configure_camera_providers)`,
        args.addonId,
      )
    }
    const credentialKey = Object.keys(args.params ?? {}).find(looksLikeCredentialName)
    if (credentialKey !== undefined) {
      const link = await resolveLinkBase(client)
      return {
        status: 'secret-required',
        reason: `params.${credentialKey} looks like a credential and was NOT sent. Discovery that needs a credential is run from the admin UI.`,
        secret: secretRequired(
          secretFieldFor(credentialKey, []),
          link.base === null ? null : `${link.base}/integrations/${args.addonId}`,
        ),
      }
    }
    let raw: unknown
    try {
      // A scan of the local network: it changes no hub state.
      raw = await client.call('POST', 'deviceManager.discoverProvider', {
        addonId: args.addonId,
        ...(args.params !== undefined ? { params: args.params } : {}),
      })
    } catch (err) {
      return {
        status: 'unavailable',
        addonId: args.addonId,
        reason: reasonOf(err),
      }
    }
    const parsed = DiscoverShape.safeParse(raw)
    if (!parsed.success) {
      return {
        status: 'unavailable',
        addonId: args.addonId,
        reason: 'the hub answered in an unexpected shape',
      }
    }
    const capped = cap(parsed.data.candidates, MAX_CANDIDATES)
    return {
      status: 'ok',
      addonId: args.addonId,
      candidates: capped.items.map((c) => {
        const view = viewConfig([], c.prefilledConfig)
        return {
          stableId: c.stableId,
          type: c.type,
          suggestedName: c.suggestedName,
          config: view.values,
          secrets: view.secrets,
        }
      }),
      truncated: capped.truncated,
      note: 'Add one with configure_camera_add, using these fields as `config`.',
    }
  })
}

// ---------------------------------------------------------------------------
// configure_camera_add

export interface AddCameraArgs {
  readonly addonId: string
  readonly config: { readonly [key: string]: unknown }
}

export const ADD_CAMERA_TOOL = 'configure_camera_add'

type AddPlan =
  | {
      readonly ok: true
      readonly fields: readonly FormField[]
      readonly safe: { readonly [key: string]: unknown }
      readonly secretNeeds: readonly FormField[]
    }
  | {
      readonly ok: false
      readonly problems: readonly string[]
      readonly unsupported?: UnsupportedResult
      readonly secret?: readonly FormField[]
    }

async function planAdd(client: HubClient, args: AddCameraArgs): Promise<AddPlan> {
  const installed = await readInstalledProviders(client)
  if (!installed.ok) return { ok: false, problems: [installed.reason] }
  if (!installed.value.some((p) => p.addonId === args.addonId)) {
    return {
      ok: false,
      problems: [`"${args.addonId}" is not an installed camera provider`],
      unsupported: unsupported(
        `"${args.addonId}" is not an installed camera provider (see configure_camera_providers; an uninstalled one is added with configure_addon_install first)`,
        args.addonId,
      ),
    }
  }
  const schema = await readQuery(
    client,
    'deviceManager.getCreationSchema',
    { addonId: args.addonId, type: 'camera' },
    z.unknown(),
  )
  if (!schema.ok) return { ok: false, problems: [schema.reason] }
  if (schema.value === null || schema.value === undefined) {
    return {
      ok: false,
      problems: [`${args.addonId} does not support adding a camera by hand`],
      unsupported: unsupported(
        `${args.addonId} has no manual creation form (it may only discover)`,
        args.addonId,
      ),
    }
  }
  const fields = formFields(schema.value)
  if (fields === null) {
    return {
      ok: false,
      problems: [`the ${args.addonId} creation form could not be read`],
    }
  }
  const split = splitConfig(fields, args.config)
  if (split.suppliedSecretKeys.length > 0) {
    return {
      ok: false,
      problems: [
        `secret field(s) ${split.suppliedSecretKeys.join(', ')} were supplied as a tool argument and were NOT used. Remove them; the operator types secrets in the admin UI.`,
      ],
      secret: split.suppliedSecretKeys.map((k) => secretFieldFor(k, fields)),
    }
  }
  if (split.unknownKeys.length > 0) {
    return {
      ok: false,
      problems: [
        `fields not in the ${args.addonId} creation form: ${split.unknownKeys.join(', ')}`,
      ],
    }
  }
  const checked = formValidator(fields).safeParse(split.safe)
  if (!checked.success) return { ok: false, problems: validationProblems(checked.error) }
  return {
    ok: true,
    fields,
    safe: split.safe,
    secretNeeds: fields.filter((f) => f.secret && f.required),
  }
}

async function providerPage(client: HubClient, addonId: string): Promise<string | null> {
  const link = await resolveLinkBase(client)
  return link.base === null ? null : `${link.base}/integrations/${addonId}`
}

export interface AddCameraResult {
  readonly created: boolean
  readonly deviceId?: number
  readonly name?: string
  readonly adminUi: string | null
  readonly incompleteUntilSecretSet: readonly SecretRequired[]
  /** The hub's refusal, when it did not create the device. */
  readonly error?: string
}

const CreatedShape = z.looseObject({ id: z.number(), name: z.string() })

export function addCameraSpec(client: HubClient): GatedToolSpec<AddCameraArgs> {
  return {
    tool: ADD_CAMERA_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const plan = await planAdd(client, args)
      const link = await providerPage(client, args.addonId)
      if (!plan.ok) {
        return {
          confirmable: false,
          describe: {
            problems: plan.problems,
            ...(plan.unsupported !== undefined ? { unsupported: plan.unsupported } : {}),
            ...(plan.secret !== undefined
              ? {
                  secretRequired: plan.secret.map((f) => secretRequired(f, link)),
                }
              : {}),
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: 'add camera',
          provider: args.addonId,
          config: plan.safe,
          incompleteUntilSecretSet: plan.secretNeeds.map((f) => secretRequired(f, link)),
          note:
            plan.secretNeeds.length > 0
              ? 'The provider may refuse to create the camera before its secret exists; if so the answer says so and points at the admin UI form.'
              : 'Nothing secret is needed.',
        },
      }
    },
    async execute(args): Promise<AddCameraResult> {
      const plan = await planAdd(client, args)
      if (!plan.ok) throw new Error(plan.problems.join('; '))
      const link = await providerPage(client, args.addonId)
      const needs = plan.secretNeeds.map((f) => secretRequired(f, link))
      let raw: unknown
      try {
        raw = await client.call('POST', 'deviceManager.createDevice', {
          addonId: args.addonId,
          type: 'camera',
          config: plan.safe,
        })
      } catch (err) {
        return {
          created: false,
          adminUi: link,
          incompleteUntilSecretSet: needs,
          error: reasonOf(err),
        }
      }
      const created = CreatedShape.safeParse(raw)
      if (!created.success) {
        return {
          created: false,
          adminUi: link,
          incompleteUntilSecretSet: needs,
          error: 'the hub answered in an unexpected shape; check the Devices page before retrying',
        }
      }
      const base = await resolveLinkBase(client)
      return {
        created: true,
        deviceId: created.data.id,
        name: created.data.name,
        adminUi: base.base === null ? null : `${base.base}/devices/${String(created.data.id)}`,
        incompleteUntilSecretSet: needs,
      }
    },
  }
}

export async function addCamera(
  ctx: McpContext,
  args: AddCameraArgs,
  confirmToken: string | undefined,
): Promise<GatedResult | NoSessionResult> {
  return runGatedAdmin(ctx, (client) => addCameraSpec(client), args, confirmToken)
}

// ---------------------------------------------------------------------------

export function registerCameraTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_camera_providers',
    'Installed camera-provider addons and the published ones not yet installed. A manifest declares no brand/model list, so `query` matches on name, description and keywords; a brand nothing matches is `unsupported` with a pointer to support_diagnose_camera / support_draft_issue.',
    { query: z.string().max(100).optional() },
    async ({ query }): Promise<ToolTextResult> => text(await configureCameraProviders(ctx, query)),
  )

  server.tool(
    'configure_camera_discover',
    'Scan the network through one camera provider (the admin UI "add camera" discovery) and list the candidates with the non-secret fields to pass to configure_camera_add. Changes nothing on the hub. A credential in `params` is refused (`secret-required`). Needs an admin `camstack login`.',
    {
      addonId: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ addonId, params }): Promise<ToolTextResult> =>
      text(
        await configureCameraDiscover(ctx, {
          addonId,
          ...(params !== undefined ? { params } : {}),
        }),
      ),
  )

  server.tool(
    ADD_CAMERA_TOOL,
    "Add a camera through a provider's creation form (the fields are the provider's own schema). Two steps: call without confirm_token for a preview and a one-shot token, then again with the SAME arguments and that token. `config` takes NON-secret fields only; a password is refused and the answer carries the admin-UI link where the operator types it (`secret-required`). A provider that is not installed or has no manual form is `unsupported`.",
    {
      addonId: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
      confirm_token: z.string().optional(),
    },
    async ({ addonId, config, confirm_token }): Promise<ToolTextResult> =>
      text(await addCamera(ctx, { addonId, config }, confirm_token)),
  )
}

/**
 * `configure` tools for notification targets (board #275).
 *
 * They go through the same `notificationOutput.*` methods the admin UI's
 * notification page uses (`listTargetKinds`, `listTargets`, `upsertTarget`,
 * `testTarget`) — no parallel path. A kind's `configSchema` is the one form
 * schema; its `password` fields are the secrets, and a secret is never a tool
 * argument nor shown (`configure-support.ts`). `getTarget` is never called: it
 * returns a target WITH its secrets. `listTargets` is already redacted by the
 * provider, and the view here reduces every secret to set/unset on top.
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
  runGatedAdmin,
  secretFieldFor,
  secretRequired,
  splitConfig,
  summarizeField,
  validationProblems,
  viewConfig,
  withAdminHub,
  type ConfigView,
  type FieldSummary,
  type FormField,
  type RefusedToolResult,
  type SecretRequired,
} from './configure-support.js'
import { resolveLinkBase } from './ops-events.js'
import { cap, readQuery, reasonOf, type NoSessionResult } from './ops-hub.js'

const MAX_TARGETS = 50

const TargetKindShape = z.looseObject({
  kind: z.string(),
  label: z.string(),
  addonId: z.string(),
  supportsDiscovery: z.boolean().optional(),
  configSchema: z.unknown(),
  destinationKeys: z.array(z.string()).optional(),
})

const TargetShape = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  addonId: z.string(),
  enabled: z.boolean(),
  config: z.record(z.string(), z.unknown()),
})

const SendResultShape = z.looseObject({
  success: z.boolean(),
  error: z.string().optional(),
})

interface KindForm {
  readonly kind: string
  readonly label: string
  readonly addonId: string
  readonly supportsDiscovery: boolean
  readonly destinationKeys: readonly string[] | null
  /** null: the hub sent a schema this tool cannot read. */
  readonly fields: readonly FormField[] | null
}

type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: string }

async function readKinds(client: HubClient): Promise<Read<readonly KindForm[]>> {
  const read = await readQuery(
    client,
    'notificationOutput.listTargetKinds',
    {},
    z.array(TargetKindShape),
  )
  if (!read.ok) return read
  return {
    ok: true,
    value: read.value.map((k) => ({
      kind: k.kind,
      label: k.label,
      addonId: k.addonId,
      supportsDiscovery: k.supportsDiscovery === true,
      destinationKeys: k.destinationKeys ?? null,
      fields: formFields(k.configSchema),
    })),
  }
}

async function notificationsPage(client: HubClient): Promise<string | null> {
  const link = await resolveLinkBase(client)
  return link.base === null ? null : `${link.base}/system/notifications`
}

// ---------------------------------------------------------------------------
// configure_notifiers

export interface NotifierView {
  readonly kind: string
  readonly label: string
  readonly addonId: string
  readonly supportsDiscovery: boolean
  readonly fields: readonly FieldSummary[] | null
  readonly secretFields: readonly string[]
  /** Config keys that decide where secrets are sent: changing one needs the secret re-entered. */
  readonly destinationKeys: readonly string[] | null
}

export interface NotifiersResult {
  readonly status: 'ok' | 'unavailable'
  readonly notifiers?: readonly NotifierView[]
  readonly reason?: string
  readonly note?: string
}

export async function configureNotifiers(
  ctx: McpContext,
): Promise<NotifiersResult | NoSessionResult | RefusedToolResult> {
  return withAdminHub(ctx, async ({ client }) => {
    const kinds = await readKinds(client)
    if (!kinds.ok) return { status: 'unavailable', reason: kinds.reason }
    return {
      status: 'ok',
      notifiers: kinds.value.map((k) => ({
        kind: k.kind,
        label: k.label,
        addonId: k.addonId,
        supportsDiscovery: k.supportsDiscovery,
        fields: k.fields === null ? null : k.fields.map(summarizeField),
        secretFields: k.fields === null ? [] : k.fields.filter((f) => f.secret).map((f) => f.key),
        destinationKeys: k.destinationKeys,
      })),
      note: 'A secret field is never a tool argument: configure_notification_target_upsert saves the other fields and answers secret-required with the admin-UI link.',
    }
  })
}

// ---------------------------------------------------------------------------
// configure_notification_targets

export interface TargetView {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly enabled: boolean
  readonly config: ConfigView['values']
  readonly secrets: ConfigView['secrets']
  /** Required secrets still unset: the target cannot deliver until they are. */
  readonly incomplete: readonly string[]
}

export interface TargetsResult {
  readonly status: 'ok' | 'unavailable'
  readonly targets?: readonly TargetView[]
  readonly truncated?: number
  readonly reason?: string
}

function viewTarget(target: z.infer<typeof TargetShape>, kinds: readonly KindForm[]): TargetView {
  const form = kinds.find((k) => k.kind === target.kind)
  const view = viewConfig(form?.fields ?? [], target.config)
  return {
    id: target.id,
    name: target.name,
    kind: target.kind,
    enabled: target.enabled,
    config: view.values,
    secrets: view.secrets,
    incomplete: view.missingSecrets,
  }
}

export async function configureNotificationTargets(
  ctx: McpContext,
): Promise<TargetsResult | NoSessionResult | RefusedToolResult> {
  return withAdminHub(ctx, async ({ client }) => {
    const [kinds, targets] = await Promise.all([
      readKinds(client),
      readQuery(client, 'notificationOutput.listTargets', {}, z.array(TargetShape)),
    ])
    if (!targets.ok) return { status: 'unavailable', reason: targets.reason }
    const forms = kinds.ok ? kinds.value : []
    const capped = cap(targets.value, MAX_TARGETS)
    return {
      status: 'ok',
      targets: capped.items.map((t) => viewTarget(t, forms)),
      truncated: capped.truncated,
      ...(kinds.ok
        ? {}
        : {
            reason: `kind catalog unreadable (${kinds.reason}); secrets are still shown only as set/unset by name`,
          }),
    }
  })
}

// ---------------------------------------------------------------------------
// configure_notification_target_upsert

export interface UpsertTargetArgs {
  /** Omitted creates a new target; given edits that one. */
  readonly targetId?: string
  readonly kind: string
  readonly name: string
  readonly config: { readonly [key: string]: unknown }
  readonly enabled?: boolean
}

export const UPSERT_TARGET_TOOL = 'configure_notification_target_upsert'

interface UpsertPlan {
  readonly existing: z.infer<typeof TargetShape> | null
  readonly form: KindForm
  readonly fields: readonly FormField[]
  readonly mergedConfig: { readonly [key: string]: unknown }
  readonly secretNeeds: readonly FormField[]
}

type PlanOutcome =
  | { readonly ok: true; readonly plan: UpsertPlan }
  | {
      readonly ok: false
      readonly problems: readonly string[]
      readonly secret?: readonly SecretRequired[]
    }

async function suppliedSecretAnswers(
  client: HubClient,
  fields: readonly FormField[],
  keys: readonly string[],
): Promise<readonly SecretRequired[]> {
  const link = await notificationsPage(client)
  return keys.map((k) => secretRequired(secretFieldFor(k, fields), link))
}

async function planUpsert(client: HubClient, args: UpsertTargetArgs): Promise<PlanOutcome> {
  const kinds = await readKinds(client)
  if (!kinds.ok) return { ok: false, problems: [kinds.reason] }
  const form = kinds.value.find((k) => k.kind === args.kind)
  if (form === undefined) {
    return {
      ok: false,
      problems: [
        `no notifier of kind "${args.kind}" (available: ${kinds.value.map((k) => k.kind).join(', ')})`,
      ],
    }
  }
  if (form.fields === null) {
    return {
      ok: false,
      problems: [`the "${args.kind}" form schema could not be read`],
    }
  }
  const fields = form.fields
  let existing: z.infer<typeof TargetShape> | null = null
  if (args.targetId !== undefined) {
    const list = await readQuery(client, 'notificationOutput.listTargets', {}, z.array(TargetShape))
    if (!list.ok) return { ok: false, problems: [list.reason] }
    existing = list.value.find((t) => t.id === args.targetId) ?? null
    if (existing === null) return { ok: false, problems: [`target ${args.targetId} was not found`] }
    if (existing.kind !== args.kind) {
      return {
        ok: false,
        problems: [`target ${args.targetId} is of kind "${existing.kind}", not "${args.kind}"`],
      }
    }
  }
  const split = splitConfig(fields, args.config)
  if (split.suppliedSecretKeys.length > 0) {
    return {
      ok: false,
      problems: [
        `secret field(s) ${split.suppliedSecretKeys.join(', ')} were supplied as a tool argument and were NOT used. Remove them and retry; the operator types secrets in the admin UI.`,
      ],
      secret: await suppliedSecretAnswers(client, fields, split.suppliedSecretKeys),
    }
  }
  if (split.unknownKeys.length > 0) {
    return {
      ok: false,
      problems: [
        `fields not in the "${args.kind}" form: ${split.unknownKeys.join(', ')} (see configure_notifiers)`,
      ],
    }
  }
  // The stored (redacted) config carries the markers the provider restores
  // secrets from; the patch overlays only what the caller named.
  const base = existing === null ? {} : existing.config
  const mergedConfig = { ...base, ...split.safe }
  const view = viewConfig(fields, mergedConfig)
  const required = formValidator(fields).safeParse(view.values)
  if (!required.success) return { ok: false, problems: validationProblems(required.error) }
  const secretNeeds = fields.filter((f) => f.secret && f.required && view.secrets[f.key] !== 'set')
  return {
    ok: true,
    plan: { existing, form, fields, mergedConfig, secretNeeds },
  }
}

export interface UpsertTargetResult {
  readonly targetId: string
  readonly name: string
  readonly kind: string
  readonly created: boolean
  readonly incompleteUntilSecretSet: readonly SecretRequired[]
}

export function upsertTargetSpec(
  client: HubClient,
  now: () => number = Date.now,
): GatedToolSpec<UpsertTargetArgs> {
  return {
    tool: UPSERT_TARGET_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const plan = await planUpsert(client, args)
      if (!plan.ok) {
        return {
          confirmable: false,
          describe: {
            problems: plan.problems,
            ...(plan.secret !== undefined ? { secretRequired: plan.secret } : {}),
          },
        }
      }
      const link = await notificationsPage(client)
      return {
        confirmable: true,
        describe: {
          action:
            plan.plan.existing === null ? 'create notification target' : 'edit notification target',
          ...(plan.plan.existing !== null ? { targetId: plan.plan.existing.id } : {}),
          kind: args.kind,
          name: args.name,
          enabled: args.enabled ?? plan.plan.existing?.enabled ?? true,
          config: viewConfig(plan.plan.fields, plan.plan.mergedConfig).values,
          incompleteUntilSecretSet: plan.plan.secretNeeds.map((f) => secretRequired(f, link)),
        },
      }
    },
    async execute(args): Promise<UpsertTargetResult> {
      const plan = await planUpsert(client, args)
      if (!plan.ok) throw new Error(plan.problems.join('; '))
      const id = plan.plan.existing?.id ?? `${args.kind}-${String(now())}`
      const saved = await client.call('POST', 'notificationOutput.upsertTarget', {
        target: {
          id,
          name: args.name,
          kind: args.kind,
          addonId: plan.plan.form.addonId,
          enabled: args.enabled ?? plan.plan.existing?.enabled ?? true,
          config: plan.plan.mergedConfig,
        },
      })
      const parsed = TargetShape.safeParse(saved)
      const stored = parsed.success ? parsed.data : null
      const view = viewConfig(plan.plan.fields, stored?.config ?? plan.plan.mergedConfig)
      const link = await notificationsPage(client)
      const still = plan.plan.fields.filter((f) => view.missingSecrets.includes(f.key))
      return {
        targetId: id,
        name: args.name,
        kind: args.kind,
        created: plan.plan.existing === null,
        incompleteUntilSecretSet: still.map((f) => secretRequired(f, link)),
      }
    },
  }
}

export async function upsertNotificationTarget(
  ctx: McpContext,
  args: UpsertTargetArgs,
  confirmToken: string | undefined,
): Promise<GatedResult | NoSessionResult> {
  return runGatedAdmin(ctx, (client) => upsertTargetSpec(client), args, confirmToken)
}

// ---------------------------------------------------------------------------
// configure_notification_target_test

export interface TestTargetArgs {
  readonly targetId: string
}

export const TEST_TARGET_TOOL = 'configure_notification_target_test'

export interface TestTargetResult {
  readonly targetId: string
  readonly delivered: boolean
  readonly error?: string
}

export function testTargetSpec(client: HubClient): GatedToolSpec<TestTargetArgs> {
  return {
    tool: TEST_TARGET_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const [kinds, targets] = await Promise.all([
        readKinds(client),
        readQuery(client, 'notificationOutput.listTargets', {}, z.array(TargetShape)),
      ])
      if (!targets.ok) return { confirmable: false, describe: { problem: targets.reason } }
      const target = targets.value.find((t) => t.id === args.targetId)
      if (target === undefined) {
        return {
          confirmable: false,
          describe: { problem: `target ${args.targetId} was not found` },
        }
      }
      const view = viewTarget(target, kinds.ok ? kinds.value : [])
      if (view.incomplete.length > 0) {
        const form = kinds.ok ? kinds.value.find((k) => k.kind === target.kind) : undefined
        const link = await notificationsPage(client)
        const needs = (form?.fields ?? [])
          .filter((f) => view.incomplete.includes(f.key))
          .map((f) => secretRequired(f, link))
        return {
          confirmable: false,
          describe: {
            problem: `target ${target.id} is incomplete until its secret is set`,
            secretRequired: needs,
          },
        }
      }
      return {
        confirmable: true,
        describe: {
          action: 'send a test notification',
          targetId: target.id,
          name: target.name,
          kind: target.kind,
          enabled: target.enabled,
          note: 'A real message is delivered to this destination.',
        },
      }
    },
    async execute(args): Promise<TestTargetResult> {
      let raw: unknown
      try {
        raw = await client.call('POST', 'notificationOutput.testTarget', {
          targetId: args.targetId,
        })
      } catch (err) {
        return {
          targetId: args.targetId,
          delivered: false,
          error: reasonOf(err),
        }
      }
      const parsed = SendResultShape.safeParse(raw)
      if (!parsed.success) {
        return {
          targetId: args.targetId,
          delivered: false,
          error: 'the hub answered in an unexpected shape',
        }
      }
      return {
        targetId: args.targetId,
        delivered: parsed.data.success,
        ...(parsed.data.error !== undefined ? { error: parsed.data.error } : {}),
      }
    },
  }
}

export async function testNotificationTarget(
  ctx: McpContext,
  args: TestTargetArgs,
  confirmToken: string | undefined,
): Promise<GatedResult | NoSessionResult> {
  return runGatedAdmin(ctx, (client) => testTargetSpec(client), args, confirmToken)
}

// ---------------------------------------------------------------------------

export function registerNotifierTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'configure_notifiers',
    'The notifier kinds a target can be created from (ntfy, telegram, email, …), each with its settings fields, which are required and which are SECRETS. Secrets are never tool arguments. Needs an admin `camstack login`.',
    {},
    async (): Promise<ToolTextResult> => text(await configureNotifiers(ctx)),
  )

  server.tool(
    'configure_notification_targets',
    'Existing notification targets with their non-secret settings. A secret is shown only as set/unset, and a target missing a required secret is listed under `incomplete`. Needs an admin `camstack login`.',
    {},
    async (): Promise<ToolTextResult> => text(await configureNotificationTargets(ctx)),
  )

  server.tool(
    UPSERT_TARGET_TOOL,
    'Create (no targetId) or edit (targetId) a notification target from its notifier schema (see configure_notifiers). Two steps: call without confirm_token for a preview and a one-shot token, then again with the SAME arguments and that token. `config` takes NON-secret fields only; a secret field is refused, and the target is saved incomplete with the admin-UI link where the operator types the secret (`secret-required`).',
    {
      targetId: z.string().min(1).optional(),
      kind: z.string().min(1),
      name: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
      enabled: z.boolean().optional(),
      confirm_token: z.string().optional(),
    },
    async ({ targetId, kind, name, config, enabled, confirm_token }): Promise<ToolTextResult> =>
      text(
        await upsertNotificationTarget(
          ctx,
          {
            ...(targetId !== undefined ? { targetId } : {}),
            kind,
            name,
            config,
            ...(enabled !== undefined ? { enabled } : {}),
          },
          confirm_token,
        ),
      ),
  )

  server.tool(
    TEST_TARGET_TOOL,
    'Send a test notification to one target. Two steps: the preview checks the target exists and has every required secret, and only the confirmed call delivers a real message.',
    { targetId: z.string().min(1), confirm_token: z.string().optional() },
    async ({ targetId, confirm_token }): Promise<ToolTextResult> =>
      text(await testNotificationTarget(ctx, { targetId }, confirm_token)),
  )
}

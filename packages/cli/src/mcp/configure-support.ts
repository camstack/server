/**
 * Shared ground of the `configure` tools that edit settings of a thing the hub
 * describes with a form schema (a camera provider's creation form, a
 * notification target kind's config form).
 *
 *  - SECRETS never travel through a tool. Tool arguments go through the model
 *    provider, and output goes back into its context, so a password, token or
 *    key is neither accepted as an argument nor printed. A secret field is
 *    answered with `secret-required` and the admin-UI link where the operator
 *    types it (D783). The CLI has no interactive "set a secret" command, so
 *    the link is the only way offered; none is invented.
 *  - A form field is secret when its schema TYPE says so (`password`, or
 *    `secret: true`) — the same rule the hub's keychain and the notifier
 *    provider apply. A key the schema does not know but whose NAME looks like
 *    a credential is treated as secret too (defence in depth, never the rule).
 */
import {
  runGated,
  type GatedResult,
  type GatedToolSpec,
  type HubClient,
  type HubConnection,
} from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { noSessionResult, type NoSessionResult } from './ops-hub.js'

// ---------------------------------------------------------------------------
// admin doorway

export interface RefusedToolResult {
  readonly status: 'refused'
  readonly reason: string
}

/** A gated tool: no session -> say so; not admin -> refuse; else the gate. */
export async function runGatedAdmin<A>(
  ctx: McpContext,
  makeSpec: (client: HubClient) => GatedToolSpec<A>,
  args: A,
  confirmToken: string | undefined,
): Promise<GatedResult | NoSessionResult> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return noSessionResult(outcome)
  if (outcome.connection.tier !== 'admin') {
    return {
      status: 'refused',
      reason: outcome.connection.adminHint ?? 'this credential is not admin-scoped',
    }
  }
  return runGated(ctx.gate, makeSpec(outcome.connection.client), args, confirmToken)
}

/** An admin-only READ: no session -> say so; not admin -> refuse; else `body`. */
export async function withAdminHub<T>(
  ctx: McpContext,
  body: (connection: HubConnection) => Promise<T>,
): Promise<T | NoSessionResult | RefusedToolResult> {
  const outcome = await ctx.hub()
  if (!outcome.ok) return noSessionResult(outcome)
  if (outcome.connection.tier !== 'admin') {
    return {
      status: 'refused',
      reason: outcome.connection.adminHint ?? 'this credential is not admin-scoped',
    }
  }
  return body(outcome.connection)
}

// ---------------------------------------------------------------------------
// form schema (ConfigUISchema), read loosely: the hub and this tool may differ

const FormOptionSchema = z.looseObject({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string().optional(),
})

const FormFieldSchema = z.looseObject({
  type: z.string().optional(),
  key: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  default: z.unknown().optional(),
  options: z.array(FormOptionSchema).optional(),
  itemFields: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        key: z.string().optional(),
      }),
    )
    .optional(),
})

export const FormSchemaShape = z.looseObject({
  sections: z.array(z.looseObject({ fields: z.array(FormFieldSchema) })),
})

export interface FormOption {
  readonly value: string | number | boolean
  readonly label: string | null
}

export interface FormField {
  readonly key: string
  readonly label: string
  readonly type: string
  readonly required: boolean
  /** True when the schema marks the field secret, or a nested row holds one. */
  readonly secret: boolean
  readonly description: string | null
  readonly options: readonly FormOption[] | null
  /** The default, never shown for a secret field. */
  readonly default: unknown
}

const NON_INPUT_TYPES: ReadonlySet<string> = new Set(['info', 'divider', 'heading', 'button'])

/** A key the schema does not describe but whose name reads as a credential. */
const CREDENTIAL_NAME = /pass(word|wd|phrase)?|token|secret|api[_-]?key|credential|private[_-]?key/i

export function looksLikeCredentialName(key: string): boolean {
  return CREDENTIAL_NAME.test(key)
}

/** Every input field of a form, flattened, in order. An unreadable schema is `null`. */
export function formFields(schema: unknown): readonly FormField[] | null {
  const parsed = FormSchemaShape.safeParse(schema)
  if (!parsed.success) return null
  const out: FormField[] = []
  for (const section of parsed.data.sections) {
    for (const field of section.fields) {
      if (field.key === undefined || field.key === '') continue
      const type = field.type ?? 'text'
      if (NON_INPUT_TYPES.has(type)) continue
      const nestedSecret = (field.itemFields ?? []).some((item) => item.type === 'password')
      const secret = type === 'password' || field.secret === true || nestedSecret
      out.push({
        key: field.key,
        label: field.label ?? field.key,
        type,
        required: field.required === true,
        secret,
        description: field.description ?? null,
        options: field.options
          ? field.options.map((o) => ({
              value: o.value,
              label: o.label ?? null,
            }))
          : null,
        default: secret ? undefined : field.default,
      })
    }
  }
  return out
}

/** What `configure_*` lists about a field: never a secret's value or default. */
export interface FieldSummary {
  readonly key: string
  readonly label: string
  readonly type: string
  readonly required: boolean
  readonly secret: boolean
  readonly description?: string
  readonly options?: readonly (string | number | boolean)[]
  readonly default?: unknown
}

export function summarizeField(field: FormField): FieldSummary {
  return {
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    secret: field.secret,
    ...(field.description !== null ? { description: field.description } : {}),
    ...(field.options !== null ? { options: field.options.map((o) => o.value) } : {}),
    ...(!field.secret && field.default !== undefined ? { default: field.default } : {}),
  }
}

// ---------------------------------------------------------------------------
// the secret answer

export interface SecretRequired {
  readonly status: 'secret-required'
  readonly field: string
  readonly label: string
  readonly how: readonly string[]
}

/**
 * `link` is the admin-UI page that holds the field; null when the hub has no
 * usable (non-loopback) address flagged for app connections.
 */
export function secretRequired(field: FormField, link: string | null): SecretRequired {
  const how: string[] = []
  if (link !== null) {
    how.push(`Open ${link} in the admin UI and type "${field.label}" there.`)
  } else {
    how.push(
      `Open the admin UI and type "${field.label}" there (no usable hub address is flagged for app connections yet — set one on the Network page).`,
    )
  }
  how.push(
    'Do not paste the secret into this chat: tool arguments are sent to the model provider, so it is not accepted here.',
  )
  return {
    status: 'secret-required',
    field: field.key,
    label: field.label,
    how,
  }
}

/** The form field for a supplied key; a credential-named key the form lacks gets a stand-in. */
export function secretFieldFor(key: string, fields: readonly FormField[]): FormField {
  return (
    fields.find((f) => f.key === key) ?? {
      key,
      label: key,
      type: 'password',
      required: false,
      secret: true,
      description: null,
      options: null,
      default: undefined,
    }
  )
}

export interface SecretSplit {
  /** Non-secret values, safe to write. */
  readonly safe: { readonly [key: string]: unknown }
  /** Keys the caller supplied that are secret (their VALUES are dropped). */
  readonly suppliedSecretKeys: readonly string[]
  /** Keys the form does not describe. */
  readonly unknownKeys: readonly string[]
}

/** Separate what may be written from what was supplied but is secret or unknown. */
export function splitConfig(
  fields: readonly FormField[],
  config: { readonly [key: string]: unknown },
): SecretSplit {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const safe: { [key: string]: unknown } = {}
  const suppliedSecretKeys: string[] = []
  const unknownKeys: string[] = []
  for (const [key, value] of Object.entries(config)) {
    const field = byKey.get(key)
    if (field === undefined) {
      if (looksLikeCredentialName(key)) suppliedSecretKeys.push(key)
      else unknownKeys.push(key)
      continue
    }
    if (field.secret) {
      suppliedSecretKeys.push(key)
      continue
    }
    safe[key] = value
  }
  return { safe, suppliedSecretKeys, unknownKeys }
}

// ---------------------------------------------------------------------------
// validation: the form's own constraints as a Zod object

function fieldValidator(field: FormField): z.ZodType {
  switch (field.type) {
    case 'number':
      return z.number()
    case 'boolean':
    case 'switch':
    case 'checkbox':
    case 'toggle':
      return z.boolean()
    case 'tags':
      return z.array(z.string())
    case 'editable-array':
      return z.array(z.record(z.string(), z.unknown()))
    case 'select':
    case 'radio': {
      if (field.options === null || field.options.length === 0) return z.unknown()
      const values = field.options.map((o) => o.value)
      return z.custom<string | number | boolean>(
        (v) => values.some((allowed) => allowed === v),
        `one of: ${values.map(String).join(', ')}`,
      )
    }
    case 'text':
    case 'probe':
    case 'textarea':
    case 'url':
    case 'email':
      return z.string()
    default:
      return z.unknown()
  }
}

/** The form as one Zod object over its NON-secret fields; required ones are required. */
export function formValidator(fields: readonly FormField[]): z.ZodObject {
  const shape: { [key: string]: z.ZodType } = {}
  for (const field of fields) {
    if (field.secret) continue
    const base = fieldValidator(field)
    shape[field.key] = field.required ? base : base.optional()
  }
  return z.object(shape)
}

export function validationProblems(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const where = issue.path.join('.')
    return where === '' ? issue.message : `${where}: ${issue.message}`
  })
}

// ---------------------------------------------------------------------------
// reading stored config back

/** The marker the notifier provider leaves where a stored secret was. */
export const REDACTED_MARKER = '__redacted__'

export type SecretState = 'set' | 'unset'

export interface ConfigView {
  /** Non-secret values as stored. */
  readonly values: { readonly [key: string]: unknown }
  /** Each secret field of the form: whether a value is stored, never the value. */
  readonly secrets: { readonly [key: string]: SecretState }
  /** Required secret fields still unset: the target is incomplete until they are. */
  readonly missingSecrets: readonly string[]
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== ''
}

/** A stored config as the tool may show it: secrets only as set/unset. */
export function viewConfig(
  fields: readonly FormField[],
  config: { readonly [key: string]: unknown },
): ConfigView {
  const secretKeys = new Set(fields.filter((f) => f.secret).map((f) => f.key))
  const values: { [key: string]: unknown } = {}
  const secrets: { [key: string]: SecretState } = {}
  for (const key of secretKeys) secrets[key] = isPresent(config[key]) ? 'set' : 'unset'
  for (const [key, value] of Object.entries(config)) {
    if (secretKeys.has(key)) continue
    if (!fields.some((f) => f.key === key) && looksLikeCredentialName(key)) {
      secrets[key] = isPresent(value) ? 'set' : 'unset'
      continue
    }
    values[key] = value
  }
  const missingSecrets = fields
    .filter((f) => f.secret && f.required && secrets[f.key] !== 'set')
    .map((f) => f.key)
  return { values, secrets, missingSecrets }
}

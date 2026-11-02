import { z } from 'zod'
import type { ConfigUISchema } from '../interfaces/config-ui.js'
import {
  type CapabilityDefinition,
  type InferProvider,
  method,
  optionalMethod,
} from './capability-definition.js'
import { TestConnectionResultSchema } from './integrations.cap.js'

/**
 * `integration-instances` - the connection of an addon that holds ONE or SEVERAL
 * (an account, a relay, a destination) as typed records (D985, D986). The addon's
 * own function page reads and writes them (Logging for Loki); the Integrations
 * page lists only the integrations that bring devices (D996).
 *
 * A collection of providers: each addon that holds connections registers one and a
 * caller reaches a provider with the pinned `addonId`.
 *
 * Identity: the instance id is immutable and opaque to the caller. A record the
 * Loki migration made keeps the `integrations` registry id it was created under
 * (`int_NNNN`); a single instance made by its function page takes the addon id.
 * `name` is the editable label.
 *
 * Secrets: every field the instance kind marks `.meta({ secret: true })` reaches
 * the form as a `SecretFieldView`, never text (D789). A patch value omitted, `''`
 * or the redaction token KEEPS the stored secret; `{ $secretClear: true }`
 * clears it.
 */

const ConfigSchemaPassthrough = z.custom<ConfigUISchema>()

export const IntegrationInstanceIdSchema = z.string().min(1)

export const IntegrationInstanceModeSchema = z.enum(['single', 'multiple'])
export type IntegrationInstanceMode = z.infer<typeof IntegrationInstanceModeSchema>

export const IntegrationInstanceDescriptionSchema = z.object({
  /** `single`: at most one instance can exist (Loki). `multiple`: an account each. */
  instanceMode: IntegrationInstanceModeSchema,
  /** What the instance is, for the UI (`destination`, `relay`, `account`). */
  kind: z.string(),
  /** True when `testInstance` really probes the remote. */
  canTest: z.boolean(),
})
export type IntegrationInstanceDescription = z.infer<typeof IntegrationInstanceDescriptionSchema>

export const IntegrationInstanceStatusSchema = z.object({
  state: z.enum(['ok', 'off', 'error', 'unknown']),
  detail: z.string().optional(),
})

export const IntegrationInstanceSchema = z.object({
  id: IntegrationInstanceIdSchema,
  name: z.string(),
  /** The addon's own rule (an URL is present, a client id is present...). */
  configured: z.boolean(),
  /** Values for the instance form; a secret is a `SecretFieldView`, never text. */
  formValues: z.record(z.string(), z.unknown()),
  status: IntegrationInstanceStatusSchema.optional(),
})
export type IntegrationInstance = z.infer<typeof IntegrationInstanceSchema>

export const IntegrationInstancePatchSchema = z.object({
  id: IntegrationInstanceIdSchema,
  name: z.string().min(1).optional(),
  /** Omitted / '' / redaction token keeps a secret; `{ $secretClear: true }` clears it. */
  values: z.record(z.string(), z.unknown()),
})
export type IntegrationInstancePatch = z.infer<typeof IntegrationInstancePatchSchema>

export const integrationInstancesCapability = {
  name: 'integration-instances',
  scope: 'system',
  mode: 'collection',
  methods: {
    describe: method(z.void(), IntegrationInstanceDescriptionSchema, { auth: 'admin' }),
    /** The form; `id: null` is the create form. */
    instanceFormSchema: method(
      z.object({ id: IntegrationInstanceIdSchema.nullable() }),
      ConfigSchemaPassthrough,
      { auth: 'admin' },
    ),
    listInstances: method(z.void(), z.array(IntegrationInstanceSchema).readonly(), {
      auth: 'admin',
    }),
    getInstance: method(
      z.object({ id: IntegrationInstanceIdSchema }),
      IntegrationInstanceSchema.nullable(),
      { auth: 'admin' },
    ),
    /** Insert the typed record under the given id (a duplicate id is refused). */
    createInstance: method(
      z.object({ id: IntegrationInstanceIdSchema, name: z.string().min(1) }),
      z.object({ id: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    updateInstance: method(IntegrationInstancePatchSchema, z.object({ ok: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Delete the record and its keychain refs together. */
    deleteInstance: method(
      z.object({ id: IntegrationInstanceIdSchema }),
      z.object({ ok: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    testInstance: optionalMethod(
      z.object({
        id: IntegrationInstanceIdSchema.nullable(),
        values: z.record(z.string(), z.unknown()),
      }),
      TestConnectionResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IIntegrationInstancesProvider = InferProvider<typeof integrationInstancesCapability>

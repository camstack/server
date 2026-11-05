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

/**
 * What the addon's instances ARE for the Integrations page (planning#416). `devices`: each
 * instance is an integration that brings devices (the registry owns its on/off switch);
 * `services`: a connection configured from the addon's own function page, never listed on
 * Integrations.
 * It is the same vocabulary as the manifest's `integrationRole`, which stays as an override.
 */
export const IntegrationInstanceRoleSchema = z.enum(['devices', 'services'])
export type IntegrationInstanceRole = z.infer<typeof IntegrationInstanceRoleSchema>

/**
 * One kind of instance a provider can create (an adapter, an account type). The sign-in and
 * connect fields follow the `broker` contract (`broker.cap.ts`): `signIn.basePath` is a
 * hub-relative route set speaking the sign-in contract, `connectPath` / `disconnectPath` open an
 * interactive account link (popup) and may carry `{{brokerId}}`, which the UI replaces with the
 * instance id.
 */
export const IntegrationInstanceKindSchema = z.object({
  /** Stable id of the kind, sent back as `createInstance.kind`. */
  id: z.string().min(1),
  label: z.string().min(1),
  /**
   * The function capability this kind is configured for (`broker`, `smtp-provider`,
   * `device-provider`, ...). A page section is the kinds whose `functionCap` it names (D1013); a
   * provider with more than one section must name it on every kind.
   */
  functionCap: z.string().min(1),
  /** What instances of this kind are for the Integrations page; absent takes the provider's `role`. */
  role: IntegrationInstanceRoleSchema.optional(),
  /** `testInstance` really probes the remote for this kind; absent takes the provider's `canTest`. */
  canTest: z.boolean().optional(),
  /** The kind signs in through a server-held interactive session. */
  signIn: z
    .object({
      basePath: z.string().min(1),
      methods: z.array(z.enum(['device-code', 'proxy'])).optional(),
    })
    .optional(),
  /** Relative hub path to start an interactive account link of an instance of this kind. */
  connectPath: z.string().min(1).optional(),
  /** Relative hub path to disconnect that account. */
  disconnectPath: z.string().min(1).optional(),
})
export type IntegrationInstanceKind = z.infer<typeof IntegrationInstanceKindSchema>

/**
 * How devices of an instance are found. `none`: the operator adds them by hand; `lan`: the addon
 * scans the network before any instance exists (the wizard offers the candidates); `account`: the
 * devices appear after the instance signs in. `scopedToInstance`: a discovery run belongs to ONE
 * instance and its candidates are claimed by it.
 */
export const IntegrationInstanceDiscoverySchema = z.object({
  mode: z.enum(['none', 'lan', 'account']),
  scopedToInstance: z.boolean(),
})
export type IntegrationInstanceDiscovery = z.infer<typeof IntegrationInstanceDiscoverySchema>

export const IntegrationInstanceDescriptionSchema = z.object({
  /** What the instances are for the Integrations page; see {@link IntegrationInstanceRoleSchema}. */
  role: IntegrationInstanceRoleSchema,
  /** How the devices of an instance are found; absent means `{ mode: 'none' }`. */
  discovery: IntegrationInstanceDiscoverySchema.optional(),
  /** `single`: at most one instance can exist (Loki). `multiple`: an account each. */
  instanceMode: IntegrationInstanceModeSchema,
  /** What the instance is, for the UI (`destination`, `relay`, `account`). */
  kind: z.string(),
  /** True when `testInstance` really probes the remote. */
  canTest: z.boolean(),
  /**
   * The kinds an instance can be of. Absent or one entry: nothing to choose; more than one: the
   * Add flow asks which first and sends it as `createInstance.kind`.
   */
  kinds: z.array(IntegrationInstanceKindSchema).optional(),
  /**
   * The provider accepts `createInstance.id` for an id that once existed (an adopted id, because
   * devices carry it). The UI then offers "restore under its old id" on Add. Absent means no.
   */
  allowRestoreId: z.boolean().optional(),
  /**
   * `createInstance` without an `id` works: the provider mints it. Absent means the caller must
   * send an id (the UI then mints an opaque one).
   */
  mintsId: z.boolean().optional(),
})
export type IntegrationInstanceDescription = z.infer<typeof IntegrationInstanceDescriptionSchema>

export const IntegrationInstanceStatusSchema = z.object({
  state: z.enum(['ok', 'off', 'error', 'unknown']),
  detail: z.string().optional(),
  /** A short human word for the state ("Signed in", "Token expired"); shown instead of `state`. */
  label: z.string().optional(),
})

export const IntegrationInstanceSchema = z.object({
  id: IntegrationInstanceIdSchema,
  name: z.string(),
  /** The addon's own rule (an URL is present, a client id is present...). */
  configured: z.boolean(),
  /**
   * The instance's own on/off switch (D996), derived from the record body (`enabled !== false`,
   * so a row written before the field existed is on). Absent when the `integrations` registry
   * owns the switch (`describe().role` is `devices`): read it from the registry row.
   */
  enabled: z.boolean().optional(),
  /** The kind of this instance (one of `describe().kinds[].id`), when the provider has kinds. */
  kind: z.string().optional(),
  /** Values for the instance form; a secret is a `SecretFieldView`, never text. */
  formValues: z.record(z.string(), z.unknown()),
  status: IntegrationInstanceStatusSchema.optional(),
  /** Epoch ms of the last probe of the remote that produced `status`; absent when never checked. */
  lastCheckedAt: z.number().optional(),
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
      z.object({
        id: IntegrationInstanceIdSchema.nullable(),
        /** The kind of the create form (`id: null`) of a provider with several. */
        kind: z.string().min(1).optional(),
      }),
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
    /**
     * Insert the typed record. With `id` it is stored under that id (a duplicate id is refused);
     * without one the PROVIDER mints it and answers it. `kind` picks one of `describe().kinds`.
     */
    createInstance: method(
      z.object({
        id: IntegrationInstanceIdSchema.optional(),
        name: z.string().min(1),
        kind: z.string().min(1).optional(),
        /** Form values written with the record (a link picked in the create dialog). */
        values: z.record(z.string(), z.unknown()).optional(),
      }),
      z.object({ id: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    updateInstance: method(IntegrationInstancePatchSchema, z.object({ ok: z.literal(true) }), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Switch ONE instance on or off. A row control, not a form field: `updateInstance.values` is the
     * form patch (D62, D996). An off instance keeps its record and secrets and does no work.
     */
    setInstanceEnabled: method(
      z.object({ id: IntegrationInstanceIdSchema, enabled: z.boolean() }),
      z.object({ ok: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
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
        /** The kind to test when `id` is null and the provider has several. */
        kind: z.string().min(1).optional(),
      }),
      TestConnectionResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IntegrationInstanceStatus = z.infer<typeof IntegrationInstanceStatusSchema>

export type IIntegrationInstancesProvider = InferProvider<typeof integrationInstancesCapability>

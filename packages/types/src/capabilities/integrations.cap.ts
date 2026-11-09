import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * integrations — system-scoped singleton capability for integration
 * (provider-instance) lifecycle. Integrations are typically per-addon
 * data records that pin a device-provider addon to a concrete config
 * (Reolink credentials, ONVIF endpoint, etc.).
 *
 * Implementation lives in the server's `AddonRegistryService`
 * (specifically `getIntegrationRegistry()`). The provider is registered
 * from `trpc.router.ts` against that service plus the event bus and
 * logger — no addon owns this end-to-end.
 *
 * Phase E of the API consolidation: previously a hand-written core
 * router. Cap conversion lets `useIntegrationsList`,
 * `useIntegrationsTestConnection` and
 * friends flow through the same codegen pipeline as every other cap.
 */

// ── Schemas ─────────────────────────────────────────────────────────

const IntegrationWithStateSchema = z.object({
  id: z.string(),
  addonId: z.string(),
  name: z.string(),
  /** A projection of the instance body's switch (`setInstanceEnabled` is the only writer). */
  enabled: z.boolean(),
  /**
   * True when the addon that holds the switch did not answer (down, failed, or keeps no record for
   * this row): `enabled` is then the stored registry flag, a stale value, not the state. A reader
   * must not draw it as on or off (D315).
   */
  switchUnknown: z.literal(true).optional(),
  info: z.record(z.string(), z.unknown()).readonly(),
  /** The discovery candidate this integration was set up from (D984). */
  originStableId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  processState: z.string(),
})

const IntegrationLiteSchema = z.object({
  id: z.string(),
  addonId: z.string(),
  name: z.string(),
  /** A projection of the instance body's switch (`setInstanceEnabled` is the only writer). */
  enabled: z.boolean(),
  /**
   * True when the addon that holds the switch did not answer (down, failed, or keeps no record for
   * this row): `enabled` is then the stored registry flag, a stale value, not the state. A reader
   * must not draw it as on or off (D315).
   */
  switchUnknown: z.literal(true).optional(),
  info: z.record(z.string(), z.unknown()).readonly(),
  /** The discovery candidate this integration was set up from (D984). */
  originStableId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const AvailableIntegrationTypeSchema = z.object({
  addonId: z.string(),
  name: z.string(),
  description: z.string(),
  iconUrl: z.string().nullable(),
  color: z.string(),
  instanceMode: z.string(),
  /**
   * Integration wizard `mode` (LOCKED MODEL): `standalone` (create
   * immediately then add devices, no config step/button), `account` (config
   * step), or `broker` (broker step). Derived server-side by
   * `getAvailableTypes` when the addon manifest omits an explicit `mode`.
   */
  mode: z.enum(['standalone', 'account', 'broker']),
  discoveryMode: z.string(),
  /**
   * Which integration-marker cap the addon declared, so the wizard can
   * branch on CAP — never on addon name. `device-adoption` integrations
   * (Home Assistant, …) route through the broker step (Approach A);
   * `device-provider` integrations (Reolink/ONVIF) keep the
   * legacy config → discovery flow.
   */
  kind: z.enum(['device-adoption', 'device-provider']),
  /**
   * For `device-adoption` addons: the broker kind to create/link
   * (e.g. `home-assistant`), declared in the addon manifest. `null` for
   * `device-provider` addons, which carry no broker.
   */
  brokerKind: z.string().nullable(),
  /** True when the integration's source system exposes locations the adoption
   *  flow can import (e.g. HA areas). Drives the adopt modal's "import
   *  locations" checkbox. Provider-declared in the addon manifest. */
  supportsLocationImport: z.boolean(),
  /**
   * True when this integration's instances declare a Test (`integration-instances.describe().canTest`,
   * D1016). An integration that cannot be tested must say so up front rather than offering a
   * button that always answers the same nonsense.
   */
  canTest: z.boolean(),
  existingInstances: z.array(z.object({ id: z.string(), name: z.string() })),
  canAdd: z.boolean(),
})

/**
 * Why a test could not be answered as a plain boolean.
 *
 * `success` alone collapsed four different situations into one red box, and the
 * one that mattered most — "nobody ever asked the remote anything" — looked
 * exactly like "the remote said no". The status is the discriminator:
 *
 *   - `validated`    — a provider-declared test ran and the remote ACCEPTED.
 *   - `rejected`     — a provider-declared test ran and the remote REFUSED.
 *                      The only status that blocks `integrationInstances.createInstance`.
 *   - `inconclusive` — a test IS declared but could not complete (timeout,
 *                      DNS, 5xx). Nothing was observed; not a failure.
 *   - `unsupported`  — this integration declares NO test. Nothing was
 *                      observed either; not a failure, and not a pass.
 *
 * `unsupported` and `inconclusive` both carry `success: false` so an older
 * client can never read them as a green tick, and both carry an `error` string
 * that SAYS the test did not run rather than inventing a failure.
 */
const TestConnectionStatusEnum = z.enum(['validated', 'rejected', 'inconclusive', 'unsupported'])

const TestConnectionResultSchema = z.object({
  /** True ONLY for `validated`. Never true for a test that did not run. */
  success: z.boolean(),
  error: z.string().optional(),
  /** Optional for wire back-compat with clients built before the tri-state;
   *  the server always sets it. */
  status: TestConnectionStatusEnum.optional(),
  /** Addon id whose declared test answered — `null` when none did. Lets the UI
   *  attribute a result instead of blaming "the integration". */
  testedBy: z.string().nullable().optional(),
  latencyMs: z.number().nonnegative().optional(),
  /** Human detail from a `validated` result ("3 devices on this account"). */
  detail: z.string().optional(),
})

// ── Method I/O ──────────────────────────────────────────────────────

const UpdateIntegrationInputSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  /**
   * REFUSED, always (a typed `BAD_REQUEST`): the field stays in the schema only so the refusal
   * names the right door. Every integration, a fixed builtin included, is switched through
   * `integration-instances.setInstanceEnabled`.
   */
  enabled: z.boolean().optional(),
  info: z.record(z.string(), z.unknown()).optional(),
})

const DeleteIntegrationResultSchema = z.object({
  success: z.boolean(),
  deletedId: z.string(),
})

export const integrationsCapability = {
  name: 'integrations',
  scope: 'system',
  mode: 'singleton',
  methods: {
    list: method(z.void(), z.array(IntegrationWithStateSchema)),
    get: method(z.object({ id: z.string() }), IntegrationWithStateSchema),
    getByAddonId: method(z.object({ addonId: z.string() }), IntegrationLiteSchema.nullable()),
    update: method(UpdateIntegrationInputSchema, IntegrationLiteSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    delete: method(z.object({ id: z.string() }), DeleteIntegrationResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    getAvailableTypes: method(z.void(), z.array(AvailableIntegrationTypeSchema), { auth: 'admin' }),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/server/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
} as const satisfies CapabilityDefinition

export type IIntegrationsProvider = InferProvider<typeof integrationsCapability>
export type IntegrationTestConnectionStatus = z.infer<typeof TestConnectionStatusEnum>
export type IntegrationTestConnectionResult = z.infer<typeof TestConnectionResultSchema>

export {
  AvailableIntegrationTypeSchema,
  DeleteIntegrationResultSchema,
  IntegrationLiteSchema,
  IntegrationWithStateSchema,
  TestConnectionResultSchema,
  TestConnectionStatusEnum,
  UpdateIntegrationInputSchema,
}

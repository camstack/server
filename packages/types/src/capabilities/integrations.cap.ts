import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'

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
  /** THE switch of the instance: the hub registry row is its only stored copy (D1066). */
  enabled: z.boolean(),
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
  /** THE switch of the instance: the hub registry row is its only stored copy (D1066). */
  enabled: z.boolean(),
  info: z.record(z.string(), z.unknown()).readonly(),
  /** The discovery candidate this integration was set up from (D984). */
  originStableId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const AvailableIntegrationTypeSchema = z.object({
  addonId: z.string(),
  name: z.string(),
  /**
   * Product name a new integration is prefilled from (`<label> - Home`).
   * Absent: the client uses `name`. Set when the catalog title is not the
   * product (Bosch SHC, MQTT).
   */
  providerLabel: z.string().optional(),
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
   * Honoured ONLY for a fixed builtin (`info.fixed`), whose switch is the hub's own registry flag
   * and works while its addon is down. Any other row is refused (a typed `BAD_REQUEST`): its
   * switch is `integration-instances.setInstanceEnabled`.
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
    /** List the integrations with their current state. */
    list: method(z.void(), z.array(IntegrationWithStateSchema)),
    /** Fetch one integration with its state. */
    get: method(z.object({ id: z.string() }), IntegrationWithStateSchema),
    /** The devices-role row of an addon; a services instance row never answers for its addon. */
    getByAddonId: method(z.object({ addonId: z.string() }), IntegrationLiteSchema.nullable()),
    /**
     * Every registry row of one addon, services instances included: the addon reads its own switches
     * with it at boot (D1066). A pure registry read; the Integrations list (`list`) hides the rows of
     * a services instance, this does not.
     */
    listByAddon: method(z.object({ addonId: z.string() }), z.array(IntegrationLiteSchema)),
    /**
     * The one-time move of an addon's switches into the registry (D1066): for each instance record
     * the addon holds, an absent row is created as a services row under the addon-minted id, and a
     * row that disagrees with a STATED body switch is corrected (a body that states nothing never
     * moves an existing row). A row
     * that belongs to another addon is left alone and returned in `conflicts` (the caller keeps its
     * own copy of that state), and an addon naming another addon's id is refused FORBIDDEN.
     * Idempotent: a rerun changes nothing. It never notifies the addon.
     */
    adoptInstanceRows: method(
      z.object({
        addonId: z.string(),
        rows: z.array(
          z.object({
            id: z.string().min(1),
            name: z.string(),
            enabled: z.boolean(),
            /** True when the record body STATED the switch: only then does it override an existing row. */
            stated: z.boolean(),
          }),
        ),
      }),
      z.object({
        created: z.number().int(),
        updated: z.number().int(),
        /** Rows whose id belongs to ANOTHER addon: left untouched, so the caller keeps its own copy. */
        conflicts: z.array(z.object({ id: z.string(), ownerAddonId: z.string() })),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Change an integration's settings. */
    update: method(UpdateIntegrationInputSchema, IntegrationLiteSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /**
     * Delete an integration from the hub side: its devices, its registry row and its record, and
     * announce it. It works while the addon that owns the instance is down (installed but
     * crashed), where `integration-instances.deleteInstance` has no provider to route to; with the
     * provider up the record is removed through it as well. A fixed builtin and an instance a link
     * names are refused first.
     */
    delete: method(z.object({ id: z.string() }), DeleteIntegrationResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** List the integration types that can be added. */
    getAvailableTypes: method(z.void(), z.array(AvailableIntegrationTypeSchema), { auth: 'admin' }),
  },
  /** BIG PLAN 2: declarative mount hint — read by `@camstack/server/system` `buildCapRouters`. */
  mount: { kind: 'server-provided' },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.ADDON_ADMIN },
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

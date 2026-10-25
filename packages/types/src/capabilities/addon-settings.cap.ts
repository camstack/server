import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'

// ── Zod schemas for ConfigUISchemaWithValues ─────────────────────────
//
// Same loose field typing as the addons.router.ts schemas — the
// polymorphic discriminated-union schema would explode to ~14 variants
// with nested group recursion. `z.any()` keeps runtime validation on
// the outer structure while preserving assignability to the domain type.

const ConfigTabDeclarationSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string(),
  order: z.number().optional(),
})

const ConfigSectionWithValuesSchema = z.object({
  id: z.string(),
  title: z.string(),
  titleKey: z.string().optional(),
  description: z.string().optional(),
  descriptionKey: z.string().optional(),
  style: z.enum(['card', 'accordion']).optional(),
  defaultCollapsed: z.boolean().optional(),
  columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  tab: z.string().optional(),
  // Hoist the section into a top-level device tab. DeviceDetail
  // discovers these from the aggregate and renders one tab per unique
  // `tab` id; the default `'settings'` keeps the section under Config.
  location: z.enum(['settings', 'top-tab', 'hero']).optional(),
  order: z.number().optional(),
  fields: z.array(z.any()),
})

const SettingsSchemaWithValuesSchema = z.object({
  tabs: z.array(ConfigTabDeclarationSchema).optional(),
  sections: z.array(ConfigSectionWithValuesSchema),
})

/** Patch object — keys are field names, values are the new field values. */
const SettingsPatchSchema = z.record(z.string(), z.unknown())

/** Standard success response for update operations. */
const SettingsUpdateResultSchema = z.object({
  success: z.literal(true),
})

/**
 * addon-settings — singleton gateway for three-level addon settings.
 *
 * Works like `device-manager`: a single hub-side provider that resolves
 * `addonId` to the target addon and delegates the call. For hub-local
 * addons the call is direct; for remote agents it proxies via the
 * per-addon Moleculer service.
 *
 * Replaces the `$addonHost` Moleculer service. Transport transparency
 * is handled by the provider implementation — callers (admin UI, other
 * addons via `ctx.api`) never know which node hosts the target addon.
 *
 * Three levels:
 *   - **addon**: addon-scoped settings (installation config, API keys, …)
 *   - **global**: settings applied to all devices by default
 *   - **device**: per-device overrides
 *
 * Optional `nodeId` allows explicit node targeting. When absent the
 * provider resolves the addon's host node automatically.
 */
/**
 * `addon-settings` is a **hub-centric** cap: the hub hosts the single
 * provider, and `nodeId` in the input is data for the hub provider's
 * internal dispatcher, not a routing hint for the cap-router. See
 * `CapabilityDefinition.nodeIdMode` for the contract.
 */
export const addonSettingsCapability = {
  name: 'addon-settings',
  scope: 'system',
  mode: 'singleton',
  nodeIdMode: 'data',
  methods: {
    // ── Global-level settings ─────────────────────────────────────────
    //
    // `overlay` — optional preview overlay. When present, the provider
    // hydrates the schema as if the overlay were merged on top of the
    // persisted store (without writing anything). Used by override-mode
    // UIs (benchmark tabs) to get cascade-aware option lists when the
    // operator tweaks an upstream field — e.g. changing engineRuntime
    // from 'python' to 'node' refetches with `overlay: {engineRuntime:
    // 'node'}` so the backend/device dropdowns re-derive.
    getGlobalSettings: method(
      z.object({
        addonId: z.string(),
        nodeId: z.string().optional(),
        overlay: z.record(z.string(), z.unknown()).optional(),
        cap: z.string().optional(),
      }),
      SettingsSchemaWithValuesSchema.nullable(),
    ),
    updateGlobalSettings: method(
      z.object({ addonId: z.string(), nodeId: z.string().optional(), patch: SettingsPatchSchema }),
      SettingsUpdateResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Integration-level settings ────────────────────────────────────
    //
    // The sections an addon declared (`BaseAddon.integrationSettingSections`)
    // as being the configuration of its INTEGRATION, so an operator finds them
    // under System → Integrations → <name> instead of only in the cluster-wide
    // list of every addon. `null` ⇒ the addon declared none; the surface is not
    // offered at all.
    //
    // READ-ONLY BY DESIGN — there is deliberately NO `updateIntegrationSettings`.
    // The payload is a SUBSET of `getGlobalSettings`, so the writer is
    // `updateGlobalSettings` and the store key is the same bare key the addon's
    // own page writes. A second write path is exactly how a surface acquires a
    // second store key (D266's `btmPath@hub`), so the contract omits one rather
    // than documenting that nobody should call it.
    getIntegrationSettings: method(
      z.object({ addonId: z.string(), nodeId: z.string().optional() }),
      SettingsSchemaWithValuesSchema.nullable(),
    ),

    // ── Device-level settings ─────────────────────────────────────────
    getDeviceSettings: method(
      z.object({ addonId: z.string(), deviceId: z.number(), nodeId: z.string().optional() }),
      SettingsSchemaWithValuesSchema.nullable(),
    ),
    updateDeviceSettings: method(
      z.object({
        addonId: z.string(),
        deviceId: z.number(),
        nodeId: z.string().optional(),
        patch: SettingsPatchSchema,
      }),
      SettingsUpdateResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IAddonSettingsProvider = InferProvider<typeof addonSettingsCapability>

export {
  SettingsSchemaWithValuesSchema,
  ConfigSectionWithValuesSchema,
  ConfigTabDeclarationSchema,
  SettingsPatchSchema,
  SettingsUpdateResultSchema,
}

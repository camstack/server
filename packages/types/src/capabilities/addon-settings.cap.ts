import { z } from 'zod'
import { SCOPED_SETTINGS_SCOPES } from '../addon/scoped-settings.js'
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

/** The scope of a scoped-settings call (D986): where the capability declared the values. */
const ScopedSettingsScopeSchema = z.enum(SCOPED_SETTINGS_SCOPES)

/** One scoped schema an addon serves: its capability, scope and section ids. */
const ScopedSettingsDeclarationSchema = z.object({
  cap: z.string(),
  scope: ScopedSettingsScopeSchema,
  sectionIds: z.array(z.string()),
})

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
    // ── Scoped settings (D986 §7) ─────────────────────────────────────
    //
    // One scope of one capability's settings, addressed by `(addonId, cap, scope)`; `nodeId`
    // matters for the `node` scope only (absent: the addon's own node). An addon has no settings of
    // its own: the former addon-level read and write are gone (D986, P10).
    //
    // `getScopedSettings` — the hydrated form, the addon's overlay applied; `null` when the
    // capability declares nothing for the scope. `readScopedValues` — the effective values for
    // another addon or tool, a secret as its `set` view, never its value.
    getScopedSettings: method(
      z.object({
        addonId: z.string(),
        cap: z.string(),
        scope: ScopedSettingsScopeSchema,
        nodeId: z.string().optional(),
      }),
      SettingsSchemaWithValuesSchema.nullable(),
    ),
    // `listScopedSettings` — what the addon actually serves, one entry per loaded (cap, scope)
    // with that schema's section ids. `[]`: it declares nothing. `null`: the addon is not found
    // or not running — unknown, never "none" (D315).
    listScopedSettings: method(
      z.object({ addonId: z.string(), nodeId: z.string().optional() }),
      z.array(ScopedSettingsDeclarationSchema).nullable(),
    ),
    updateScopedSettings: method(
      z.object({
        addonId: z.string(),
        cap: z.string(),
        scope: ScopedSettingsScopeSchema,
        nodeId: z.string().optional(),
        patch: SettingsPatchSchema,
      }),
      SettingsUpdateResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    readScopedValues: method(
      z.object({
        addonId: z.string(),
        cap: z.string(),
        scope: ScopedSettingsScopeSchema,
        nodeId: z.string().optional(),
      }),
      z.record(z.string(), z.unknown()).nullable(),
    ),

    // ── Stale-data audit ──────────────────────────────────────────────
    // The addon answers in ITS OWN process which stored global-settings keys it
    // still declares; the hub keeps no copy. `null` ⇒ the addon did not answer.
    getDeclaredSettingsKeys: method(
      z.object({ addonId: z.string(), nodeId: z.string().optional() }),
      z.object({ keys: z.array(z.string()) }).nullable(),
      { auth: 'admin' },
    ),
    unsetStoredSettingsKeys: method(
      z.object({ addonId: z.string(), nodeId: z.string().optional(), keys: z.array(z.string()) }),
      z.object({
        removed: z.array(z.string()),
        refused: z.array(z.object({ key: z.string(), reason: z.string() })),
        secretsCleared: z.number(),
      }),
      { kind: 'mutation', auth: 'admin' },
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

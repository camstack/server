/**
 * Hub-side singleton provider for the `addon-settings` capability.
 *
 * Resolves `addonId` and delegates the settings call. In-process hub builtins
 * are called directly; every FORKED addon (hub-local child over UDS, or remote
 * agent over Moleculer) routes through the shared {@link AddonCallGateway} —
 * the SAME centralised router routes/custom-actions use. Settings used to live
 * on its own Moleculer-only path here, which is why forked hub-local addons'
 * panels went empty after the UDS migration; that path is gone.
 */
import { z } from 'zod'
import type {
  ICamstackAddon,
  ConfigUISchemaWithValues,
  IntegrationInstanceRef,
} from '@camstack/types'
import type { IAddonSettingsProvider } from '@camstack/types'
import type { AddonSettingsMethod } from '@camstack/system'
import type { AddonCallGateway } from './addon-call-gateway.js'

// ── Dependency interfaces ────────────────────────────────────────────

/** Resolve an addon by id. Returns null if not loaded on this node. */
type AddonLookup = (addonId: string) => ICamstackAddon | null

// ── Input types (match the cap definition's z.infer) ─────────────────

interface AddonIdInput {
  readonly addonId: string
  readonly nodeId?: string
  readonly overlay?: Record<string, unknown>
  readonly cap?: string
}

interface IntegrationFormInput {
  readonly addonId: string
  readonly nodeId?: string
  readonly instance: IntegrationInstanceRef
}

interface AddonPatchInput {
  readonly addonId: string
  readonly nodeId?: string
  readonly patch: Record<string, unknown>
}

interface DeviceGetInput {
  readonly addonId: string
  readonly deviceId: number
  readonly nodeId?: string
}

interface DeviceUpdateInput {
  readonly addonId: string
  readonly deviceId: number
  readonly nodeId?: string
  readonly patch: Record<string, unknown>
}

interface UnsetKeysInput {
  readonly addonId: string
  readonly nodeId?: string
  readonly keys: readonly string[]
}

const DeclaredKeysAnswer = z.object({ keys: z.array(z.string()) })
const UnsetKeysAnswer = z.object({
  removed: z.array(z.string()),
  refused: z.array(z.object({ key: z.string(), reason: z.string() })),
  secretsCleared: z.number(),
})

interface SettingsUpdateResult {
  readonly success: true
}

// ── Reshape helper ───────────────────────────────────────────────────

/**
 * Deep-copy a `ConfigUISchemaWithValues` into mutable-array shape for
 * Zod output. The domain type uses `readonly` arrays; Zod's inferred
 * output uses mutable arrays. Structurally identical at runtime.
 */
interface ReshapedSchema {
  tabs?: Array<{ id: string; label: string; icon: string; order?: number }>
  sections: Array<{
    id: string
    title: string
    description?: string
    style?: 'card' | 'accordion'
    defaultCollapsed?: boolean
    columns?: 1 | 2 | 3 | 4
    tab?: string
    order?: number
    fields: unknown[]
  }>
}

function reshapeForOutput(schema: ConfigUISchemaWithValues): ReshapedSchema {
  return {
    tabs: schema.tabs
      ? schema.tabs.map((t) => ({ id: t.id, label: t.label, icon: t.icon, order: t.order }))
      : undefined,
    sections: schema.sections.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      style: s.style,
      defaultCollapsed: s.defaultCollapsed,
      columns: s.columns,
      tab: s.tab,
      order: s.order,
      fields: [...s.fields],
    })),
  }
}

/**
 * True for Moleculer's `ServiceNotFoundError` — raised when a
 * `<addonId>.settings.*` action is called before the owning forked
 * addon has registered its service (still booting, or wedged in
 * `onInitialize`). Matched by `name` so we don't depend on Moleculer's
 * error class being importable here.
 */
function isServiceNotFoundError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ServiceNotFoundError'
}

// ── Provider factory ─────────────────────────────────────────────────

interface AddonSettingsProviderDeps {
  /** Look up a loaded IN-PROCESS addon by id (the `@camstack/system` builtins). */
  readonly getAddon: AddonLookup
  /** Shared router for forked addon-level calls (hub-local-child / remote). */
  readonly gateway: AddonCallGateway
}

function createAddonSettingsProvider(deps: AddonSettingsProviderDeps): IAddonSettingsProvider {
  const { getAddon, gateway } = deps

  // Forked READ — route through the shared gateway (UDS hub-local-child OR
  // Moleculer remote agent). Degrades to null when the forked addon can't
  // answer yet (mid-boot / missing service) so the panel shows its empty state
  // instead of bubbling a 500.
  async function forkedGet(
    addonId: string,
    method: AddonSettingsMethod,
    args: Record<string, unknown>,
    nodeId?: string,
  ): Promise<ReshapedSchema | null> {
    try {
      const result = await gateway.callForked(addonId, { target: 'settings', method, args }, nodeId)
      return result ? reshapeForOutput(result as ConfigUISchemaWithValues) : null
    } catch (err) {
      if (isServiceNotFoundError(err)) return null
      throw err
    }
  }

  // Forked UPDATE — route through the shared gateway; returns the ack.
  async function forkedUpdate(
    addonId: string,
    method: AddonSettingsMethod,
    args: Record<string, unknown>,
    nodeId?: string,
  ): Promise<SettingsUpdateResult> {
    await gateway.callForked(addonId, { target: 'settings', method, args }, nodeId)
    return { success: true as const }
  }

  // ── Provider implementation ──────────────────────────────────────

  return {
    async getGlobalSettings(input: AddonIdInput) {
      if (gateway.isInProcess(input.addonId, input.nodeId)) {
        const addon = getAddon(input.addonId)
        if (!addon || typeof addon.getGlobalSettings !== 'function') return null
        // Pass the REQUESTED nodeId so an addon serving a cluster-central,
        // per-node config (the store is hub-resident) can scope to that node —
        // the hub addon answers for every node, so it must not assume "self".
        const result = await addon.getGlobalSettings(input.overlay, input.cap, input.nodeId)
        return result ? reshapeForOutput(result) : null
      }
      return forkedGet(
        input.addonId,
        'getGlobalSettings',
        {
          ...(input.overlay ? { overlay: input.overlay } : {}),
          ...(input.cap ? { cap: input.cap } : {}),
          ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        },
        input.nodeId,
      )
    },

    async updateGlobalSettings(input: AddonPatchInput) {
      if (gateway.isInProcess(input.addonId, input.nodeId)) {
        const addon = getAddon(input.addonId)
        if (!addon || typeof addon.updateGlobalSettings !== 'function') {
          throw new Error(`Addon "${input.addonId}" does not implement updateGlobalSettings`)
        }
        // The admin API's write is the OPERATOR's (D787).
        if (typeof addon.updateGlobalSettingsAsOperator === 'function') {
          await addon.updateGlobalSettingsAsOperator(input.patch, input.nodeId)
        } else {
          await addon.updateGlobalSettings(input.patch, input.nodeId)
        }
        return { success: true as const }
      }
      return forkedUpdate(
        input.addonId,
        'updateGlobalSettings',
        { patch: input.patch, ...(input.nodeId ? { nodeId: input.nodeId } : {}) },
        input.nodeId,
      )
    },

    async getIntegrationSettings(input: AddonIdInput) {
      if (gateway.isInProcess(input.addonId, input.nodeId)) {
        const addon = getAddon(input.addonId)
        if (!addon || typeof addon.getIntegrationSettings !== 'function') return null
        const result = await addon.getIntegrationSettings(input.nodeId)
        return result ? reshapeForOutput(result) : null
      }
      return forkedGet(
        input.addonId,
        'getIntegrationSettings',
        { ...(input.nodeId ? { nodeId: input.nodeId } : {}) },
        input.nodeId,
      )
    },

    async getIntegrationFormSchema(input: IntegrationFormInput) {
      if (gateway.isInProcess(input.addonId, input.nodeId)) {
        const addon = getAddon(input.addonId)
        if (!addon) return null
        // The per-instance hook when the addon has one; its global schema otherwise (what the
        // wizard and the edit page always showed).
        const result =
          typeof addon.getIntegrationFormSchema === 'function'
            ? await addon.getIntegrationFormSchema(input.instance, input.nodeId)
            : typeof addon.getGlobalSettings === 'function'
              ? await addon.getGlobalSettings(undefined, undefined, input.nodeId)
              : null
        return result ? reshapeForOutput(result) : null
      }
      return forkedGet(
        input.addonId,
        'getIntegrationFormSchema',
        { instance: input.instance, ...(input.nodeId ? { nodeId: input.nodeId } : {}) },
        input.nodeId,
      )
    },

    async getDeclaredSettingsKeys(input: AddonIdInput) {
      try {
        if (gateway.isInProcess(input.addonId, input.nodeId)) {
          const addon = getAddon(input.addonId)
          if (!addon || typeof addon.getDeclaredSettingsKeys !== 'function') return null
          const answer = await addon.getDeclaredSettingsKeys()
          return { keys: [...answer.keys] }
        }
        const raw = await gateway.callForked(
          input.addonId,
          { target: 'settings', method: 'getDeclaredSettingsKeys', args: {} },
          input.nodeId,
        )
        const parsed = DeclaredKeysAnswer.safeParse(raw)
        return parsed.success ? parsed.data : null
      } catch (err) {
        // An addon that does not answer is `unknown` to the audit, never stale.
        if (isServiceNotFoundError(err)) return null
        throw err
      }
    },

    async unsetStoredSettingsKeys(input: UnsetKeysInput) {
      if (gateway.isInProcess(input.addonId, input.nodeId)) {
        const addon = getAddon(input.addonId)
        if (!addon || typeof addon.unsetStoredSettingsKeys !== 'function') {
          throw new Error(`Addon "${input.addonId}" does not implement unsetStoredSettingsKeys`)
        }
        const outcome = await addon.unsetStoredSettingsKeys(input.keys)
        return {
          removed: [...outcome.removed],
          refused: outcome.refused.map((r) => ({ key: r.key, reason: r.reason })),
          secretsCleared: outcome.secretsCleared,
        }
      }
      const raw = await gateway.callForked(
        input.addonId,
        { target: 'settings', method: 'unsetStoredSettingsKeys', args: { keys: input.keys } },
        input.nodeId,
      )
      return UnsetKeysAnswer.parse(raw)
    },

    async getDeviceSettings(input: DeviceGetInput) {
      if (gateway.isInProcess(input.addonId, input.nodeId)) {
        const addon = getAddon(input.addonId)
        if (!addon || typeof addon.getDeviceSettings !== 'function') return null
        const result = await addon.getDeviceSettings(input.deviceId)
        return result ? reshapeForOutput(result) : null
      }
      return forkedGet(
        input.addonId,
        'getDeviceSettings',
        { deviceId: input.deviceId },
        input.nodeId,
      )
    },

    async updateDeviceSettings(input: DeviceUpdateInput) {
      if (gateway.isInProcess(input.addonId, input.nodeId)) {
        const addon = getAddon(input.addonId)
        if (!addon || typeof addon.updateDeviceSettings !== 'function') {
          throw new Error(`Addon "${input.addonId}" does not implement updateDeviceSettings`)
        }
        await addon.updateDeviceSettings(input.deviceId, input.patch)
        return { success: true as const }
      }
      return forkedUpdate(
        input.addonId,
        'updateDeviceSettings',
        { deviceId: input.deviceId, patch: input.patch },
        input.nodeId,
      )
    },
  }
}

export { createAddonSettingsProvider }
export type { AddonSettingsProviderDeps }

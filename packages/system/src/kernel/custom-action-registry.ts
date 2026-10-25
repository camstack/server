import type {
  ChildCustomActionCatalogs,
  CustomActionCaller,
  CustomActionCatalogDescriptor,
  CustomActionSpec,
  CustomActionsSpec,
} from '@camstack/types'
// The VALUE comes from the light subpath, not the barrel: this module is in the
// addon-runner closure, and a runtime import of the root barrel builds the whole
// schema graph in every forked runner (D28).
import { describeCustomActions } from '@camstack/types/addon'

type Handler = (action: string, input: unknown, caller?: CustomActionCaller) => Promise<unknown>

export interface CustomActionEntry {
  readonly spec: CustomActionSpec
  readonly handler: (input: unknown, caller?: CustomActionCaller) => Promise<unknown>
}

/**
 * CustomActionRegistry — per-process registry of addon custom actions.
 *
 * Populated at boot from each addon's `AddonInitResult.customActions` +
 * `handleCustomAction` handler. Rejects actions declared with scope other
 * than 'system' (today only 'system' is runtime-supported; the descriptor
 * allows future scopes for forward compat).
 */
export class CustomActionRegistry {
  private readonly byAddon = new Map<string, Map<string, CustomActionEntry>>()

  registerAddon(addonId: string, catalog: CustomActionsSpec, handler: Handler): void {
    const actions = new Map<string, CustomActionEntry>()
    for (const [name, spec] of Object.entries(catalog)) {
      const scope = spec.scope ?? { kind: 'system' as const }
      if (scope.kind !== 'system') {
        throw new Error(
          `custom action '${addonId}.${name}' declared scope '${scope.kind}' — not yet implemented`,
        )
      }
      actions.set(name, {
        spec,
        handler: (input: unknown, caller?: CustomActionCaller) => handler(name, input, caller),
      })
    }
    this.byAddon.set(addonId, actions)
  }

  unregisterAddon(addonId: string): void {
    this.byAddon.delete(addonId)
  }

  resolve(addonId: string, action: string): CustomActionEntry | null {
    return this.byAddon.get(addonId)?.get(action) ?? null
  }

  listActions(addonId: string): readonly string[] {
    return [...(this.byAddon.get(addonId)?.keys() ?? [])]
  }

  listAddons(): readonly string[] {
    return [...this.byAddon.keys()]
  }

  /**
   * Every registered catalog with its schemas stripped, keyed by addon id —
   * what a runner puts in its register frame so the hub learns the catalogs
   * from the process that owns them (D444). `hostedAddonIds` are the addons
   * this runner hosts: each is present in the result, with an EMPTY catalog
   * when it registered none, so the parent can say "declares no actions" per
   * addon instead of guessing from an absent key.
   */
  describeAll(hostedAddonIds: readonly string[]): ChildCustomActionCatalogs {
    const out: Record<string, CustomActionCatalogDescriptor> = {}
    for (const addonId of hostedAddonIds) out[addonId] = {}
    for (const [addonId, actions] of this.byAddon) {
      const catalog: Record<string, CustomActionSpec> = {}
      for (const [name, entry] of actions) catalog[name] = entry.spec
      out[addonId] = describeCustomActions(catalog)
    }
    return out
  }
}

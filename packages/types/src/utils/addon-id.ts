/**
 * The addon id as the REGISTRY, the wire and the durable stores spell it.
 *
 * `AddonContext.id` does not agree with itself across the two context
 * factories:
 *
 *   - a FORKED addon gets the bare manifest id
 *     (`kernel/moleculer/addon-context-factory.ts` → `id: addonId`);
 *   - an addon co-located in hub-main gets it PREFIXED
 *     (`server/backend/src/core/addon/addon-registry.service.ts` →
 *      ``id: `addon:${addonId}` ``).
 *
 * Everything an addon might compare `ctx.id` AGAINST carries the bare form:
 * `DeviceBindingEntry.providerAddonId`, the `device-manager` bindings store's
 * `wrapperAddonId`, `CapabilityRegistry` provider keys, manifest ids.
 *
 * So `entry.providerAddonId === this.ctx.id` is silently, permanently false
 * for a builtin — and only for a builtin, which is why it survives a green
 * suite whose fake supplies the bare id. That is exactly how camera 101's
 * virtual doorbell (retired since, D671) latched `unbound` for twelve hours on
 * 2026-08-07 while its binding was intact ([D72](../../../../docs/decisions/adr-0072.md)).
 *
 * Route every comparison between `ctx.id` and a registry/store addon id
 * through {@link isSameAddonId}. `scripts/check-addon-id-comparison.ts`
 * enforces it in the processes where the prefix exists.
 */

/** The prefix the hub-main context factory prepends to the manifest id. */
const ADDON_ID_PREFIX = 'addon:'

/** The manifest id, whichever spelling of `ctx.id` you were handed. */
export function bareAddonId(id: string): string {
  return id.startsWith(ADDON_ID_PREFIX) ? id.slice(ADDON_ID_PREFIX.length) : id
}

/** True when both ids name the same addon, prefixed or not. */
export function isSameAddonId(a: string, b: string): boolean {
  return bareAddonId(a) === bareAddonId(b)
}
